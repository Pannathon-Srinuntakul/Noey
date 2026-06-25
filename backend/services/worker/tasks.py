"""arq task definitions and WorkerSettings.

All heavy operations (CSV export/import, AI processing, summary rebuild) run here
so the API request returns immediately with a job_id, and the frontend polls for status.

Job lifecycle:
  1. API enqueues via arq_pool.enqueue_job(fn_name, *args)  → returns job_id
  2. Worker picks up, updates core.jobs row status=running
  3. On completion/error, updates core.jobs row status=ok/error + result/error fields
  4. Frontend GET /jobs/{job_id} polls until done
"""

from __future__ import annotations

import csv
import io
import json
import pathlib
import shutil
import time
import zipfile
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from packages.core.logging import get_logger
from packages.db.models.core_auth import Job
from packages.db.session import bind_tenant_search_path, get_engine, get_sessionmaker
from packages.video.storage import data_root
from packages.video.ffmpeg_bin import configure_ffmpeg, has_audio_stream, media_duration, probe_media, run_ffmpeg, trim_media, video_stream_info
from packages.video.timeline import (
    AI_SEMANTIC_DEDUPE_SYSTEM,
    EDITORIAL_BLOCK_GAP,
    HIGHLIGHT_HAIKU_SYSTEM,
    normalize_dub_edit_script,
    apply_semantic_dedupe_plan,
    remove_overlapping_cuts,
    build_captions_for_cuts,
    build_clip_boundaries,
    build_speech_blocks,
    build_speech_cuts,
    cut_duration,
    cuts_duration,
    dedupe_repeated_cuts,
    dedupe_spaced_word_repeats,
    enforce_cuts_budget,
    filter_renderable_cuts,
    filter_short_cuts,
    localize_cuts,
    parse_llm_json,
    select_speech_cuts_by_ids,
    resnap_selected_cuts,
    split_cuts_on_internal_silence,
    strip_filler_cuts,
    strip_filler_words_from_cuts,
    trim_speech_cuts_to_budget,
    whisper_segments_for_cut,
    _text_for_cut,
)

log = get_logger(__name__)

# ── context helpers ───────────────────────────────────────────────────────────


async def _core_session() -> AsyncSession:
    """Session with core schema search_path for job status updates."""
    maker = get_sessionmaker()
    session = maker()
    await session.execute(text("SET search_path TO core, public"))
    return session


async def _tenant_session(tenant_slug: str) -> AsyncSession:
    maker = get_sessionmaker()
    session = maker()
    await bind_tenant_search_path(session, tenant_slug)
    return session


async def _update_job(job_id: str, status: str, progress: int = 0, result: dict | None = None, error: str | None = None) -> None:
    session = await _core_session()
    try:
        job = (await session.execute(select(Job).where(Job.id == job_id))).scalar_one_or_none()
        if job:
            job.status = status
            job.progress = progress
            if result is not None:
                job.result = result
            if error is not None:
                job.error = error[:512]
            await session.commit()
    finally:
        await session.close()


# ── task: CSV export ──────────────────────────────────────────────────────────


async def csv_export(ctx: dict[str, Any], *, job_id: str, tenant_slug: str, table_id: int, row_ids: list[int] | None = None) -> dict:
    """Export table to CSV. Returns {csv_data: str, filename: str}."""
    await _update_job(job_id, "running", 10)
    session = await _tenant_session(tenant_slug)
    try:
        from sqlalchemy import select as sa_select
        from packages.db.models.custom_table import CustomTableMeta

        meta = (await session.execute(
            sa_select(CustomTableMeta).where(CustomTableMeta.id == table_id)
        )).scalar_one_or_none()
        if meta is None:
            raise ValueError(f"table {table_id} not found")

        pg = meta.pg_table_name
        await _update_job(job_id, "running", 30)

        if row_ids:
            rows = (await session.execute(
                text(f'SELECT * FROM "{pg}" WHERE id = ANY(:ids) ORDER BY id'),
                {"ids": row_ids},
            )).mappings().all()
        else:
            rows = (await session.execute(text(f'SELECT * FROM "{pg}" ORDER BY id'))).mappings().all()

        await _update_job(job_id, "running", 70)
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow([c["label"] for c in meta.columns])
        for row in rows:
            writer.writerow([row.get(c["key"], "") for c in meta.columns])

        result = {"csv_data": buf.getvalue(), "filename": f"{meta.display_name}.csv", "row_count": len(rows)}
        await _update_job(job_id, "ok", 100, result={"filename": result["filename"], "row_count": result["row_count"]})
        await session.commit()
        return result
    except Exception as exc:
        await _update_job(job_id, "error", 0, error=str(exc))
        raise
    finally:
        await session.close()


# ── task: CSV import ──────────────────────────────────────────────────────────


async def csv_import(ctx: dict[str, Any], *, job_id: str, tenant_slug: str, table_id: int, csv_data: str) -> dict:
    """Import CSV rows into a table. Returns {rows_inserted, rows_skipped, errors}."""
    await _update_job(job_id, "running", 5)
    session = await _tenant_session(tenant_slug)
    try:
        from packages.db.models.custom_table import CustomTableMeta
        from sqlalchemy import select as sa_select
        from decimal import Decimal
        from datetime import date, datetime as dt

        meta = (await session.execute(
            sa_select(CustomTableMeta).where(CustomTableMeta.id == table_id)
        )).scalar_one_or_none()
        if meta is None:
            raise ValueError(f"table {table_id} not found")

        pg = meta.pg_table_name
        label_to_col = {c["label"]: c for c in meta.columns if c.get("ui_type") != "formula"}

        reader = csv.DictReader(io.StringIO(csv_data))
        header_map = {h: label_to_col[h] for h in (reader.fieldnames or []) if h in label_to_col}
        if not header_map:
            raise ValueError("No matching columns in CSV")

        all_rows = list(reader)
        total = len(all_rows)
        inserted = 0
        skipped = 0
        errors: list[str] = []

        UI_COERCE: dict = {
            "number": lambda v: Decimal(v) if v else None,
            "date": lambda v: date.fromisoformat(v) if v else None,
            "datetime": lambda v: dt.fromisoformat(v) if v else None,
            "boolean": lambda v: v.lower() in ("true", "1", "yes", "ใช่") if v else None,
            "multi_select": lambda v: [x.strip() for x in v.split(",")] if v else [],
        }

        for i, csv_row in enumerate(all_rows):
            await _update_job(job_id, "running", int(10 + 80 * i / max(total, 1)))
            try:
                params: dict[str, Any] = {}
                for h, col in header_map.items():
                    v = (csv_row.get(h) or "").strip()
                    coerce = UI_COERCE.get(col["ui_type"])
                    params[col["key"]] = coerce(v) if (coerce and v) else (v or None)

                cols_ins = [c for c in header_map.values() if params.get(c["key"]) is not None]
                if not cols_ins:
                    skipped += 1
                    continue

                collist = ", ".join(f'"{c["key"]}"' for c in cols_ins)
                vallist = ", ".join(f":{c['key']}" for c in cols_ins)
                await session.execute(text(f'INSERT INTO "{pg}" ({collist}) VALUES ({vallist})'), params)
                inserted += 1
            except Exception as exc:
                errors.append(f"แถว {i+2}: {exc}")
                skipped += 1
                await session.rollback()

        await session.commit()
        result = {"rows_inserted": inserted, "rows_skipped": skipped, "errors": errors[:20]}
        await _update_job(job_id, "ok", 100, result=result)
        return result
    except Exception as exc:
        await _update_job(job_id, "error", 0, error=str(exc))
        raise
    finally:
        await session.close()


# ── video helpers ─────────────────────────────────────────────────────────────

async def _get_video_project(session: AsyncSession, uid: str):  # type: ignore[return]
    from sqlalchemy import select as _sel
    from packages.db.models.video_project import VideoProject
    return (await session.execute(_sel(VideoProject).where(VideoProject.uid == uid))).scalar_one_or_none()


async def _update_video(session: AsyncSession, uid: str, **kwargs: Any) -> None:
    proj = await _get_video_project(session, uid)
    if proj is None:
        return  # project deleted — skip update
    for k, v in kwargs.items():
        setattr(proj, k, v)
    await session.commit()


async def _video_progress(
    job_id: str,
    progress: int,
    step: str,
    message: str,
    *,
    status: str = "running",
) -> None:
    """Update job progress with a human-readable step + message for the UI."""
    await _update_job(
        job_id,
        status,
        progress,
        result={"step": step, "message": message},
    )


async def _abort_if_cancelled(session: AsyncSession, project_uid: str, job_id: str) -> bool:
    """Return True if the project was cancelled or deleted — updates job row for the UI."""
    proj = await _get_video_project(session, project_uid)
    if proj is None:
        return True  # project deleted — abort silently
    if proj.status != "cancelled":
        return False
    await _update_job(
        job_id,
        "error",
        0,
        result={"step": "cancelled", "message": "ยกเลิกโดยผู้ใช้"},
        error="cancelled by user",
    )
    log.info("video_job_cancelled", project_uid=project_uid, job_id=job_id)
    return True


# ── task: AI processing ───────────────────────────────────────────────────────


async def ai_process(ctx: dict[str, Any], *, job_id: str, prompt: str) -> dict:
    """Run an AI prompt in the background. Returns {answer: str}."""
    await _update_job(job_id, "running", 10)
    try:
        from packages.llm.gateway import complete
        answer = await complete(prompt)
        result = {"answer": answer}
        await _update_job(job_id, "ok", 100, result=result)
        return result
    except Exception as exc:
        await _update_job(job_id, "error", 0, error=str(exc))
        raise


# ── task: ingest_video ────────────────────────────────────────────────────────


async def ingest_video(ctx: dict[str, Any], *, job_id: str, project_uid: str, tenant_slug: str) -> dict:
    """Copy uploaded clips as-is and extract mono WAV for transcription."""
    log.info("task_start", task="ingest_video", project_uid=project_uid)
    await _video_progress(job_id, 5, "ingest", "กำลังเตรียมวิดีโอ…")
    session = await _tenant_session(tenant_slug)
    try:
        import ffmpeg as ffmpeg_lib

        if await _abort_if_cancelled(session, project_uid, job_id):
            return {"cancelled": True}

        from packages.video.s3 import pull_uploads

        root = data_root()
        output_dir = root / "video_outputs" / project_uid
        output_dir.mkdir(parents=True, exist_ok=True)
        norm_dir = output_dir / "normalized"
        norm_dir.mkdir(exist_ok=True)
        audio_dir = output_dir / "audio"
        audio_dir.mkdir(exist_ok=True)

        proj = await _get_video_project(session, project_uid)
        source_files: list[str] = proj.source_files or []
        if not source_files:
            raise ValueError("No source files found in project")

        # Pull uploads from S3 if enabled (no-op on local)
        upload_dir_path = root / "video_uploads" / project_uid
        await pull_uploads(project_uid, upload_dir_path)

        (output_dir / "upload_sources.json").write_text(
            json.dumps(source_files, ensure_ascii=False),
            encoding="utf-8",
        )

        norm_paths: list[str] = []
        total = len(source_files)
        for i, rel_path in enumerate(source_files):
            if await _abort_if_cancelled(session, project_uid, job_id):
                return {"cancelled": True}
            src = root / rel_path
            norm_out = norm_dir / f"norm_{i:03d}.mp4"
            audio_out = audio_dir / f"audio_{i:03d}.wav"

            await _video_progress(
                job_id,
                int(5 + 40 * i / total),
                "ingest",
                f"กำลังเตรียมคลิป {i + 1}/{total}…",
            )
            log.info("ingest_prepare", clip=str(src), out=str(norm_out))

            proj_for_mode = await _get_video_project(session, project_uid)
            is_dub_first = (proj_for_mode.mode == "dub_first")

            if not is_dub_first and not has_audio_stream(src):
                raise ValueError(
                    f"คลิป {i + 1}/{total} ไม่มีเสียง — โหมด talking head ต้องมีเสียงพูดในวิดีโอ"
                )

            # Keep original video untouched (resolution, orientation, fps, codec)
            shutil.copy2(src, norm_out)
            norm_paths.append(str(norm_out.relative_to(root)))

            # Extract mono 16 kHz WAV + loudnorm for faster-whisper (talking_head only)
            # loudnorm boosts quiet speech so VAD can detect it under BGM
            if not is_dub_first:
                run_ffmpeg(
                    ffmpeg_lib
                    .input(str(src))
                    .output(
                        str(audio_out),
                        ac=1, ar=16000, acodec="pcm_s16le", f="wav",
                        af="loudnorm=I=-16:TP=-1.5:LRA=11",
                    )
                    .overwrite_output(),
                    label="ingest_extract_audio",
                )

        await _update_video(session, project_uid,
                            status="processing",
                            source_files=norm_paths)
        log.info("ingest_done", project_uid=project_uid, clips=len(norm_paths))

        if await _abort_if_cancelled(session, project_uid, job_id):
            return {"cancelled": True}

        # Branch: dub_first skips Whisper, goes to scene analysis instead
        proj = await _get_video_project(session, project_uid)
        mode = proj.mode or "talking_head"

        from arq import create_pool
        from arq.connections import RedisSettings
        from packages.core.settings import get_settings
        settings = get_settings()
        pool = await create_pool(RedisSettings.from_dsn(settings.redis_url))
        if mode == "dub_first":
            await _video_progress(job_id, 50, "ingest", "เตรียมวิดีโอเสร็จแล้ว กำลังวิเคราะห์ซีน…")
            await pool.enqueue_job("analyze_dub_first", job_id=job_id, project_uid=project_uid, tenant_slug=tenant_slug)
            await pool.close()
        else:
            await pool.close()
            await _video_progress(job_id, 50, "ingest", "เตรียมวิดีโอเสร็จแล้ว กำลังถอดเสียง…")
            # Call transcribe directly (no separate whisper worker needed when using Modal)
            await transcribe_video(ctx, job_id=job_id, project_uid=project_uid, tenant_slug=tenant_slug)

        return {"normalized": len(norm_paths)}
    except Exception as exc:
        ts = await _tenant_session(tenant_slug)
        try:
            if await _abort_if_cancelled(ts, project_uid, job_id):
                return {"cancelled": True}
            await _update_video(ts, project_uid, status="error", error_msg=str(exc))
        finally:
            await ts.close()
        await _update_job(
            job_id, "error", 0,
            result={"step": "error", "message": str(exc)},
            error=str(exc),
        )
        raise
    finally:
        await session.close()


# ── task: transcribe_video ────────────────────────────────────────────────────

# Modal web endpoints async-poll via 303 on long jobs; chunk very long WAVs.
MODAL_CHUNK_SEC = 900.0       # 15 min per request
MODAL_CHUNK_WHEN_SEC = 900.0    # chunk when source audio longer than this
MODAL_CHUNK_WHEN_MB = 80.0      # or when WAV exceeds this size


async def _transcribe_modal_request(
    audio_bytes: bytes,
    modal_url: str,
    language: str,
    *,
    clip_sec: float,
) -> dict[str, Any]:
    """POST audio to Modal; poll async 303 redirect until transcript JSON is ready."""
    import asyncio
    import base64
    import httpx

    size_mb = len(audio_bytes) / 1024 / 1024
    read_timeout = max(600.0, clip_sec * 2.5 + 300.0)
    write_timeout = max(300.0, size_mb * 4.0)
    timeout = httpx.Timeout(connect=120.0, read=read_timeout, write=write_timeout, pool=60.0)
    payload = {"audio_b64": base64.b64encode(audio_bytes).decode(), "language": language}

    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        resp = await client.post(modal_url, json=payload)

        # Short jobs: 200 JSON immediately. Long jobs: 303 → poll until done.
        if resp.status_code in {301, 302, 303, 307, 308}:
            poll_url = resp.headers.get("location")
            if not poll_url:
                resp.raise_for_status()
            if not poll_url.startswith(("http://", "https://")):
                poll_url = str(httpx.URL(modal_url).join(poll_url))
            deadline = time.monotonic() + read_timeout
            while time.monotonic() < deadline:
                poll = await client.get(poll_url)
                if poll.status_code == 200:
                    return poll.json()
                if poll.status_code in {301, 302, 303, 307, 308}:
                    nxt = poll.headers.get("location")
                    if nxt:
                        poll_url = str(httpx.URL(poll_url).join(nxt))
                    await asyncio.sleep(1.5)
                    continue
                if poll.status_code in {202, 204}:
                    await asyncio.sleep(2.0)
                    continue
                poll.raise_for_status()
            raise TimeoutError(f"Modal transcribe poll timed out after {read_timeout:.0f}s")

        resp.raise_for_status()
        return resp.json()


def _offset_modal_segments(segments: list[dict[str, Any]], offset_sec: float) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for seg in segments:
        words = [
            {
                "word": w["word"],
                "start": round(float(w["start"]) + offset_sec, 3),
                "end": round(float(w["end"]) + offset_sec, 3),
            }
            for w in (seg.get("words") or [])
        ]
        out.append({
            "start": round(float(seg["start"]) + offset_sec, 3),
            "end": round(float(seg["end"]) + offset_sec, 3),
            "text": str(seg.get("text", "")).strip(),
            "words": words,
        })
    return out


async def _transcribe_via_modal(
    wav_path: pathlib.Path,
    modal_url: str,
    language: str,
) -> list[dict[str, Any]]:
    """Send WAV to Modal GPU endpoint; chunk long audio to avoid huge payloads + 303 timeouts."""
    import ffmpeg as ffmpeg_lib

    duration = media_duration(wav_path)
    size_mb = wav_path.stat().st_size / 1024 / 1024
    log.info(
        "modal_transcribe_start",
        wav=wav_path.name,
        size_mb=round(size_mb, 2),
        duration_sec=round(duration, 1),
    )

    need_chunk = duration > MODAL_CHUNK_WHEN_SEC or size_mb > MODAL_CHUNK_WHEN_MB
    if not need_chunk:
        data = await _transcribe_modal_request(
            wav_path.read_bytes(), modal_url, language, clip_sec=duration,
        )
        segments = data.get("segments", [])
        log.info("modal_transcribe_done", wav=wav_path.name, segments=len(segments), dropped=data.get("dropped", 0))
        return segments

    all_segments: list[dict[str, Any]] = []
    dropped_total = 0
    offset = 0.0
    chunk_i = 0
    while offset < duration - 0.05:
        chunk_dur = min(MODAL_CHUNK_SEC, duration - offset)
        chunk_path = wav_path.parent / f"_modal_chunk_{wav_path.stem}_{chunk_i:03d}.wav"
        try:
            run_ffmpeg(
                ffmpeg_lib
                .input(str(wav_path), ss=offset, t=chunk_dur)
                .output(str(chunk_path), ac=1, ar=16000, acodec="pcm_s16le", f="wav")
                .overwrite_output(),
                label="modal_chunk_wav",
            )
            chunk_bytes = chunk_path.read_bytes()
            log.info(
                "modal_transcribe_chunk",
                wav=wav_path.name,
                chunk=chunk_i + 1,
                offset_sec=round(offset, 1),
                chunk_sec=round(chunk_dur, 1),
                size_mb=round(len(chunk_bytes) / 1024 / 1024, 2),
            )
            data = await _transcribe_modal_request(
                chunk_bytes, modal_url, language, clip_sec=chunk_dur,
            )
            dropped_total += int(data.get("dropped", 0))
            all_segments.extend(_offset_modal_segments(data.get("segments", []), offset))
        finally:
            chunk_path.unlink(missing_ok=True)
        offset += chunk_dur
        chunk_i += 1

    log.info(
        "modal_transcribe_done",
        wav=wav_path.name,
        segments=len(all_segments),
        dropped=dropped_total,
        chunks=chunk_i,
    )
    return all_segments


async def transcribe_video(ctx: dict[str, Any], *, job_id: str, project_uid: str, tenant_slug: str) -> dict:
    """Transcribe audio — uses Modal GPU endpoint if configured, else local faster-whisper."""
    log.info("task_start", task="transcribe_video", project_uid=project_uid)
    await _video_progress(job_id, 60, "transcribe", "กำลังโหลดโมเดล Whisper…")
    session = await _tenant_session(tenant_slug)
    try:
        from packages.core.settings import get_settings as _get_settings
        from packages.video.transcribe import (
            build_transcribe_options,
            is_hallucinated_segment,
            should_retry_transcription_without_vad,
            tighten_segment_bounds,
            transcript_coverage_stats,
        )

        if await _abort_if_cancelled(session, project_uid, job_id):
            return {"cancelled": True}

        root = data_root()
        output_dir = root / "video_outputs" / project_uid
        audio_dir = output_dir / "audio"

        audio_files = sorted(audio_dir.glob("audio_*.wav"))
        if not audio_files:
            raise ValueError("No audio files to transcribe")

        _s = _get_settings()
        use_modal = bool(_s.modal_whisper_url)

        if use_modal:
            log.info("whisper_config", backend="modal", url=_s.modal_whisper_url, language=_s.whisper_language)
        else:
            from faster_whisper import WhisperModel  # type: ignore[import-untyped]
            model = WhisperModel(_s.whisper_model, device=_s.whisper_device, compute_type=_s.whisper_compute)
            log.info("whisper_config", backend="local", model=_s.whisper_model, device=_s.whisper_device,
                     language=_s.whisper_language or "auto")

        async def _collect_segments_modal() -> tuple[list[dict[str, Any]], int, float]:
            """Collect segments via Modal GPU endpoint."""
            collected: list[dict[str, Any]] = []
            offset = 0.0
            for idx, wav in enumerate(audio_files):
                if await _abort_if_cancelled(session, project_uid, job_id):
                    return collected, 0, offset
                await _video_progress(
                    job_id,
                    int(60 + 15 * idx / max(len(audio_files), 1)),
                    "transcribe",
                    f"กำลังถอดเสียงคลิป {idx + 1}/{len(audio_files)}…",
                )
                segs = await _transcribe_via_modal(wav, _s.modal_whisper_url, _s.whisper_language)
                clip_dur = media_duration(wav)
                for seg in segs:
                    tight = tighten_segment_bounds({
                        "start": float(seg["start"]),
                        "end": float(seg["end"]),
                        "text": str(seg.get("text", "")).strip(),
                        "words": seg.get("words", []),
                    })
                    collected.append({
                        "start": round(tight["start"] + offset, 3),
                        "end": round(tight["end"] + offset, 3),
                        "text": tight["text"],
                        "words": [
                            {"word": w["word"],
                             "start": round(float(w["start"]) + offset, 3),
                             "end": round(float(w["end"]) + offset, 3)}
                            for w in tight.get("words", [])
                        ],
                    })
                offset += clip_dur
            return collected, 0, offset

        async def _collect_segments(
            transcribe_options: dict[str, Any],
            *,
            pass_label: str,
        ) -> tuple[list[dict[str, Any]], int, float]:
            collected: list[dict[str, Any]] = []
            dropped_count = 0
            offset = 0.0
            for idx, wav in enumerate(audio_files):
                if await _abort_if_cancelled(session, project_uid, job_id):
                    return collected, dropped_count, offset
                await _video_progress(
                    job_id,
                    int(60 + 8 * idx / max(len(audio_files), 1)),
                    "transcribe",
                    f"กำลังถอดเสียงคลิป {idx + 1}/{len(audio_files)}…",
                )
                log.info(
                    "transcribe_clip_start",
                    wav=wav.name,
                    clip=idx + 1,
                    total=len(audio_files),
                    transcribe_pass=pass_label,
                )
                t_wav = time.monotonic()
                segs, info = model.transcribe(str(wav), **transcribe_options)
                raw_count = 0
                for seg in segs:
                    if is_hallucinated_segment(
                        seg.text or "",
                        no_speech_prob=getattr(seg, "no_speech_prob", 0.0),
                        avg_logprob=getattr(seg, "avg_logprob", 0.0),
                        compression_ratio=getattr(seg, "compression_ratio", 0.0),
                        log=log,
                    ):
                        dropped_count += 1
                        continue
                    tight = tighten_segment_bounds({
                        "start": seg.start,
                        "end": seg.end,
                        "text": seg.text.strip(),
                        "words": [
                            {"word": w.word, "start": w.start, "end": w.end}
                            for w in (seg.words or [])
                        ],
                    })
                    collected.append({
                        "start": round(tight["start"] + offset, 3),
                        "end": round(tight["end"] + offset, 3),
                        "text": tight["text"],
                        "words": [
                            {"word": w["word"], "start": round(w["start"] + offset, 3),
                             "end": round(w["end"] + offset, 3)}
                            for w in tight["words"]
                        ],
                    })
                    raw_count += 1
                clip_dur = media_duration(wav)
                log.info(
                    "transcribe_clip_done",
                    clip=idx + 1,
                    wav=wav.name,
                    segments_kept=raw_count,
                    language=getattr(info, "language", "?"),
                    language_prob=round(getattr(info, "language_probability", 0.0), 3),
                    clip_duration_s=round(clip_dur, 1),
                    elapsed_ms=round((time.monotonic() - t_wav) * 1000),
                    transcribe_pass=pass_label,
                )
                offset += clip_dur
            return collected, dropped_count, offset

        if use_modal:
            all_segments, dropped, total_source = await _collect_segments_modal()
        else:
            all_segments, dropped, total_source = await _collect_segments(options, pass_label="vad")

        coverage = transcript_coverage_stats(all_segments, total_source)
        log.info("transcribe_coverage", **coverage, total_source=round(total_source, 1), dropped=dropped)

        if not use_modal and should_retry_transcription_without_vad(all_segments, total_source):
            log.warning("transcribe_retry_no_vad", **coverage)
            await _video_progress(job_id, 65, "transcribe", "Whisper พลาดช่วงเงียบ — ถอดเสียงรอบ 2…")
            retry_options = build_transcribe_options(language=_s.whisper_language, vad_filter=False)
            retry_segments, retry_dropped, _ = await _collect_segments(retry_options, pass_label="no_vad")
            retry_cov = transcript_coverage_stats(retry_segments, total_source)
            log.info("transcribe_retry_coverage", **retry_cov, dropped=retry_dropped)
            if (
                retry_cov["speech_sec"] > coverage["speech_sec"] + 5.0
                or retry_cov["first_start"] + 30.0 < coverage["first_start"]
            ):
                all_segments = retry_segments
                dropped = retry_dropped
                log.info("transcribe_retry_adopted", **retry_cov)

        log.info("transcribe_filtered", kept=len(all_segments), dropped=dropped)

        transcript = {"segments": all_segments}
        transcript_path = output_dir / "transcript.json"
        transcript_path.write_text(json.dumps(transcript, ensure_ascii=False, indent=2), encoding="utf-8")

        rel_path = str(transcript_path.relative_to(root))
        await _update_video(session, project_uid, transcript_path=rel_path)
        await _video_progress(
            job_id, 70, "transcribe",
            f"ถอดเสียงเสร็จแล้ว ({len(all_segments)} ช่วง) กำลังส่งให้ AI วางแผน…",
        )

        log.info("transcribe_done", project_uid=project_uid, segments=len(all_segments))

        if await _abort_if_cancelled(session, project_uid, job_id):
            return {"cancelled": True}

        from arq import create_pool
        from arq.connections import RedisSettings
        from packages.core.settings import get_settings
        settings = get_settings()
        pool = await create_pool(RedisSettings.from_dsn(settings.redis_url))
        await pool.enqueue_job("plan_edit", job_id=job_id, project_uid=project_uid, tenant_slug=tenant_slug)
        await pool.close()

        return {"segments": len(all_segments)}
    except Exception as exc:
        ts = await _tenant_session(tenant_slug)
        try:
            if await _abort_if_cancelled(ts, project_uid, job_id):
                return {"cancelled": True}
            await _update_video(ts, project_uid, status="error", error_msg=str(exc))
        finally:
            await ts.close()
        await _update_job(
            job_id, "error", 0,
            result={"step": "error", "message": str(exc)},
            error=str(exc),
        )
        raise
    finally:
        await session.close()


async def _clean_transcript_with_llm(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Fix Thai spelling/spacing in transcript text without touching timestamps.

    Whisper fine-tuned on Thai often outputs run-together or misspelled words.
    Haiku corrects text only; all timing data is preserved.
    """
    from packages.llm.gateway import complete

    all_text = " ".join(s.get("text", "") for s in segments).strip()
    if len(all_text) < 50 or not segments:
        return segments

    entries = [{"i": i, "t": s.get("text", "")} for i, s in enumerate(segments)]
    prompt = (
        "<transcript>\n"
        f"{json.dumps(entries, ensure_ascii=False)}\n"
        "</transcript>\n\n"
        "<instruction>Fix Thai spelling and word spacing in each 't' field. "
        "Do NOT change meaning, add words, or alter timing. "
        "Return JSON array with same structure: [{\"i\": ..., \"t\": \"corrected text\"}, ...]"
        "</instruction>"
    )
    try:
        raw = await complete(prompt, system="You are a Thai text editor. Fix only spelling and spacing.")
        parsed = parse_llm_json(raw)
        if isinstance(parsed, list):
            corrected = {entry["i"]: entry["t"] for entry in parsed if "i" in entry and "t" in entry}
            out = []
            for i, seg in enumerate(segments):
                if i in corrected:
                    out.append({**seg, "text": corrected[i]})
                else:
                    out.append(seg)
            log.info("transcript_cleaned", segments=len(out))
            return out
    except Exception as exc:
        log.warning("transcript_clean_failed", error=str(exc))
    return segments


# ── task: plan_edit ───────────────────────────────────────────────────────────


async def plan_edit(ctx: dict[str, Any], *, job_id: str, project_uid: str, tenant_slug: str) -> dict:
    """Build Timeline JSON — full silence-cut, or AI highlight within target duration."""
    log.info("task_start", task="plan_edit", project_uid=project_uid)
    session = await _tenant_session(tenant_slug)
    try:
        if await _abort_if_cancelled(session, project_uid, job_id):
            return {"cancelled": True}

        root = data_root()
        output_dir = root / "video_outputs" / project_uid

        proj = await _get_video_project(session, project_uid)
        duration_mode = proj.duration_mode  # "full" | "auto" | "custom"
        target_sec = proj.target_duration_sec  # set only when duration_mode == "custom"

        await _video_progress(job_id, 72, "plan", "กำลังวิเคราะห์ transcript…")

        transcript_text = (root / proj.transcript_path).read_text(encoding="utf-8")
        transcript_data = json.loads(transcript_text)
        segments = transcript_data.get("segments", [])
        segments = await _clean_transcript_with_llm(segments)

        norm_dir = output_dir / "normalized"
        norm_files = sorted(norm_dir.glob("norm_*.*"))
        sources = [{"id": f"clip{i}", "file": f"normalized/{p.name}"} for i, p in enumerate(norm_files)]
        source_info = video_stream_info(norm_files[0]) if norm_files else {"width": 0, "height": 0, "fps": 30}
        clip_durations = [media_duration(p) for p in norm_files]
        boundaries = build_clip_boundaries(clip_durations)
        total_duration = boundaries[-1]["end"] if boundaries else 0.0

        speech_cuts = build_speech_cuts(
            segments,
            gap_threshold=EDITORIAL_BLOCK_GAP,
            source_duration=total_duration,
        )
        if not speech_cuts:
            raise ValueError("Transcript has no speech segments to keep")

        speech_cuts = dedupe_repeated_cuts(speech_cuts, segments)

        # full mode — code only, no AI
        if duration_mode == "full" or duration_mode is None:
            edit_mode = "full"
            target_sec = None
            cuts = list(speech_cuts)
            await _video_progress(job_id, 73, "plan", "ตัดช่วงเงียบ + ลบคำพูดซ้ำ…")
            cuts = strip_filler_cuts(cuts, segments)
            cuts = split_cuts_on_internal_silence(cuts, segments, source_duration=total_duration)
            cuts = strip_filler_words_from_cuts(cuts, segments)
            cuts = dedupe_spaced_word_repeats(cuts, segments)
            cuts = dedupe_repeated_cuts(cuts, segments)
            cuts = resnap_selected_cuts(cuts, segments, source_duration=total_duration)
            cuts = filter_short_cuts(cuts)

        # custom mode — Haiku text-only highlight planning
        elif duration_mode == "custom" and target_sec is not None:
            edit_mode = "highlight"
            await _video_progress(job_id, 73, "plan", f"Haiku กำลังเลือก highlight ให้พอดี {target_sec} วิ…")
            cuts = await _plan_highlight_with_haiku(speech_cuts, segments, target_sec)
            # Semantic dedupe — removes duplicate takes at block level
            if len(cuts) >= 2:
                cuts = await _dedupe_semantic_cuts_with_llm(cuts, segments)
            cuts = split_cuts_on_internal_silence(cuts, segments, source_duration=total_duration)
            cuts = strip_filler_words_from_cuts(cuts, segments)
            cuts = dedupe_spaced_word_repeats(cuts, segments)
            cuts = dedupe_repeated_cuts(cuts, segments)
            before_budget = cuts_duration(cuts)
            cuts = enforce_cuts_budget(cuts, segments, float(target_sec))
            after_budget = cuts_duration(cuts)
            if after_budget < before_budget - 0.5:
                log.info(
                    "cuts_budget_enforced",
                    target_sec=target_sec,
                    before_sec=round(before_budget, 1),
                    after_sec=round(after_budget, 1),
                )
            cuts = resnap_selected_cuts(cuts, segments, source_duration=total_duration)
            cuts = filter_short_cuts(cuts)

        else:
            # Fallback for unexpected mode — treat as full
            edit_mode = "full"
            target_sec = None
            cuts = list(speech_cuts)
            cuts = strip_filler_cuts(cuts, segments)
            cuts = split_cuts_on_internal_silence(cuts, segments, source_duration=total_duration)
            cuts = strip_filler_words_from_cuts(cuts, segments)
            cuts = dedupe_spaced_word_repeats(cuts, segments)
            cuts = dedupe_repeated_cuts(cuts, segments)
            cuts = resnap_selected_cuts(cuts, segments, source_duration=total_duration)
            cuts = filter_short_cuts(cuts)

        cuts = remove_overlapping_cuts(cuts)
        log.info("cuts_after_dedup", count=len(cuts), duration=round(cuts_duration(cuts), 1))
        if not cuts:
            raise ValueError("No speech segments remain after removing clips shorter than 1 second")

        render_cuts = filter_short_cuts(localize_cuts(cuts, boundaries))
        kept_sec = cuts_duration(render_cuts)

        captions = build_captions_for_cuts(segments, cuts)

        # talking_head = silence-cut + keep speech only. No overlays/effects here —
        # popups, stickers, zoom and burned captions belong to richer modes (future work).
        timeline = {
            "mode": "talking_head",
            "editMode": edit_mode,
            "sources": sources,
            "timeline": render_cuts,
            "captions": captions,
            "output": {
                **source_info,
                "targetDurationSec": target_sec,
                "maxDurationSec": round(kept_sec, 1),
                "sourceDurationSec": round(total_duration, 1),
                "clipCount": len(norm_files),
            },
        }

        timeline_path = output_dir / "timeline.json"
        timeline_path.write_text(json.dumps(timeline, ensure_ascii=False, indent=2), encoding="utf-8")

        rel_path = str(timeline_path.relative_to(root))
        await _update_video(session, project_uid, timeline_path=rel_path)
        cut_count = len(render_cuts)
        await _video_progress(
            job_id, 80, "plan",
            f"วางแผนเสร็จแล้ว ({cut_count} ช่วง, ~{int(kept_sec)} วิ) กำลัง render…",
        )

        log.info(
            "plan_edit_done",
            project_uid=project_uid,
            cuts=cut_count,
            edit_mode=edit_mode,
            target_sec=target_sec,
            kept_sec=round(kept_sec, 1),
        )

        if await _abort_if_cancelled(session, project_uid, job_id):
            return {"cancelled": True}

        from arq import create_pool
        from arq.connections import RedisSettings
        from packages.core.settings import get_settings
        settings = get_settings()
        pool = await create_pool(RedisSettings.from_dsn(settings.redis_url))
        await pool.enqueue_job("render_video", job_id=job_id, project_uid=project_uid, tenant_slug=tenant_slug)
        await pool.close()

        return {"cuts": cut_count}
    except Exception as exc:
        ts = await _tenant_session(tenant_slug)
        try:
            if await _abort_if_cancelled(ts, project_uid, job_id):
                return {"cancelled": True}
            await _update_video(ts, project_uid, status="error", error_msg=str(exc))
        finally:
            await ts.close()
        await _update_job(
            job_id, "error", 0,
            result={"step": "error", "message": str(exc)},
            error=str(exc),
        )
        raise
    finally:
        await session.close()


def _marks_to_popups(product_marks: list[dict], render_cuts: list[dict]) -> list[dict]:
    """Map product_marks (sourceClip + at) → popup overlay entries on the output timeline."""
    popups: list[dict] = []
    out_t = 0.0
    cut_start_times: list[float] = []
    for cut in render_cuts:
        cut_start_times.append(out_t)
        out_t += float(cut["out"]) - float(cut["in"])

    for mark in product_marks:
        src = mark.get("sourceClip", "clip0")
        at = float(mark.get("at", 0.0))
        for i, cut in enumerate(render_cuts):
            if cut.get("source") != src:
                continue
            c_in = float(cut["in"])
            c_out = float(cut["out"])
            if c_in <= at <= c_out:
                output_t = cut_start_times[i] + (at - c_in)
                popup: dict = {
                    "template": "product_name",
                    "data": {
                        "name": mark.get("productName", ""),
                        "price": mark.get("price", ""),
                    },
                    "start": round(output_t, 3),
                    "duration": 3.0,
                    "position": "bottom-center",
                }
                popups.append(popup)
                if mark.get("price"):
                    popups.append({
                        "template": "price",
                        "data": {"price": mark.get("price", "")},
                        "start": round(output_t + 0.5, 3),
                        "duration": 2.5,
                        "position": "bottom-left",
                    })
                break
    return popups


async def _plan_highlight_with_haiku(
    speech_cuts: list[dict[str, Any]],
    segments: list[dict[str, Any]],
    target_sec: int,
) -> list[dict[str, Any]]:
    """Haiku text-only: select speech blocks to fit target_sec budget.

    No vision frames, no Sonnet — purely block-id selection by transcript text.
    Falls back to trim_speech_cuts_to_budget on any error.
    """
    from packages.llm.gateway import complete

    blocks = build_speech_blocks(speech_cuts, segments)
    if not blocks:
        return trim_speech_cuts_to_budget(speech_cuts, float(target_sec))

    total_natural = sum(float(b.get("duration", 0)) for b in blocks)
    prompt = (
        f"<budget>\n"
        f"<targetSec>{target_sec}</targetSec>\n"
        f"<totalIfAllKeptSec>{round(total_natural, 1)}</totalIfAllKeptSec>\n"
        f"</budget>\n\n"
        f"<speech_blocks>\n{json.dumps(blocks, ensure_ascii=False)}\n</speech_blocks>\n\n"
        "<instruction>Select blocks to keep within the budget. "
        "Return JSON: {\"keep\": [0, 2, 4], \"remove_reason\": {\"1\": \"filler\"}}</instruction>"
    )
    try:
        raw = await complete(prompt, system=HIGHLIGHT_HAIKU_SYSTEM)
        parsed = parse_llm_json(raw)
        keep_ids: list[int] = [int(i) for i in (parsed.get("keep") or []) if 0 <= int(i) < len(blocks)]
        if keep_ids:
            kept = select_speech_cuts_by_ids(speech_cuts, keep_ids, blocks)
            if kept:
                log.info("haiku_highlight_ok", kept=len(kept), removed=len(blocks) - len(keep_ids), target_sec=target_sec)
                return kept
        log.warning("haiku_highlight_empty_fallback", keep_ids=keep_ids)
    except Exception as exc:
        log.warning("haiku_highlight_failed", error=str(exc))

    return trim_speech_cuts_to_budget(speech_cuts, float(target_sec))


async def _dedupe_semantic_cuts_with_llm(
    cuts: list[dict[str, Any]],
    segments: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Haiku pass: drop repeated takes when meaning matches but Whisper wording differs."""
    from packages.llm.gateway import complete

    entries: list[dict[str, Any]] = []
    for i, cut in enumerate(cuts):
        text = _text_for_cut(cut, segments).strip()
        whisper_segs = whisper_segments_for_cut(cut, segments)
        if not text and not whisper_segs:
            continue
        entries.append({
            "cut_index": i,
            "text": text[:400],
            "whisper_segments": whisper_segs[:12],
            "duration_sec": round(cut_duration(cut), 1),
        })
    if len(entries) < 2:
        return cuts

    prompt = (
        "<cuts_to_review>\n"
        f"{json.dumps(entries, ensure_ascii=False)}\n"
        "</cuts_to_review>\n\n"
        "<instruction>Find repeated takes (same meaning, different Whisper wording). "
        "Return duplicate_groups JSON only.</instruction>"
    )
    try:
        raw = await complete(prompt, system=AI_SEMANTIC_DEDUPE_SYSTEM)
        parsed = parse_llm_json(raw)
        deduped = apply_semantic_dedupe_plan(cuts, segments, parsed)
        removed = len(cuts) - len(deduped)
        if removed:
            log.info("semantic_dedupe_done", removed=removed, kept=len(deduped))
        return deduped
    except Exception as exc:
        log.warning("semantic_dedupe_failed", error=str(exc))
        return cuts


# ── task: render_video ────────────────────────────────────────────────────────

def _write_srt(captions: list[dict], path: pathlib.Path) -> None:
    """Write captions list to SRT file."""

    def _ts(secs: float) -> str:
        h = int(secs // 3600)
        m = int((secs % 3600) // 60)
        s = int(secs % 60)
        ms = int((secs - int(secs)) * 1000)
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

    lines: list[str] = []
    for i, cap in enumerate(captions, 1):
        lines += [str(i), f"{_ts(cap['start'])} --> {_ts(cap['end'])}", cap["text"], ""]
    path.write_text("\n".join(lines), encoding="utf-8")


async def render_video(ctx: dict[str, Any], *, job_id: str, project_uid: str, tenant_slug: str) -> dict:
    """Render final.mp4 from Timeline JSON, generate SRT, produce CapCut ZIP."""
    log.info("task_start", task="render_video", project_uid=project_uid)
    await _video_progress(job_id, 82, "render", "กำลังตัดคลิปตามแผน AI…")
    session = await _tenant_session(tenant_slug)
    try:
        import ffmpeg as ffmpeg_lib

        if await _abort_if_cancelled(session, project_uid, job_id):
            return {"cancelled": True}

        root = data_root()
        output_dir = root / "video_outputs" / project_uid
        clips_dir = output_dir / "clips"
        captions_dir = output_dir / "captions"
        clips_dir.mkdir(exist_ok=True)
        captions_dir.mkdir(exist_ok=True)

        proj = await _get_video_project(session, project_uid)
        timeline = json.loads((root / proj.timeline_path).read_text(encoding="utf-8"))
        cuts = filter_renderable_cuts(timeline.get("timeline", []))
        captions = timeline.get("captions", [])
        effects = timeline.get("effects", [])
        focus_speaker = bool(timeline.get("focusSpeaker", False))

        if not cuts:
            raise ValueError("Timeline has no renderable cuts")

        # Build zoom effect lookup: cut_idx → effect dict
        _zoom_by_idx: dict[int, dict] = {
            e["cut_idx"]: e
            for e in effects
            if e.get("type") == "punchZoom"
        }

        # 1. Trim each segment to a numbered clip
        concat_list_path = output_dir / "concat.txt"
        clip_paths: list[pathlib.Path] = []
        total = len(cuts)
        log.info("render_video_cutting", project_uid=project_uid, total_cuts=total)
        for i, cut in enumerate(cuts):
            if await _abort_if_cancelled(session, project_uid, job_id):
                return {"cancelled": True}
            await _video_progress(
                job_id,
                int(82 + 8 * i / max(total, 1)),
                "render",
                f"กำลังตัดช่วงที่ {i + 1}/{total}…",
            )
            norm_file = output_dir / cut["source"].replace("normalized/", "normalized/") if "/" in cut["source"] else output_dir / "normalized" / f"norm_{i:03d}.mp4"
            # Support source as "clip0" id OR direct relative path
            if cut["source"].startswith("clip"):
                idx = int(cut["source"].replace("clip", ""))
                norm_files_sorted = sorted((output_dir / "normalized").glob("norm_*.mp4"))
                norm_file = norm_files_sorted[idx] if idx < len(norm_files_sorted) else norm_files_sorted[0]
            clip_out = clips_dir / f"clip_{i:03d}.mp4"
            dur = float(cut["out"]) - float(cut["in"])
            trim_media(norm_file, clip_out, float(cut["in"]), dur)

            # Apply punch-zoom if this cut has a zoom effect
            if i in _zoom_by_idx:
                try:
                    from packages.video.ffmpeg_bin import apply_zoom
                    ze = _zoom_by_idx[i]
                    _zoom_tmp = clips_dir / f"clip_{i:03d}_zoom.mp4"
                    apply_zoom(
                        clip_out, _zoom_tmp,
                        scale=float(ze.get("scale", 1.1)),
                        duration=float(ze.get("duration", 0.25)),
                    )
                    _zoom_tmp.replace(clip_out)
                except Exception as _ze:
                    log.warning("zoom_apply_failed", cut_idx=i, error=str(_ze))

            # Apply face-crop for focusSpeaker mode (non-fatal)
            if focus_speaker:
                try:
                    import ffmpeg as ffmpeg_lib2
                    from packages.video.face_tracker import (
                        build_ffmpeg_crop_filter,
                        median_face_crop,
                        track_faces_in_clip,
                    )

                    _vinfo = video_stream_info(clip_out)
                    _face_results = track_faces_in_clip(clip_out, sample_every_n=30)
                    _crop = median_face_crop(_face_results, _vinfo["width"], _vinfo["height"])
                    if _crop:
                        _crop_filter = build_ffmpeg_crop_filter(_crop)
                        _cropped = clips_dir / f"clip_{i:03d}_crop.mp4"
                        _cinp = ffmpeg_lib2.input(str(clip_out))
                        run_ffmpeg(
                            ffmpeg_lib2.output(
                                _cinp.video.filter("crop", _crop["w"], _crop["h"], _crop["x"], _crop["y"]),
                                _cinp.audio,
                                str(_cropped),
                                vcodec="libx264", crf=18, preset="fast", acodec="copy",
                            ).overwrite_output(),
                            label=f"face_crop_{i}",
                        )
                        _cropped.replace(clip_out)
                except Exception as _fce:
                    log.warning("face_crop_failed", cut_idx=i, error=str(_fce))

            clip_paths.append(clip_out)

        # 2. Write concat list (paths relative to concat.txt location)
        concat_list_path.write_text(
            "\n".join(
                f"file '{p.relative_to(output_dir).as_posix()}'" for p in clip_paths
            ),
            encoding="utf-8",
        )

        await _video_progress(job_id, 92, "render", "กำลังรวมคลิปเป็นวิดีโอเต็ม…")

        # 3. Concatenate → final.mp4 (stream copy — segments already re-encoded in sync)
        final_path = output_dir / "final.mp4"
        run_ffmpeg(
            ffmpeg_lib
            .input(str(concat_list_path), format="concat", safe=0)
            .output(str(final_path), c="copy", movflags="+faststart")
            .overwrite_output(),
            label="render_concat",
        )

        # 3a. dub_first: replace audio with voiceover
        vo_rel = timeline.get("voiceover_path")
        if vo_rel:
            vo_file = root / vo_rel
            if vo_file.exists():
                final_with_vo = output_dir / "final_vo.mp4"
                vo_in = ffmpeg_lib.input(str(vo_file))
                run_ffmpeg(
                    ffmpeg_lib.output(
                        ffmpeg_lib.input(str(final_path)).video,
                        vo_in.audio,
                        str(final_with_vo),
                        vcodec="copy",
                        acodec="aac",
                        audio_bitrate="192k",
                        shortest=None,
                    )
                    .global_args("-shortest")
                    .overwrite_output(),
                    label="render_vo_replace",
                )
                final_with_vo.replace(final_path)

        # 3a2. Loudness normalization (EBU R128, TikTok-friendly ~-16 LUFS) — non-fatal.
        # Video stream-copied, audio re-encoded once; later overlay steps copy audio through.
        try:
            from packages.video.ffmpeg_bin import normalize_loudness

            await _video_progress(job_id, 92, "render", "กำลังปรับระดับเสียงให้สม่ำเสมอ…")
            _normed = output_dir / "final_loudnorm.mp4"
            normalize_loudness(final_path, _normed)
            _normed.replace(final_path)
        except Exception as _lne:
            log.warning("loudnorm_failed", error=str(_lne))

        # 3b. ASS karaoke caption burn-in — only when the timeline opts in (non-talking_head).
        _ass_burned = False
        if timeline.get("karaoke") and proj.transcript_path:
            try:
                from packages.video.caption import build_ass_karaoke, remap_words_to_output

                _td = json.loads((root / proj.transcript_path).read_text(encoding="utf-8"))
                _all_words = [
                    w for seg in _td.get("segments", [])
                    for w in seg.get("words", [])
                    if w.get("word", "").strip()
                ]
                if _all_words:
                    # Compute absolute start offset for each norm clip
                    _norm_all = sorted((output_dir / "normalized").glob("norm_*.mp4"))
                    _clip_abs: dict[str, float] = {}
                    _off = 0.0
                    for _ci, _nf in enumerate(_norm_all):
                        _clip_abs[f"clip{_ci}"] = _off
                        _off += media_duration(_nf)

                    _output_dur = sum(float(c["out"]) - float(c["in"]) for c in cuts)
                    _remapped = remap_words_to_output(_all_words, cuts, _clip_abs)
                    if _remapped:
                        await _video_progress(job_id, 93, "render", "กำลังเพิ่ม caption แบบ karaoke…")
                        ass_path = captions_dir / "subtitles.ass"
                        ass_path.write_text(
                            build_ass_karaoke(_remapped, _output_dur), encoding="utf-8"
                        )
                        # Escape drive-letter colon for ffmpeg filter on Windows
                        _ass_filter = "ass=" + ass_path.as_posix().replace(":", r"\:")
                        _final_captioned = output_dir / "final_captions.mp4"
                        run_ffmpeg(
                            ffmpeg_lib.input(str(final_path))
                            .output(
                                str(_final_captioned),
                                vf=_ass_filter,
                                acodec="copy",
                                vcodec="libx264",
                                crf=18,
                                preset="fast",
                            )
                            .overwrite_output(),
                            label="burn_captions",
                        )
                        _final_captioned.replace(final_path)
                        _ass_burned = True
            except Exception as _cap_exc:
                log.warning("caption_burn_failed", error=str(_cap_exc))

        # 3d. Popup / CTA overlay (non-fatal)
        popups = timeline.get("popups", [])
        if popups:
            try:
                from packages.video.overlay import popup_position_xy, popup_size, render_popup_png

                overlay_dir = output_dir / "overlays"
                overlay_dir.mkdir(exist_ok=True)

                # Probe video dimensions for position math
                _vprobe = probe_media(str(final_path))
                _vs = next((s for s in _vprobe["streams"] if s["codec_type"] == "video"), {})
                _vid_w = int(_vs.get("width", 1080))
                _vid_h = int(_vs.get("height", 1920))

                await _video_progress(job_id, 94, "render", f"กำลังเพิ่ม overlay {len(popups)} ชิ้น…")

                # Render PNG for each popup
                _png_paths: list[pathlib.Path] = []
                for _pi, _popup in enumerate(popups):
                    _tpl = _popup.get("template", "price")
                    _png = overlay_dir / f"popup_{_pi:03d}.png"
                    render_popup_png(_tpl, _popup.get("data", {}), _png, _vid_w, _vid_h)
                    _png_paths.append(_png)

                # Build ffmpeg overlay filter chain
                _main_in = ffmpeg_lib.input(str(final_path))
                _vid_stream = _main_in.video
                _aud_stream = _main_in.audio
                for _pi, (_popup, _png) in enumerate(zip(popups, _png_paths)):
                    _t0 = float(_popup.get("start", 0.0))
                    _t1 = _t0 + float(_popup.get("duration", 2.0))
                    _tpl = _popup.get("template", "price")
                    _pw, _ph = popup_size(_tpl)
                    _px, _py = popup_position_xy(
                        _popup.get("position", "bottom-center"), _vid_w, _vid_h, _pw, _ph
                    )
                    _img_in = ffmpeg_lib.input(str(_png))
                    _vid_stream = ffmpeg_lib.filter(
                        [_vid_stream, _img_in], "overlay",
                        x=_px, y=_py,
                        enable=f"between(t,{_t0},{_t1})",
                    )

                _final_popup = output_dir / "final_popup.mp4"
                run_ffmpeg(
                    ffmpeg_lib.output(
                        _vid_stream, _aud_stream, str(_final_popup),
                        vcodec="libx264", crf=18, preset="fast", acodec="copy",
                    ).overwrite_output(),
                    label="render_popups",
                )
                _final_popup.replace(final_path)
            except Exception as _pop_exc:
                log.warning("popup_overlay_failed", error=str(_pop_exc))

        # 3e. Sticker overlay (Tier 3d, non-fatal)
        _graphics = timeline.get("graphics", [])
        if _graphics:
            try:
                from packages.video.stickers import sticker_path

                await _video_progress(job_id, 95, "render", f"กำลังเพิ่ม sticker {len(_graphics)} ชิ้น…")
                _sticker_dir = output_dir / "stickers"
                _sticker_dir.mkdir(exist_ok=True)

                _g_main = ffmpeg_lib.input(str(final_path))
                _g_vid = _g_main.video
                _g_aud = _g_main.audio
                for _gi, _g in enumerate(_graphics):
                    _sp = sticker_path(_g["name"])
                    _g_t0 = float(_g.get("at", 0.0))
                    _g_t1 = _g_t0 + float(_g.get("duration", 2.0))
                    _gx = int(_g.get("x", 0))
                    _gy = int(_g.get("y", 0))
                    _g_img = ffmpeg_lib.input(str(_sp))
                    _g_vid = ffmpeg_lib.filter(
                        [_g_vid, _g_img], "overlay",
                        x=_gx, y=_gy,
                        enable=f"between(t,{_g_t0},{_g_t1})",
                    )

                _final_stickered = output_dir / "final_stickers.mp4"
                run_ffmpeg(
                    ffmpeg_lib.output(
                        _g_vid, _g_aud, str(_final_stickered),
                        vcodec="libx264", crf=18, preset="fast", acodec="copy",
                    ).overwrite_output(),
                    label="render_stickers",
                )
                _final_stickered.replace(final_path)
            except Exception as _ge:
                log.warning("sticker_overlay_failed", error=str(_ge))

        # 4. SRT captions
        srt_path = captions_dir / "subtitles.srt"
        _write_srt(captions, srt_path)

        # 5. manifest.json
        manifest = {
            "project_uid": project_uid,
            "mode": timeline.get("mode", "talking_head"),
            "output": timeline.get("output", {}),
            "clips": [{"file": f"clips/{p.name}", "label": cuts[i].get("label", "")} for i, p in enumerate(clip_paths)],
            "captions": "captions/subtitles.srt",
            "captions_ass": "captions/subtitles.ass" if _ass_burned else None,
            "graphics": [
                {"name": g["name"], "at": g["at"], "x": g.get("x", 0), "y": g.get("y", 0)}
                for g in _graphics
            ],
        }
        manifest_path = output_dir / "manifest.json"
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

        # 6. README.txt
        readme_path = output_dir / "README.txt"
        readme_path.write_text(
            "CapCut Import Guide\n"
            "===================\n"
            "1. Import clips/ folder as separate video tracks\n"
            "2. Import captions/subtitles.srt as captions\n"
            "3. Refer to manifest.json for layer ordering\n"
            "4. final.mp4 is the pre-rendered output (optional reference)\n",
            encoding="utf-8",
        )

        # 7. Build ZIP bundle
        await _video_progress(job_id, 96, "render", "กำลังสร้าง CapCut bundle…")
        zip_path = output_dir / "capcut_bundle.zip"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.write(final_path, "final.mp4")
            for cp in clip_paths:
                zf.write(cp, f"clips/{cp.name}")
            zf.write(srt_path, f"captions/{srt_path.name}")
            _ass_zip = captions_dir / "subtitles.ass"
            if _ass_zip.exists():
                zf.write(_ass_zip, "captions/subtitles.ass")
            zf.write(manifest_path, "manifest.json")
            zf.write(readme_path, "README.txt")
            if _graphics:
                try:
                    from packages.video.stickers import sticker_path as _sp
                    _seen_stickers: set[str] = set()
                    for _g in _graphics:
                        _gn = _g["name"]
                        if _gn not in _seen_stickers:
                            _gpath = _sp(_gn)
                            zf.write(_gpath, f"stickers/{_gn}.png")
                            _seen_stickers.add(_gn)
                except Exception:
                    pass

        final_rel = str(final_path.relative_to(root))
        zip_rel = str(zip_path.relative_to(root))

        if await _abort_if_cancelled(session, project_uid, job_id):
            return {"cancelled": True}

        # Push rendered outputs to S3 if enabled (no-op on local)
        from packages.video.s3 import push_outputs
        await push_outputs(project_uid, output_dir)

        await _update_video(session, project_uid,
                            status="done",
                            final_path=final_rel,
                            zip_path=zip_rel)
        await _update_job(
            job_id, "ok", 100,
            result={
                "step": "done",
                "message": "ตัดต่อเสร็จแล้ว พร้อมดาวน์โหลด",
                "final_path": final_rel,
                "zip_path": zip_rel,
            },
        )

        log.info("render_done", project_uid=project_uid, final=final_rel)
        return {"final_path": final_rel, "zip_path": zip_rel}
    except Exception as exc:
        ts = await _tenant_session(tenant_slug)
        try:
            if await _abort_if_cancelled(ts, project_uid, job_id):
                return {"cancelled": True}
            await _update_video(ts, project_uid, status="error", error_msg=str(exc))
        finally:
            await ts.close()
        await _update_job(
            job_id, "error", 0,
            result={"step": "error", "message": str(exc)},
            error=str(exc),
        )
        raise
    finally:
        await session.close()


# ── task: analyze_dub_first ──────────────────────────────────────────────────


_SCRIPT_OUTLINE_SYSTEM = """<role>
You are a TikTok affiliate video script planner.
</role>

<task>
Given a creator brief and/or their written script plus sample video frames,
produce a structured scene-by-scene script plan the creator will use as voiceover.
</task>

<rules>
<script_source>
- If the creator provided a full script (user_script): structure it into scenes of 3–8s each. Keep their wording exactly — do not rewrite.
- If only a brief / direction: generate a script inspired by the brief and what you see in the frames.
- If neither: infer the script from the video content alone.
</script_source>
<scenes>
- Each scene = one spoken voiceover LINE (not necessarily one camera angle) — short punchy TikTok phrasing, Thai or English
- estimated_sec = how long the creator will speak that line (~3–8s typical)
- visual_hint: "single shot" for hooks/CTAs OR "multi-angle" for product/OOTD/demo — means switch camera angles often while the line plays, not one long static hold
- Aim for 5–15 lines total depending on content richness
</scenes>
</rules>

<forbidden>
Do NOT output prose, markdown, or any text outside the JSON object.
</forbidden>

<output_format>
Return ONLY a valid JSON object matching this schema exactly:
{
  "estimated_total_sec": 45,
  "scenes": [
    {"order": 1, "voiceover_line": "วันนี้มารีวิวครีมตัวนี้ค่ะ", "estimated_sec": 4, "visual_hint": "product reveal"},
    {"order": 2, "voiceover_line": "ใช้มาแล้ว 2 อาทิตย์", "estimated_sec": 4, "visual_hint": "usage demo"}
  ]
}
</output_format>"""


_EDIT_SCRIPT_SYSTEM = """<role>
You are a TikTok affiliate video editor helping a creator plan a dub-first video.
</role>

<task>
Match voiceover lines from the script plan to video moments.
You receive: a script plan (voiceover lines + visual hints) and sample frames from the video clips with timestamps.
</task>

<rules>
<timing>
- The problem to solve: viewers should NOT stare at one angle too long — switch angles often. This is about CUT FREQUENCY, not making each cut ultra-short.
- Single-shot (hooks, calm CTA only): one cut, 2–4 seconds max.
- Multi-angle lines (product, OOTD, outfit, demo — default when frames show variety):
  use 3–6 visual cuts per voiceover line sharing the same voiceoverLineId.
  Each cut: 1.5–3.5 seconds typical (2–4s OK for a hero moment). Do NOT stretch one angle to 5–8s when other strong frames exist — that feels like dead air / waiting.
  Distribute cuts across the line's estimated_sec — e.g. a 6s spoken line → four ~1.5s angle changes, NOT one 6s clip.
- Pick DISTINCT source timestamps for consecutive cuts — never reuse the same moment twice in a row.
</timing>
<voiceover_lines>
- voiceoverLineId (integer): all visual cuts under the same spoken line share the same id.
- Single-cut line: one segment, unique voiceoverLineId, full voiceoverScript on that segment.
- Multi-angle line: 3–6 segments with the SAME voiceoverLineId; voiceoverScript on the first segment only (others omit).
- voiceoverScript wording must match the script plan exactly — do not rewrite.
</voiceover_lines>
<matching>Match visual_hint from the script plan to the most fitting video moment(s).</matching>
<priorities>Prioritize: strong product reveal, clear demonstrations, reactions, strong conclusion.</priorities>
<avoid>
- Speaker looks off-camera, down, or to the side
- Speaker mid-preparation: adjusting hair, clothing, phone, or camera
- Speaker looks uncertain, hesitant, or mid-sentence restart
- Repeated segments showing the same action twice
- Any moment where the speaker has not yet started their shot
</avoid>
<prefer>
- Speaker looks directly at camera with confidence
- Clear product interaction: holding, showing, applying, demonstrating
- Strong emotional moments: reactions, excitement, clear delivery
</prefer>
<fields>
- cutStyle options: "jump_cut" | "standard" | "zoom_in" | "zoom_out" — default to "jump_cut"
- voiceoverLineId: integer grouping id (required on every segment)
- voiceoverScript: copy exactly from the script plan on the first cut of each line
- totalEstimatedSec: sum of all segment durationSec (all visual cuts, including montage)
</fields>
</rules>

<forbidden>
Do NOT output prose, markdown, or any text outside the JSON object.
Do NOT modify the creator's voiceover script wording.
</forbidden>

<output_format>
Return ONLY a valid JSON object matching this schema exactly:
{
  "mode": "dub_first",
  "totalEstimatedSec": 42,
  "segments": [
    {
      "order": 1,
      "voiceoverLineId": 1,
      "sourceClip": "clip0",
      "sourceIn": 5.2,
      "sourceOut": 8.2,
      "durationSec": 3.0,
      "visualDescription": "ถือสินค้าใกล้กล้อง หมุนให้เห็นฉลาก",
      "cutStyle": "jump_cut",
      "voiceoverScript": "วันนี้มารีวิวครีมตัวนี้ที่ใช้มา 2 สัปดาห์แล้ว"
    },
    {
      "order": 2,
      "voiceoverLineId": 2,
      "sourceClip": "clip0",
      "sourceIn": 12.0,
      "sourceOut": 14.0,
      "durationSec": 2.0,
      "visualDescription": "close-up ฝาครีม",
      "cutStyle": "jump_cut",
      "voiceoverScript": "เนื้อครีมบางเบา ซึมไว ไม่เหนียว"
    },
    {
      "order": 3,
      "voiceoverLineId": 2,
      "sourceClip": "clip0",
      "sourceIn": 28.5,
      "sourceOut": 30.0,
      "durationSec": 1.5,
      "visualDescription": "texture squeeze บนหลังมือ",
      "cutStyle": "jump_cut"
    },
    {
      "order": 4,
      "voiceoverLineId": 2,
      "sourceClip": "clip0",
      "sourceIn": 45.0,
      "sourceOut": 47.5,
      "durationSec": 2.5,
      "visualDescription": "ทา demo",
      "cutStyle": "jump_cut"
    },
    {
      "order": 5,
      "voiceoverLineId": 2,
      "sourceClip": "clip0",
      "sourceIn": 62.0,
      "sourceOut": 63.5,
      "durationSec": 1.5,
      "visualDescription": "ผิวหลังทา โทนสว่าง",
      "cutStyle": "zoom_in"
    }
  ]
}
</output_format>"""


_DUB_TIMELINE_SYSTEM = """<role>
You are a TikTok video editor producing a Timeline JSON for ffmpeg rendering.
</role>

<task>
Given an Edit Script and the measured duration of the creator's recorded voiceover,
map each Edit Script segment to a position on the output timeline.
</task>

<rules>
- Total duration of all cuts MUST NOT exceed voDurationSec
- Map EVERY visual segment in the Edit Script to one timeline cut (including montage segments sharing a voiceoverLineId)
- Distribute time proportionally by durationSec; segments with the same voiceoverLineId scale together as one spoken line
- "source" must be exactly the sourceClip from the Edit Script (e.g. "clip0")
- "in" and "out" are source file timestamps — use sourceIn/sourceOut from the Edit Script
- "label": "opening" for the first cut, "conclusion" for the last cut, "speech" for all others
- Preserve every visual cut from the Edit Script — do not merge multiple angles into one long hold
</rules>

<forbidden>
Do NOT output prose, markdown, or any text outside the JSON object.
Do NOT invent new sourceIn/sourceOut values — copy them from the Edit Script.
</forbidden>

<output_format>
Return ONLY a valid JSON object matching this schema exactly:
{
  "timeline": [
    {"type": "cut", "source": "clip0", "in": 5.2, "out": 8.2, "label": "opening"},
    {"type": "cut", "source": "clip0", "in": 12.0, "out": 17.0, "label": "conclusion"}
  ]
}
</output_format>"""


async def _plan_script_outline(
    *,
    brief: str,
    user_script: str,
    norm_files: list[pathlib.Path],
    frames_dir: pathlib.Path,
) -> list[dict[str, Any]]:
    """Step 1: Ask Claude to plan scene-by-scene script from brief/user_script + key frames.

    Extracts 3 key frames per clip (15%/50%/85%) — fast, low token cost.
    Returns list of scene dicts: [{order, voiceover_line, estimated_sec, visual_hint}].
    """
    import ffmpeg as ffmpeg_lib
    from packages.video.scene import frames_to_vision_content
    from packages.video.ffmpeg_bin import media_duration
    from packages.llm.gateway import acompletion
    from packages.video.timeline import parse_llm_json

    frames_dir.mkdir(parents=True, exist_ok=True)
    key_frames: list[dict[str, Any]] = []
    for i, nf in enumerate(norm_files):
        if len(key_frames) >= 5:
            break
        dur = media_duration(nf)
        for j, pct in enumerate([0.15, 0.50, 0.85]):
            if len(key_frames) >= 5:
                break
            t = dur * pct
            frame_path = frames_dir / f"key_{i}_{j}.jpg"
            try:
                run_ffmpeg(
                    ffmpeg_lib.input(str(nf), ss=t)
                    .output(str(frame_path), vframes=1, q=2)
                    .overwrite_output(),
                    label=f"key_frame_{i}_{j}",
                )
                key_frames.append({"frame_path": str(frame_path), "time": round(t, 1), "clip": f"clip{i}"})
            except Exception:
                pass

    vision_blocks = frames_to_vision_content(key_frames) if key_frames else []

    user_content: list[dict[str, Any]] = [{"type": "text", "text": (
        f"<creator_input>\n"
        f"<brief>{brief or '(ไม่ระบุ)'}</brief>\n"
        f"<user_script>{user_script or '(ไม่ระบุ — generate จากวิดีโอ)'}</user_script>\n"
        f"</creator_input>\n\n"
        "<instruction>Sample frames (key moments from the video) follow. Return script plan JSON only.</instruction>"
    )}]
    user_content.extend(vision_blocks)
    user_content.append({"type": "text", "text": "<reminder>Return ONLY the JSON object — no prose.</reminder>"})

    messages = [{"role": "user", "content": user_content}]
    try:
        from packages.llm.config import vision_call_kwargs
        resp = await acompletion(messages, system=_SCRIPT_OUTLINE_SYSTEM, **vision_call_kwargs())
        raw = resp.choices[0].message.content or ""
        parsed = parse_llm_json(raw)
        scenes = parsed.get("scenes", [])
        log.info("script_outline_done", scenes=len(scenes))
        return scenes
    except Exception as exc:
        log.warning("script_outline_failed", error=str(exc))
        return []


async def analyze_dub_first(ctx: dict[str, Any], *, job_id: str, project_uid: str, tenant_slug: str) -> dict:
    """2-step Claude Vision: plan script outline → match scenes → render silent cut."""
    log.info("task_start", task="analyze_dub_first", project_uid=project_uid)
    await _video_progress(job_id, 52, "analyze", "กำลังวางแผน script…")
    session = await _tenant_session(tenant_slug)
    try:
        if await _abort_if_cancelled(session, project_uid, job_id):
            return {"cancelled": True}

        root = data_root()
        output_dir = root / "video_outputs" / project_uid
        frames_dir = output_dir / "frames"

        proj = await _get_video_project(session, project_uid)
        norm_files = sorted((output_dir / "normalized").glob("norm_*.*"))
        brief = proj.brief or ""
        user_script = proj.user_script or ""

        from packages.video.scene import detect_scenes, extract_sample_frames, frames_to_vision_content
        from packages.llm.gateway import acompletion
        from packages.video.timeline import parse_llm_json

        # ── Step 1: script planning (key frames only, fast) ───────────────────
        script_scenes = await _plan_script_outline(
            brief=brief,
            user_script=user_script,
            norm_files=norm_files,
            frames_dir=frames_dir,
        )

        script_plan_path = output_dir / "script_plan.json"
        script_plan_path.write_text(
            json.dumps({"scenes": script_scenes}, ensure_ascii=False, indent=2), encoding="utf-8"
        )

        await _video_progress(job_id, 62, "analyze", "กำลังเลือกซีนให้ตรง script…")

        if await _abort_if_cancelled(session, project_uid, job_id):
            return {"cancelled": True}

        # ── Step 2: scene matching (all frames) ───────────────────────────────
        all_frames: list[dict[str, Any]] = []
        for i, norm_file in enumerate(norm_files):
            clip_id = f"clip{i}"
            await _video_progress(
                job_id,
                int(62 + 10 * i / max(len(norm_files), 1)),
                "analyze",
                f"กำลังหาซีนในคลิป {i + 1}/{len(norm_files)}…",
            )
            try:
                scenes = detect_scenes(norm_file)
                from packages.video.scene import DUB_MAX_FRAMES
                frames = extract_sample_frames(
                    norm_file,
                    scenes,
                    frames_dir / f"clip{i}",
                    clip_id=clip_id,
                    max_frames=DUB_MAX_FRAMES,
                    samples_per_scene=2,
                )
                all_frames.extend(frames)
            except Exception as exc:
                log.warning("scene_extract_failed", clip=str(norm_file), error=str(exc))

        await _video_progress(job_id, 74, "analyze", "Claude กำลัง match script กับซีนวิดีโอ…")

        vision_content = frames_to_vision_content(all_frames)
        frame_descs = "\n".join(
            f"[{f['clip_id']} scene {f['scene_idx']} at {f['time']:.1f}s "
            f"(source {f['scene_start']:.1f}–{f['scene_end']:.1f}s)]"
            for f in all_frames
        )

        if script_scenes:
            script_plan_xml = (
                f"<script_plan>\n{json.dumps(script_scenes, ensure_ascii=False)}\n</script_plan>"
            )
        else:
            script_plan_xml = f"<brief>{brief or '(none)'}</brief>"

        user_msg_content: list[dict[str, Any]] = [{"type": "text", "text": (
            f"{script_plan_xml}\n\n"
            f"<frame_timestamps>\n{frame_descs}\n</frame_timestamps>\n\n"
            "<instruction>Sample frames follow in order. Match voiceover lines to video moments. "
            "For product/OOTD/demo lines: use 3–6 angle changes per line (1.5–3.5s each) from DISTINCT timestamps — "
            "avoid one long 5s+ hold on a single angle when other frames are available.</instruction>"
        )}]
        user_msg_content.extend(vision_content)
        user_msg_content.append({"type": "text", "text": "<reminder>Return ONLY the Edit Script JSON object — no prose.</reminder>"})

        messages = [{"role": "user", "content": user_msg_content}]
        from packages.llm.config import vision_call_kwargs
        vx = vision_call_kwargs()
        log.info(
            "analyze_dub_scene_match",
            model=vx.get("model", "default"),
            reasoning_effort=vx.get("reasoning_effort"),
            frames=len(all_frames),
        )
        resp = await acompletion(messages, system=_EDIT_SCRIPT_SYSTEM, **vx)
        raw = resp.choices[0].message.content or ""
        edit_script = parse_llm_json(raw)
        edit_script = normalize_dub_edit_script(edit_script)

        edit_script_path = output_dir / "edit_script.json"
        edit_script_path.write_text(
            json.dumps(edit_script, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        rel = str(edit_script_path.relative_to(root))
        await _update_video(session, project_uid, edit_script_path=rel)

        log.info("analyze_dub_first_done", project_uid=project_uid, segments=len(edit_script.get("segments", [])))

        if await _abort_if_cancelled(session, project_uid, job_id):
            return {"cancelled": True}

        from arq import create_pool
        from arq.connections import RedisSettings
        from packages.core.settings import get_settings
        settings = get_settings()
        pool = await create_pool(RedisSettings.from_dsn(settings.redis_url))
        await pool.enqueue_job("render_dub_silent", job_id=job_id, project_uid=project_uid, tenant_slug=tenant_slug)
        await pool.close()

        await _video_progress(job_id, 78, "render", "Script พร้อมแล้ว กำลัง render คลิป…")
        return {"segments": len(edit_script.get("segments", []))}
    except Exception as exc:
        ts = await _tenant_session(tenant_slug)
        try:
            if await _abort_if_cancelled(ts, project_uid, job_id):
                return {"cancelled": True}
            await _update_video(ts, project_uid, status="error", error_msg=str(exc))
        finally:
            await ts.close()
        await _update_job(
            job_id, "error", 0,
            result={"step": "error", "message": str(exc)},
            error=str(exc),
        )
        raise
    finally:
        await session.close()


# ── task: render_dub_silent ──────────────────────────────────────────────────


async def render_dub_silent(ctx: dict[str, Any], *, job_id: str, project_uid: str, tenant_slug: str) -> dict:
    """Cut video silently from edit_script.json → final_silent.mp4 + script.txt + ZIP."""
    log.info("task_start", task="render_dub_silent", project_uid=project_uid)
    await _video_progress(job_id, 80, "render", "กำลังตัดวิดีโอตาม script…")
    session = await _tenant_session(tenant_slug)
    try:
        import ffmpeg as ffmpeg_lib
        import zipfile

        if await _abort_if_cancelled(session, project_uid, job_id):
            return {"cancelled": True}

        root = data_root()
        output_dir = root / "video_outputs" / project_uid
        clips_dir = output_dir / "clips"
        clips_dir.mkdir(exist_ok=True)

        proj = await _get_video_project(session, project_uid)
        if not proj.edit_script_path:
            raise ValueError("edit_script_path missing")

        edit_script = normalize_dub_edit_script(
            json.loads((root / proj.edit_script_path).read_text(encoding="utf-8"))
        )
        segments = edit_script.get("segments", [])
        if not segments:
            raise ValueError("Edit script has no segments")

        norm_files_sorted = sorted((output_dir / "normalized").glob("norm_*.mp4"))

        def _norm_for_clip(clip_id: str) -> pathlib.Path:
            idx = int(clip_id.replace("clip", "")) if clip_id.startswith("clip") else 0
            return norm_files_sorted[idx] if idx < len(norm_files_sorted) else norm_files_sorted[0]

        clip_paths: list[pathlib.Path] = []
        total = len(segments)
        log.info("render_dub_silent_cutting", project_uid=project_uid, total_segments=total)
        for i, seg in enumerate(segments):
            if await _abort_if_cancelled(session, project_uid, job_id):
                return {"cancelled": True}
            await _video_progress(
                job_id,
                int(80 + 12 * i / max(total, 1)),
                "render",
                f"กำลังตัดซีนที่ {i + 1}/{total}…",
            )
            src = _norm_for_clip(seg.get("sourceClip", "clip0"))
            src_in = float(seg.get("sourceIn", 0.0))
            src_out = float(seg.get("sourceOut", src_in + 3.0))
            dur = max(0.1, src_out - src_in)
            clip_out = clips_dir / f"clip_{i:03d}.mp4"
            log.info("render_dub_clip", idx=i+1, total=total, src=src.name, in_=round(src_in,2), out=round(src_out,2), dur=round(dur,2))
            # Frame-accurate trim via video filter + reset PTS (avoids keyframe-stutter from vcodec=copy).
            # Re-encode to h264/yuv420p so concat timestamps are always consistent.
            run_ffmpeg(
                ffmpeg_lib.input(str(src))
                .video
                .filter("trim", start=src_in, end=src_out)
                .filter("setpts", "PTS-STARTPTS")
                .output(str(clip_out),
                        vcodec="libx264", preset="fast", crf=18,
                        pix_fmt="yuv420p",
                        **{"an": None})
                .overwrite_output(),
                label=f"dub_trim_{i}",
            )
            clip_paths.append(clip_out)

        log.info("render_dub_silent_concat", project_uid=project_uid, clips=len(clip_paths))
        await _video_progress(job_id, 93, "render", "กำลังรวมคลิปเป็นวิดีโอเดียว…")

        # Concatenate all clips
        concat_list_path = output_dir / "concat_silent.txt"
        concat_list_path.write_text(
            "\n".join(f"file '{p.relative_to(output_dir).as_posix()}'" for p in clip_paths),
            encoding="utf-8",
        )
        final_path = output_dir / "final_silent.mp4"
        run_ffmpeg(
            ffmpeg_lib.input(str(concat_list_path), format="concat", safe=0)
            .output(str(final_path), c="copy", movflags="+faststart")
            .overwrite_output(),
            label="dub_concat",
        )

        # Write script.txt (grouped by voiceover line; montage noted)
        script_lines = ["=== Script ===\n"]
        if proj.brief:
            script_lines.append(f"Brief: {proj.brief}\n")
        script_lines.append("")
        seen_line_ids: set[int] = set()
        line_no = 0
        for seg in segments:
            lid = int(seg.get("voiceoverLineId") or seg.get("order") or 0)
            if lid in seen_line_ids:
                continue
            seen_line_ids.add(lid)
            line_no += 1
            line_segs = [
                s for s in segments
                if int(s.get("voiceoverLineId") or s.get("order") or 0) == lid
            ]
            o_in = float(line_segs[0].get("voiceoverLineOutputIn") or line_segs[0].get("outputIn") or 0)
            o_out = float(line_segs[-1].get("voiceoverLineOutputOut") or line_segs[-1].get("outputOut") or 0)
            vo = str(line_segs[0].get("voiceoverScript") or "").strip()
            montage = len(line_segs) > 1
            hdr = f"[Line {line_no} | {o_in:.1f}s → {o_out:.1f}s"
            if montage:
                hdr += f" | {len(line_segs)} cuts"
            script_lines.append(f"{hdr}]")
            script_lines.append(vo)
            script_lines.append("")
        out_t = float(segments[-1].get("outputOut") or 0) if segments else 0.0
        script_lines.append(f"===\nTotal: {out_t:.0f}s")
        script_path = output_dir / "script.txt"
        script_path.write_text("\n".join(script_lines), encoding="utf-8")

        # Build ZIP
        await _video_progress(job_id, 96, "render", "กำลังสร้าง bundle…")
        zip_path = output_dir / "dub_bundle.zip"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.write(final_path, "final_silent.mp4")
            zf.write(script_path, "script.txt")
            for cp in clip_paths:
                zf.write(cp, f"clips/{cp.name}")

        final_rel = str(final_path.relative_to(root))
        zip_rel = str(zip_path.relative_to(root))

        await _update_video(session, project_uid, status="done", final_path=final_rel, zip_path=zip_rel)
        await _update_job(
            job_id, "ok", 100,
            result={
                "step": "done",
                "message": "ตัดวิดีโอเสร็จแล้ว พร้อม download + script",
                "final_path": final_rel,
                "zip_path": zip_rel,
            },
        )
        log.info("render_dub_silent_done", project_uid=project_uid, clips=len(clip_paths))
        return {"final_path": final_rel, "zip_path": zip_rel}
    except Exception as exc:
        ts = await _tenant_session(tenant_slug)
        try:
            if await _abort_if_cancelled(ts, project_uid, job_id):
                return {"cancelled": True}
            await _update_video(ts, project_uid, status="error", error_msg=str(exc))
        finally:
            await ts.close()
        await _update_job(
            job_id, "error", 0,
            result={"step": "error", "message": str(exc)},
            error=str(exc),
        )
        raise
    finally:
        await session.close()


# ── task: plan_dub_timeline ───────────────────────────────────────────────────


async def plan_dub_timeline(ctx: dict[str, Any], *, job_id: str, project_uid: str, tenant_slug: str) -> dict:
    """Load Edit Script + VO file → Claude → Timeline JSON → enqueue render_video."""
    await _video_progress(job_id, 5, "plan_dub", "กำลังวางแผน timeline ตาม voiceover…")
    session = await _tenant_session(tenant_slug)
    try:
        if await _abort_if_cancelled(session, project_uid, job_id):
            return {"cancelled": True}

        root = data_root()
        output_dir = root / "video_outputs" / project_uid

        proj = await _get_video_project(session, project_uid)
        if not proj.edit_script_path:
            raise ValueError("edit_script_path missing — run analyze_dub_first first")
        if not proj.voiceover_path:
            raise ValueError("voiceover_path missing — upload voiceover first")

        edit_script = json.loads((root / proj.edit_script_path).read_text(encoding="utf-8"))
        vo_path = root / proj.voiceover_path

        from packages.video.ffmpeg_bin import media_duration
        vo_duration = media_duration(vo_path)
        if vo_duration <= 0:
            raise ValueError("Voiceover file has no detectable duration")

        from packages.llm.gateway import complete

        prompt = (
            f"<voiceover>\n"
            f"<voDurationSec>{round(vo_duration, 2)}</voDurationSec>\n"
            f"</voiceover>\n\n"
            f"<edit_script>\n{json.dumps(edit_script, ensure_ascii=False)}\n</edit_script>\n\n"
            f"<instruction>Map each segment to a timeline cut. "
            f"Total cut duration MUST NOT exceed {round(vo_duration, 2)} seconds.</instruction>"
        )

        raw = await complete(prompt, system=_DUB_TIMELINE_SYSTEM)
        from packages.video.timeline import parse_llm_json
        parsed = parse_llm_json(raw)
        raw_cuts = parsed.get("timeline", [])
        if not raw_cuts:
            raise ValueError("Claude returned empty timeline for dub_first")

        # Build full timeline.json (same schema as talking_head)
        from packages.video.ffmpeg_bin import video_stream_info
        norm_files = sorted((output_dir / "normalized").glob("norm_*.*"))
        sources = [{"id": f"clip{i}", "file": f"normalized/{p.name}"} for i, p in enumerate(norm_files)]
        source_info = video_stream_info(norm_files[0]) if norm_files else {"width": 0, "height": 0, "fps": 30}

        from packages.video.timeline import (
            MIN_RENDER_CUT_SEC,
            build_clip_boundaries,
            filter_short_cuts,
            localize_cuts,
        )
        from packages.video.ffmpeg_bin import media_duration as _dur

        clip_durations = [_dur(p) for p in norm_files]
        boundaries = build_clip_boundaries(clip_durations)

        render_cuts = filter_short_cuts(
            localize_cuts(raw_cuts, boundaries),
            min_sec=MIN_RENDER_CUT_SEC,
        )
        if not render_cuts:
            raise ValueError("No valid cuts remain after localization")

        from packages.video.timeline import cuts_duration
        kept_sec = cuts_duration(render_cuts)

        timeline = {
            "mode": "dub_first",
            "editMode": "dub_first",
            "sources": sources,
            "timeline": render_cuts,
            "captions": [],
            "voiceover_path": str(vo_path.relative_to(root)),
            "output": {
                **source_info,
                "targetDurationSec": round(vo_duration, 1),
                "maxDurationSec": round(kept_sec, 1),
                "clipCount": len(norm_files),
            },
        }

        timeline_path = output_dir / "timeline.json"
        timeline_path.write_text(json.dumps(timeline, ensure_ascii=False, indent=2), encoding="utf-8")
        rel = str(timeline_path.relative_to(root))
        await _update_video(session, project_uid, timeline_path=rel, status="processing")

        await _video_progress(job_id, 80, "plan_dub", f"วางแผนเสร็จ ({len(render_cuts)} cuts) กำลัง render…")

        from arq import create_pool
        from arq.connections import RedisSettings
        from packages.core.settings import get_settings
        settings = get_settings()
        pool = await create_pool(RedisSettings.from_dsn(settings.redis_url))
        await pool.enqueue_job("render_video", job_id=job_id, project_uid=project_uid, tenant_slug=tenant_slug)
        await pool.close()

        return {"cuts": len(render_cuts)}
    except Exception as exc:
        ts = await _tenant_session(tenant_slug)
        try:
            if await _abort_if_cancelled(ts, project_uid, job_id):
                return {"cancelled": True}
            await _update_video(ts, project_uid, status="error", error_msg=str(exc))
        finally:
            await ts.close()
        await _update_job(
            job_id, "error", 0,
            result={"step": "error", "message": str(exc)},
            error=str(exc),
        )
        raise
    finally:
        await session.close()


# ── task: analyze_reference ──────────────────────────────────────────────────


async def analyze_reference(ctx: dict[str, Any], *, job_id: str, project_uid: str, tenant_slug: str) -> dict:
    """Extract Style Profile from uploaded reference clip. Saves to style_profile.json."""
    await _update_job(job_id, "running", 10, result={"step": "analyze", "message": "กำลังวิเคราะห์ reference clip…"})
    session = await _tenant_session(tenant_slug)
    try:
        from packages.video.style_profile import extract_style_profile

        root = data_root()
        proj = await _get_video_project(session, project_uid)
        if not proj.reference_clip_path:
            raise ValueError("reference_clip_path not set")

        ref_path = root / proj.reference_clip_path
        if not ref_path.exists():
            raise ValueError(f"Reference clip not found: {ref_path}")

        await _update_job(job_id, "running", 40, result={"step": "analyze", "message": "PySceneDetect + Claude Vision…"})
        profile = extract_style_profile(ref_path, use_vision=True)

        output_dir = root / "video_outputs" / project_uid
        output_dir.mkdir(parents=True, exist_ok=True)
        profile_path = output_dir / "style_profile.json"
        profile_path.write_text(json.dumps(profile, ensure_ascii=False, indent=2), encoding="utf-8")

        rel = str(profile_path.relative_to(root))
        await _update_video(session, project_uid, style_profile_path=rel)
        await _update_job(job_id, "ok", 100, result={"step": "done", "message": "วิเคราะห์ style เสร็จแล้ว", "profile": profile})
        return profile
    except Exception as exc:
        await _update_job(job_id, "error", 0, result={"step": "error", "message": str(exc)}, error=str(exc))
        raise
    finally:
        await session.close()


# ── WorkerSettings ────────────────────────────────────────────────────────────


async def startup(ctx: dict[str, Any]) -> None:
    from packages.core.settings import reload_settings
    from packages.llm.config import sync_llm_env

    settings = reload_settings()
    sync_llm_env()
    log.info(
        "worker_ctx_startup",
        llm_model=settings.llm_model,
        anthropic_key_set=bool(settings.anthropic_api_key),
    )
    try:
        configure_ffmpeg()
    except FileNotFoundError as exc:
        log.error("ffmpeg_not_found", error=str(exc))
    get_engine()


async def shutdown(ctx: dict[str, Any]) -> None:
    log.info("worker_shutdown")
    await get_engine().dispose()


class WorkerSettings:
    functions = [
        csv_export,
        csv_import,
        ai_process,
        ingest_video,
        plan_edit,
        render_video,
        analyze_dub_first,
        render_dub_silent,
        plan_dub_timeline,
        analyze_reference,
    ]
    on_startup = startup
    on_shutdown = shutdown
    max_jobs = 10
    # arq requires a numeric timeout (None breaks worker init). ~1 year = effectively unlimited.
    job_timeout = 86_400 * 365
    keep_result = 3600  # keep result in Redis 1h
