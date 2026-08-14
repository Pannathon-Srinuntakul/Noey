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
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from packages.core.logging import get_logger
from packages.core.errors import format_exception_message
from packages.db.models.core_auth import Job
from packages.db.session import bind_tenant_search_path, get_engine, get_sessionmaker
from packages.video.storage import data_root
from packages.video.ffmpeg_bin import configure_ffmpeg, has_audio_stream, hwaccel_input_kwargs, media_duration, run_ffmpeg, trim_media, video_encode_kwargs, video_stream_info
from packages.video.timeline import (
    normalize_dub_edit_script,
    filter_renderable_cuts,
    merge_dub_reedit_segments,
)

log = get_logger(__name__)

# ── context helpers ───────────────────────────────────────────────────────────


async def _core_session() -> AsyncSession:
    """Session with core schema search_path for job status updates."""
    maker = get_sessionmaker()
    session = maker()
    await session.execute(text("SET search_path TO core, public"))
    return session


async def _get_tenant_id_by_slug(tenant_slug: str) -> int | None:
    """Resolve tenant_slug → tenant.id (core schema). Returns None on miss."""
    from packages.db.models.core_auth import Tenant
    session = await _core_session()
    try:
        row = (
            await session.execute(select(Tenant).where(Tenant.slug == tenant_slug))
        ).scalar_one_or_none()
        return int(row.id) if row else None
    finally:
        await session.close()


def _set_video_usage_ctx(
    proj: Any, tenant_id: int | None, project_uid: str, feature: str = "video_cut"
) -> Any:
    """Set LLM usage context for a video task. Returns the context token to reset later.

    ``feature`` decides which task the tokens are reported under — see
    ``packages.llm.usage._TASK_BY_FEATURE``. Default is the cut/script planning
    bucket, which is what most video tasks do.
    """
    from packages.llm.usage import UsageCtx, set_usage_ctx
    if tenant_id is None:
        return None
    user_id = getattr(proj, "user_id", None)
    if user_id is None:
        return None
    return set_usage_ctx(
        UsageCtx(
            user_id=int(user_id),
            tenant_id=tenant_id,
            feature=feature,
            reference_id=project_uid,
        )
    )


async def _record_stt(transcript: dict[str, Any] | None) -> None:
    """Bill this run's transcribed audio to whoever triggered it.

    The ElevenLabs key is one shared account, so its own totals cover every
    user — per-user attribution can only happen here, against the UsageCtx the
    task already set.
    """
    if not transcript:
        return
    from packages.llm.usage import get_usage_ctx, record_stt_usage

    ctx = get_usage_ctx()
    if ctx is None:
        return
    await record_stt_usage(
        ctx,
        float(transcript.get("billed_audio_sec") or 0.0),
        str(transcript.get("stt_model") or ""),
    )


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
        await _update_job(job_id, "error", 0, error=format_exception_message(exc))
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
        await _update_job(job_id, "error", 0, error=format_exception_message(exc))
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
    thinking: str | None = None,
) -> None:
    """Update job progress with a human-readable step + message for the UI."""
    result: dict[str, str] = {"step": step, "message": message}
    if thinking:
        result["thinking"] = thinking
    await _update_job(
        job_id,
        status,
        progress,
        result=result,
    )


def _talking_transcribe_callbacks(
    job_id: str,
    *,
    base_progress: int,
    transcribe_span: int,
) -> Any:
    """Build the on_progress callback for elevenlabs_stt.run_transcription."""

    async def on_progress(phase: str, idx: int, total: int) -> None:
        if phase == "done":
            progress = base_progress + transcribe_span
            message = f"ถอดเสียงเสร็จ {total} คลิป"
        else:
            progress = int(base_progress + transcribe_span * idx / max(total, 1))
            message = f"กำลังถอดเสียงคลิป {idx + 1}/{total}…"
        await _video_progress(job_id, progress, "transcribe", message)

    return on_progress


def _project_keyterms(proj: Any) -> list[str]:
    """Product/brand names to bias Scribe towards, from the project's local_meta.

    Desktop clients may send ``local_meta.keyterms``; nothing else supplies them
    today, and an empty list means the (surcharged) keyterms field is omitted.
    """
    meta = getattr(proj, "local_meta", None) or {}
    terms = meta.get("keyterms") or []
    return [str(t) for t in terms if str(t).strip()] if isinstance(terms, list) else []


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


async def _pull_project_files(project_uid: str) -> None:
    """Ensure local disk has latest uploads + outputs (multi-worker / S3)."""
    from packages.video.s3 import pull_project_files

    await pull_project_files(project_uid)


async def _push_project_files(project_uid: str) -> None:
    """Publish uploads + outputs for the next worker replica (multi-worker / S3)."""
    from packages.video.s3 import push_project_files

    await push_project_files(project_uid)


# ── task: AI processing ───────────────────────────────────────────────────────


async def ai_process(
    ctx: dict[str, Any],
    *,
    job_id: str,
    prompt: str,
    user_id: int | None = None,
    tenant_id: int | None = None,
) -> dict:
    """Run an AI prompt in the background. Returns {answer: str}."""
    await _update_job(job_id, "running", 10)
    _usage_token = None
    try:
        from packages.llm.gateway import complete
        if user_id is not None and tenant_id is not None:
            from packages.llm.usage import UsageCtx, set_usage_ctx
            _usage_token = set_usage_ctx(
                UsageCtx(user_id=user_id, tenant_id=tenant_id, feature="prompt_cron", reference_id=job_id)
            )
        answer = await complete(prompt)
        result = {"answer": answer}
        await _update_job(job_id, "ok", 100, result=result)
        return result
    except Exception as exc:
        await _update_job(job_id, "error", 0, error=format_exception_message(exc))
        raise
    finally:
        if _usage_token is not None:
            from packages.llm.usage import reset_usage_ctx
            reset_usage_ctx(_usage_token)


# ── task: ingest_video ────────────────────────────────────────────────────────


async def ingest_video(ctx: dict[str, Any], *, job_id: str, project_uid: str, tenant_slug: str) -> dict:
    """Copy uploaded clips as-is and extract mono WAV for transcription."""
    log.info("task_start", task="ingest_video", project_uid=project_uid)
    await _video_progress(job_id, 5, "ingest", "กำลังเตรียมวิดีโอ…")
    session = await _tenant_session(tenant_slug)
    try:
        if await _abort_if_cancelled(session, project_uid, job_id):
            return {"cancelled": True}

        await _pull_project_files(project_uid)

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

        (output_dir / "upload_sources.json").write_text(
            json.dumps(source_files, ensure_ascii=False),
            encoding="utf-8",
        )

        norm_paths: list[str] = []
        total = len(source_files)
        total_dur_sec = 0.0
        is_dub_first = False
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

            clip_dur = media_duration(norm_out)
            if is_dub_first:
                from packages.video.scene import DUB_MAX_CLIP_SEC, dub_clip_exceeds_upload_limit

                if dub_clip_exceeds_upload_limit(clip_dur):
                    raise ValueError(
                        f"คลิป {i + 1}/{total} ยาว {int(clip_dur // 60)} น.{int(clip_dur % 60):02d} วิ "
                        f"— สูงสุด {DUB_MAX_CLIP_SEC // 60} นาที กรุณาตัดคลิปให้สั้นลง"
                    )
            else:
                from packages.video.timeline import TALKING_HEAD_MAX_TOTAL_SEC, talking_head_exceeds_total_limit

                if talking_head_exceeds_total_limit(clip_dur):
                    raise ValueError(
                        f"คลิป {i + 1}/{total} ยาว {clip_dur / 3600:.1f} ชม. "
                        f"— talking head รองรับสูงสุด {TALKING_HEAD_MAX_TOTAL_SEC // 3600} ชั่วโมงต่อโปรเจกต์ "
                        "(รวมทุกไฟล์)"
                    )
            total_dur_sec += clip_dur

            # Extract mono 16 kHz WAV + loudnorm for faster-whisper (talking_head only)
            if not is_dub_first:
                from packages.video.audio_extract import extract_speech_wav

                extract_speech_wav(src, audio_out)

        # Total across ALL clips, any clip count — per-clip cap above doesn't
        # stop many short clips adding up to hours of footage in one project.
        if is_dub_first:
            from packages.video.scene import DUB_FIRST_MAX_TOTAL_SEC, dub_project_exceeds_total_limit
            if dub_project_exceeds_total_limit(total_dur_sec):
                raise ValueError(
                    f"คลิปทั้งหมดรวมกันยาว {int(total_dur_sec // 60)} น.{int(total_dur_sec % 60):02d} วิ "
                    f"— โหมด Dub First รองรับสูงสุด {DUB_FIRST_MAX_TOTAL_SEC // 60} นาทีต่อโปรเจกต์ "
                    "กรุณาลดจำนวน/ความยาวคลิป"
                )
        else:
            from packages.video.timeline import TALKING_HEAD_MAX_TOTAL_SEC, talking_head_exceeds_total_limit

            if talking_head_exceeds_total_limit(total_dur_sec):
                raise ValueError(
                    f"คลิปทั้งหมดรวมกันยาว {int(total_dur_sec // 3600)} ชม. "
                    f"— รองรับสูงสุด {TALKING_HEAD_MAX_TOTAL_SEC // 3600} ชั่วโมงต่อโปรเจกต์ "
                    "กรุณาลดจำนวน/ความยาวคลิป"
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
            await _push_project_files(project_uid)
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
            await _update_video(ts, project_uid, status="error", error_msg=format_exception_message(exc))
        finally:
            await ts.close()
        await _update_job(
            job_id, "error", 0,
            result={"step": "error", "message": format_exception_message(exc)},
            error=format_exception_message(exc),
        )
        raise
    finally:
        await session.close()


# ── task: transcribe_video ────────────────────────────────────────────────────

from packages.video.elevenlabs_stt import (  # noqa: E402  (transcription core shared with local-render API)
    run_transcription,
)


async def transcribe_video(ctx: dict[str, Any], *, job_id: str, project_uid: str, tenant_slug: str) -> dict:
    """Transcribe audio with ElevenLabs Scribe."""
    log.info("task_start", task="transcribe_video", project_uid=project_uid)
    await _video_progress(job_id, 60, "transcribe", "กำลังถอดเสียง…")
    session = await _tenant_session(tenant_slug)
    try:
        if await _abort_if_cancelled(session, project_uid, job_id):
            return {"cancelled": True}

        await _pull_project_files(project_uid)

        root = data_root()
        output_dir = root / "video_outputs" / project_uid
        audio_dir = output_dir / "audio"

        audio_files = sorted(audio_dir.glob("audio_*.wav"))
        if not audio_files:
            raise ValueError("No audio files to transcribe")
        proj_for_terms = await _get_video_project(session, project_uid)

        # This task makes no LLM call, but the context is what tells
        # `_record_stt` whose transcription minutes these are.
        _set_video_usage_ctx(
            proj_for_terms,
            await _get_tenant_id_by_slug(tenant_slug),
            project_uid,
            feature="video_cut",
        )

        _t_progress = _talking_transcribe_callbacks(
            job_id, base_progress=60, transcribe_span=10,
        )

        async def _should_abort() -> bool:
            return await _abort_if_cancelled(session, project_uid, job_id)

        transcript = await run_transcription(
            audio_files,
            keyterms=_project_keyterms(proj_for_terms),
            project_uid=project_uid,
            on_progress=_t_progress,
            should_abort=_should_abort,
        )
        if transcript is None:
            return {"cancelled": True}
        await _record_stt(transcript)
        all_segments = transcript["segments"]

        transcript_path = output_dir / "transcript.json"
        transcript_path.write_text(json.dumps(transcript, ensure_ascii=False, indent=2), encoding="utf-8")

        rel_path = str(transcript_path.relative_to(root))
        await _update_video(session, project_uid, transcript_path=rel_path)
        await _video_progress(
            job_id, 70, "transcribe",
            f"ถอดเสียงเสร็จ ({len(all_segments)} ช่วง) กำลังประกอบไทม์ไลน์…",
        )

        log.info("transcribe_done", project_uid=project_uid, segments=len(all_segments))

        if await _abort_if_cancelled(session, project_uid, job_id):
            return {"cancelled": True}

        from arq import create_pool
        from arq.connections import RedisSettings
        from packages.core.settings import get_settings
        settings = get_settings()
        pool = await create_pool(RedisSettings.from_dsn(settings.redis_url))
        await _push_project_files(project_uid)
        await pool.enqueue_job("plan_edit", job_id=job_id, project_uid=project_uid, tenant_slug=tenant_slug)
        await pool.close()

        return {"segments": len(all_segments)}
    except Exception as exc:
        ts = await _tenant_session(tenant_slug)
        try:
            if await _abort_if_cancelled(ts, project_uid, job_id):
                return {"cancelled": True}
            await _update_video(ts, project_uid, status="error", error_msg=format_exception_message(exc))
        finally:
            await ts.close()
        await _update_job(
            job_id, "error", 0,
            result={"step": "error", "message": format_exception_message(exc)},
            error=format_exception_message(exc),
        )
        raise
    finally:
        await session.close()


from packages.video.plan_core import (  # noqa: E402  (planning core shared with local-render API)
    build_talking_head_timeline,
)


# ── task: plan_edit ───────────────────────────────────────────────────────────


async def plan_edit(ctx: dict[str, Any], *, job_id: str, project_uid: str, tenant_slug: str) -> dict:
    """Build Timeline JSON — full silence-cut, or AI highlight within target duration."""
    log.info("task_start", task="plan_edit", project_uid=project_uid)
    session = await _tenant_session(tenant_slug)
    _usage_token = None
    try:
        if await _abort_if_cancelled(session, project_uid, job_id):
            return {"cancelled": True}

        await _pull_project_files(project_uid)

        root = data_root()
        output_dir = root / "video_outputs" / project_uid

        proj = await _get_video_project(session, project_uid)
        tenant_id = await _get_tenant_id_by_slug(tenant_slug)
        _usage_token = _set_video_usage_ctx(proj, tenant_id, project_uid)

        duration_mode = proj.duration_mode  # "full" | "auto" | "custom"
        target_sec = proj.target_duration_sec  # set only when duration_mode == "custom"

        await _video_progress(job_id, 72, "plan", "กำลังประกอบไทม์ไลน์…")

        transcript_text = (root / proj.transcript_path).read_text(encoding="utf-8")
        transcript_data = json.loads(transcript_text)
        segments = transcript_data.get("segments", [])
        silence_gaps = transcript_data.get("silence_gaps", [])

        norm_dir = output_dir / "normalized"
        norm_files = sorted(norm_dir.glob("norm_*.*"))
        sources = [{"id": f"clip{i}", "file": f"normalized/{p.name}"} for i, p in enumerate(norm_files)]
        source_info = video_stream_info(norm_files[0]) if norm_files else {"width": 0, "height": 0, "fps": 30}
        clip_durations = [media_duration(p) for p in norm_files]

        async def _plan_progress(msg: str) -> None:
            await _video_progress(job_id, 73, "plan", msg)

        timeline = await build_talking_head_timeline(
            segments,
            duration_mode=duration_mode,
            target_duration_sec=target_sec,
            clip_durations=clip_durations,
            source_info=source_info,
            sources=sources,
            silence_gaps=silence_gaps,
            on_progress=_plan_progress,
        )
        render_cuts = timeline["timeline"]
        kept_sec = float(timeline["output"]["maxDurationSec"])
        target_sec = timeline["output"]["targetDurationSec"]
        edit_mode = timeline["editMode"]

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
        await _push_project_files(project_uid)
        await pool.enqueue_job("render_video", job_id=job_id, project_uid=project_uid, tenant_slug=tenant_slug)
        await pool.close()

        return {"cuts": cut_count}
    except Exception as exc:
        ts = await _tenant_session(tenant_slug)
        try:
            if await _abort_if_cancelled(ts, project_uid, job_id):
                return {"cancelled": True}
            await _update_video(ts, project_uid, status="error", error_msg=format_exception_message(exc))
        finally:
            await ts.close()
        await _update_job(
            job_id, "error", 0,
            result={"step": "error", "message": format_exception_message(exc)},
            error=format_exception_message(exc),
        )
        raise
    finally:
        await session.close()
        if _usage_token is not None:
            from packages.llm.usage import reset_usage_ctx
            reset_usage_ctx(_usage_token)


# ── task: render_video ────────────────────────────────────────────────────────

from packages.video.render_common import build_capcut_bundle, write_srt as _write_srt  # noqa: E402


async def render_video(ctx: dict[str, Any], *, job_id: str, project_uid: str, tenant_slug: str) -> dict:
    """Render final.mp4 from Timeline JSON, generate SRT, produce CapCut ZIP."""
    log.info("task_start", task="render_video", project_uid=project_uid)
    await _video_progress(job_id, 82, "render", "กำลังตัดคลิปตามแผน AI…")
    session = await _tenant_session(tenant_slug)
    try:
        import ffmpeg as ffmpeg_lib

        if await _abort_if_cancelled(session, project_uid, job_id):
            return {"cancelled": True}

        await _pull_project_files(project_uid)

        root = data_root()
        output_dir = root / "video_outputs" / project_uid
        clips_dir = output_dir / "clips"
        captions_dir = output_dir / "captions"
        clips_dir.mkdir(exist_ok=True)
        captions_dir.mkdir(exist_ok=True)
        for stale in clips_dir.glob("clip_*.mp4"):
            stale.unlink(missing_ok=True)

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
        # Actual rendered duration of each trimmed clip (post zoom/crop too) —
        # trim_media re-encodes to the nearest video frame, so the real output
        # duration can differ slightly from the requested cut["out"]-cut["in"].
        # Harmless for a few cuts, but accumulates across many and drifts
        # burned-in captions out of sync further into a long video. Caption
        # timing below uses these measured durations, not the requested ones.
        actual_durations: list[float] = []
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
            clip_out = clips_dir / f"clip_{i + 1:03d}.mp4"
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
                        _cinp = ffmpeg_lib2.input(str(clip_out), **hwaccel_input_kwargs())
                        run_ffmpeg(
                            ffmpeg_lib2.output(
                                _cinp.video.filter("crop", _crop["w"], _crop["h"], _crop["x"], _crop["y"]),
                                _cinp.audio,
                                str(_cropped),
                                **video_encode_kwargs(), acodec="copy",
                            ).overwrite_output(),
                            label=f"face_crop_{i}",
                        )
                        _cropped.replace(clip_out)
                except Exception as _fce:
                    log.warning("face_crop_failed", cut_idx=i, error=str(_fce))

            clip_paths.append(clip_out)
            actual_durations.append(media_duration(clip_out))

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
                from packages.video.dub_render import mux_voiceover

                final_with_vo = output_dir / "final_vo.mp4"
                mux_voiceover(final_path, vo_file, final_with_vo)
                final_with_vo.replace(final_path)

        # 3b. ASS karaoke caption burn-in — only when the timeline opts in (non-talking_head).
        _ass_burned = False
        if timeline.get("karaoke") and proj.transcript_path:
            try:
                from packages.video.caption import build_ass_karaoke, remap_words_to_output
                from packages.video.fonts import escape_ass_filter_path, fonts_dir

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

                    # Use each cut's ACTUAL rendered duration, not the requested
                    # in/out, so caption timing tracks the real concatenated
                    # video instead of drifting further out of sync per cut.
                    _rendered_cuts = [
                        {**c, "out": float(c["in"]) + actual_durations[_i]} for _i, c in enumerate(cuts)
                    ]
                    _output_dur = sum(actual_durations)
                    _remapped = remap_words_to_output(_all_words, _rendered_cuts, _clip_abs)
                    if _remapped:
                        await _video_progress(job_id, 93, "render", "กำลังเพิ่ม caption แบบ karaoke…")
                        ass_path = captions_dir / "subtitles.ass"
                        ass_path.write_text(
                            build_ass_karaoke(_remapped, _output_dur), encoding="utf-8"
                        )
                        _ass_filter = (
                            f"ass={escape_ass_filter_path(ass_path)}:"
                            f"fontsdir={escape_ass_filter_path(fonts_dir())}"
                        )
                        _final_captioned = output_dir / "final_captions.mp4"
                        run_ffmpeg(
                            ffmpeg_lib.input(str(final_path), **hwaccel_input_kwargs())
                            .output(
                                str(_final_captioned),
                                vf=_ass_filter,
                                acodec="copy",
                                **video_encode_kwargs(),
                            )
                            .overwrite_output(),
                            label="burn_captions",
                        )
                        _final_captioned.replace(final_path)
                        _ass_burned = True
            except Exception as _cap_exc:
                log.warning("caption_burn_failed", error=str(_cap_exc))

        # 4. SRT captions
        srt_path = captions_dir / "subtitles.srt"
        _write_srt(captions, srt_path)

        # 5-7. manifest.json + README.txt + ZIP bundle
        await _video_progress(job_id, 96, "render", "กำลังสร้าง CapCut bundle…")
        zip_path = build_capcut_bundle(
            output_dir,
            project_uid=project_uid,
            timeline=timeline,
            cuts=cuts,
            clip_paths=clip_paths,
            final_path=final_path,
            srt_path=srt_path,
            ass_burned=_ass_burned,
        )

        final_rel = str(final_path.relative_to(root))
        zip_rel = str(zip_path.relative_to(root))

        if await _abort_if_cancelled(session, project_uid, job_id):
            return {"cancelled": True}

        await _push_project_files(project_uid)

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
            await _update_video(ts, project_uid, status="error", error_msg=format_exception_message(exc))
        finally:
            await ts.close()
        await _update_job(
            job_id, "error", 0,
            result={"step": "error", "message": format_exception_message(exc)},
            error=format_exception_message(exc),
        )
        raise
    finally:
        await session.close()


# ── task: analyze_dub_first ──────────────────────────────────────────────────

from packages.video.dub_ai import (  # noqa: E402  (prompt + LLM cores shared with local-render API)
    DUB_EDIT_SYSTEM as _DUB_EDIT_SYSTEM_IMPORTED,
    DUB_EDIT_SYSTEM_VIDEO,
    DUB_EDIT_SYSTEM_VIDEO_NO_VO,
    DUB_TIMELINE_SYSTEM as _DUB_TIMELINE_SYSTEM_IMPORTED,
    generate_dub_edit_script,
    generate_dub_edit_script_video,
    generate_dub_reedit_script_video,
    plan_dub_timeline_cuts,
)

_DUB_EDIT_SYSTEM = _DUB_EDIT_SYSTEM_IMPORTED
_DUB_TIMELINE_SYSTEM = _DUB_TIMELINE_SYSTEM_IMPORTED


async def analyze_dub_first(ctx: dict[str, Any], *, job_id: str, project_uid: str, tenant_slug: str) -> dict:
    """1-step Claude Vision: write script + match scenes → render silent cut."""
    log.info("task_start", task="analyze_dub_first", project_uid=project_uid)
    await _video_progress(job_id, 52, "analyze", "กำลังวิเคราะห์วิดีโอ…")
    session = await _tenant_session(tenant_slug)
    _usage_token = None
    try:
        if await _abort_if_cancelled(session, project_uid, job_id):
            return {"cancelled": True}

        await _pull_project_files(project_uid)

        root = data_root()
        output_dir = root / "video_outputs" / project_uid
        frames_dir = output_dir / "frames"

        proj = await _get_video_project(session, project_uid)
        tenant_id = await _get_tenant_id_by_slug(tenant_slug)
        _usage_token = _set_video_usage_ctx(proj, tenant_id, project_uid)

        norm_files = sorted((output_dir / "normalized").glob("norm_*.*"))
        brief = proj.brief or ""
        user_script = proj.user_script or ""

        from packages.video.scene import extract_dub_budget_frames, extract_edge_frames

        # ── Single step: extract all frames → write script + match in one call ──
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
                from packages.video.ffmpeg_bin import media_duration
                from packages.video.scene import dub_scene_cap, dub_sample_frame_budget

                clip_dur = media_duration(norm_file)
                clip_frames_dir = frames_dir / f"clip{i}"
                scene_frames = extract_dub_budget_frames(
                    norm_file,
                    clip_frames_dir,
                    clip_id=clip_id,
                    duration_sec=clip_dur,
                )
                log.info(
                    "dub_sample_budget",
                    clip=clip_id,
                    duration_sec=round(clip_dur, 1),
                    scene_cap=dub_scene_cap(clip_dur),
                    max_frames=dub_sample_frame_budget(clip_dur),
                    extracted=len(scene_frames),
                )
                edge_frames = extract_edge_frames(norm_file, clip_frames_dir, clip_id=clip_id)
                opening = [f for f in edge_frames if f.get("edge") == "opening"]
                closing = [f for f in edge_frames if f.get("edge") == "closing"]
                all_frames.extend(opening + scene_frames + closing)
            except Exception as exc:
                log.warning("scene_extract_failed", clip=str(norm_file), error=str(exc))

        await _video_progress(job_id, 74, "analyze", "กำลัง match script กับซีนวิดีโอ…")

        async def _push_thinking(excerpt: str) -> None:
            await _update_job(
                job_id, "running", 74,
                result={"step": "analyze", "message": "กำลัง match script กับซีนวิดีโอ…", "thinking": excerpt},
            )

        edit_script = await generate_dub_edit_script(
            all_frames,
            brief=brief,
            user_script=user_script,
            target_duration_sec=getattr(proj, "target_duration_sec", None),
            project_uid=project_uid,
            on_thinking=_push_thinking,
        )

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
        await _push_project_files(project_uid)
        await pool.enqueue_job("render_dub_silent", job_id=job_id, project_uid=project_uid, tenant_slug=tenant_slug)
        await pool.close()

        await _video_progress(job_id, 78, "render", "Script พร้อมแล้ว กำลัง render คลิป…")
        return {"segments": len(edit_script.get("segments", []))}
    except Exception as exc:
        ts = await _tenant_session(tenant_slug)
        try:
            if await _abort_if_cancelled(ts, project_uid, job_id):
                return {"cancelled": True}
            await _update_video(ts, project_uid, status="error", error_msg=format_exception_message(exc))
        finally:
            await ts.close()
        await _update_job(
            job_id, "error", 0,
            result={"step": "error", "message": format_exception_message(exc)},
            error=format_exception_message(exc),
        )
        raise
    finally:
        await session.close()
        if _usage_token is not None:
            from packages.llm.usage import reset_usage_ctx
            reset_usage_ctx(_usage_token)


# ── task: render_dub_silent ──────────────────────────────────────────────────


async def render_dub_silent(ctx: dict[str, Any], *, job_id: str, project_uid: str, tenant_slug: str) -> dict:
    """Cut video silently from edit_script.json → final_silent.mp4 + script.txt + ZIP."""
    log.info("task_start", task="render_dub_silent", project_uid=project_uid)
    await _video_progress(job_id, 80, "render", "กำลังตัดวิดีโอตาม script…")
    session = await _tenant_session(tenant_slug)
    try:
        if await _abort_if_cancelled(session, project_uid, job_id):
            return {"cancelled": True}

        await _pull_project_files(project_uid)

        root = data_root()
        output_dir = root / "video_outputs" / project_uid
        clips_dir = output_dir / "clips"

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

        from packages.video.dub_render import (
            build_dub_bundle_zip,
            concat_stream_copy,
            prepare_clips_dir,
            trim_one_segment,
            write_dub_script_txt,
        )

        prepare_clips_dir(clips_dir)
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
            clip_paths.append(trim_one_segment(norm_files_sorted, seg, clips_dir, i, total))

        log.info("render_dub_silent_concat", project_uid=project_uid, clips=len(clip_paths))
        await _video_progress(job_id, 93, "render", "กำลังรวมคลิปเป็นวิดีโอเดียว…")

        final_path = output_dir / "final_silent.mp4"
        concat_stream_copy(clip_paths, final_path, output_dir / "concat_silent.txt")

        script_path = output_dir / "script.txt"
        write_dub_script_txt(segments, proj.brief, script_path)

        # Build ZIP
        await _video_progress(job_id, 96, "render", "กำลังสร้าง bundle…")
        zip_path = output_dir / "dub_bundle.zip"
        build_dub_bundle_zip(final_path, script_path, clip_paths, zip_path)

        final_rel = str(final_path.relative_to(root))
        zip_rel = str(zip_path.relative_to(root))

        await _push_project_files(project_uid)

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
            await _update_video(ts, project_uid, status="error", error_msg=format_exception_message(exc))
        finally:
            await ts.close()
        await _update_job(
            job_id, "error", 0,
            result={"step": "error", "message": format_exception_message(exc)},
            error=format_exception_message(exc),
        )
        raise
    finally:
        await session.close()


# ── task: plan_dub_timeline ───────────────────────────────────────────────────


async def plan_dub_timeline(ctx: dict[str, Any], *, job_id: str, project_uid: str, tenant_slug: str) -> dict:
    """Load Edit Script + VO file → Claude → Timeline JSON → enqueue render_video."""
    await _video_progress(job_id, 5, "plan_dub", "กำลังวางแผน timeline ตาม voiceover…")
    session = await _tenant_session(tenant_slug)
    _usage_token = None
    try:
        if await _abort_if_cancelled(session, project_uid, job_id):
            return {"cancelled": True}

        await _pull_project_files(project_uid)

        root = data_root()
        output_dir = root / "video_outputs" / project_uid

        proj = await _get_video_project(session, project_uid)
        tenant_id = await _get_tenant_id_by_slug(tenant_slug)
        _usage_token = _set_video_usage_ctx(proj, tenant_id, project_uid)

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

        # Build full timeline.json (same schema as talking_head)
        from packages.video.ffmpeg_bin import video_stream_info
        norm_files = sorted((output_dir / "normalized").glob("norm_*.*"))
        sources = [{"id": f"clip{i}", "file": f"normalized/{p.name}"} for i, p in enumerate(norm_files)]
        source_info = video_stream_info(norm_files[0]) if norm_files else {"width": 0, "height": 0, "fps": 30}

        from packages.video.ffmpeg_bin import media_duration as _dur

        clip_durations = [_dur(p) for p in norm_files]
        render_cuts = await plan_dub_timeline_cuts(edit_script, vo_duration, clip_durations)

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
        await _push_project_files(project_uid)
        await pool.enqueue_job("render_video", job_id=job_id, project_uid=project_uid, tenant_slug=tenant_slug)
        await pool.close()

        return {"cuts": len(render_cuts)}
    except Exception as exc:
        ts = await _tenant_session(tenant_slug)
        try:
            if await _abort_if_cancelled(ts, project_uid, job_id):
                return {"cancelled": True}
            await _update_video(ts, project_uid, status="error", error_msg=format_exception_message(exc))
        finally:
            await ts.close()
        await _update_job(
            job_id, "error", 0,
            result={"step": "error", "message": format_exception_message(exc)},
            error=format_exception_message(exc),
        )
        raise
    finally:
        await session.close()
        if _usage_token is not None:
            from packages.llm.usage import reset_usage_ctx
            reset_usage_ctx(_usage_token)


# The `analyze_reference` task was removed 2026-08-14 together with its route
# and packages/video/style_profile.py: the Style Profile JSON it produced was
# never read by any planner. Distilling a reference clip is now Effect/Cut
# Styles' job (packages/video/effects_style.py, cut_style.py), which stores
# prose that IS spliced into the prompts.


# ── task: analyze_dub_local ──────────────────────────────────────────────────


async def analyze_dub_local(ctx: dict[str, Any], *, job_id: str, project_uid: str, tenant_slug: str) -> dict:
    """Local-render (desktop) variant of analyze_dub_first.

    The desktop app already extracted frames locally and uploaded the JPEGs +
    frames_manifest.json via POST /videos/{uid}/analyze-frames — no video files
    exist on the server. This task only runs the Vision call and stores
    edit_script.json; the desktop app then renders silently on the user's machine.
    """
    log.info("task_start", task="analyze_dub_local", project_uid=project_uid)
    await _video_progress(job_id, 20, "analyze", "กำลังวิเคราะห์ frames…")
    session = await _tenant_session(tenant_slug)
    _usage_token = None
    try:
        if await _abort_if_cancelled(session, project_uid, job_id):
            return {"cancelled": True}

        await _pull_project_files(project_uid)

        root = data_root()
        output_dir = root / "video_outputs" / project_uid
        manifest_file = output_dir / "frames" / "frames_manifest.json"
        if not manifest_file.is_file():
            raise ValueError("frames_manifest.json missing — upload frames first")

        proj = await _get_video_project(session, project_uid)
        tenant_id = await _get_tenant_id_by_slug(tenant_slug)
        _usage_token = _set_video_usage_ctx(proj, tenant_id, project_uid)

        records = json.loads(manifest_file.read_text(encoding="utf-8"))
        all_frames: list[dict[str, Any]] = []
        for rec in records:
            frame_path = output_dir / rec["file"]
            if not frame_path.is_file():
                log.warning("local_frame_missing", file=rec["file"], project_uid=project_uid)
                continue
            all_frames.append({**rec, "frame_path": str(frame_path)})
        if not all_frames:
            raise ValueError("No usable frames found in manifest")

        await _video_progress(job_id, 74, "analyze", "กำลัง match script กับซีนวิดีโอ…")

        async def _push_thinking(excerpt: str) -> None:
            await _update_job(
                job_id, "running", 74,
                result={"step": "analyze", "message": "กำลัง match script กับซีนวิดีโอ…", "thinking": excerpt},
            )

        edit_script = await generate_dub_edit_script(
            all_frames,
            brief=proj.brief or "",
            user_script=proj.user_script or "",
            target_duration_sec=getattr(proj, "target_duration_sec", None),
            project_uid=project_uid,
            music_beats=proj.music_beats,
            on_thinking=_push_thinking,
        )

        edit_script_path = output_dir / "edit_script.json"
        edit_script_path.write_text(
            json.dumps(edit_script, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        rel = str(edit_script_path.relative_to(root))
        # Desktop app renders locally from here; server-side status parks at waiting_vo.
        await _update_video(session, project_uid, edit_script_path=rel, status="waiting_vo")
        await _push_project_files(project_uid)

        segments = len(edit_script.get("segments", []))
        await _update_job(
            job_id, "ok", 100,
            result={"step": "edit_script_ready", "message": "Edit script พร้อมแล้ว", "segments": segments},
        )
        log.info("analyze_dub_local_done", project_uid=project_uid, segments=segments)
        return {"segments": segments}
    except Exception as exc:
        ts = await _tenant_session(tenant_slug)
        try:
            if await _abort_if_cancelled(ts, project_uid, job_id):
                return {"cancelled": True}
            await _update_video(ts, project_uid, status="error", error_msg=format_exception_message(exc))
        finally:
            await ts.close()
        await _update_job(
            job_id, "error", 0,
            result={"step": "error", "message": format_exception_message(exc)},
            error=format_exception_message(exc),
        )
        raise
    finally:
        await session.close()
        if _usage_token is not None:
            from packages.llm.usage import reset_usage_ctx
            reset_usage_ctx(_usage_token)


# ── task: analyze_dub_video_local ────────────────────────────────────────────


async def analyze_dub_video_local(
    ctx: dict[str, Any],
    *,
    job_id: str,
    project_uid: str,
    tenant_slug: str,
    style_uid: str = "",
) -> dict:
    """Local-render (desktop) dub_first variant using Gemini native video.

    The desktop sidecar already encoded a downscaled, no-audio proxy MP4 per
    clip and uploaded them + proxy_manifest.json via POST
    /videos/{uid}/analyze-video — no frame JPEGs involved. This task runs the
    Gemini video Vision call and stores edit_script.json; the desktop app then
    renders silently on the user's machine. Parallel to analyze_dub_local
    (frame path), which stays unchanged for the Claude path.

    ``style_uid`` — an optional kind="cut" EffectStyle whose distilled prose
    steers the edit-script prompt. Resolved from the DB only — never persisted
    to disk/S3 (a stale style file from a previous attempt must not override
    the user's current choice; see plan_effects_local's 2026-07-18 note).
    """
    log.info("task_start", task="analyze_dub_video_local", project_uid=project_uid)
    await _video_progress(job_id, 20, "analyze", "กำลังส่งวิดีโอให้ AI วิเคราะห์…")
    session = await _tenant_session(tenant_slug)
    _usage_token = None
    try:
        if await _abort_if_cancelled(session, project_uid, job_id):
            return {"cancelled": True}

        await _pull_project_files(project_uid)

        root = data_root()
        output_dir = root / "video_outputs" / project_uid
        manifest_file = output_dir / "proxy" / "proxy_manifest.json"
        if not manifest_file.is_file():
            raise ValueError("proxy_manifest.json missing — upload proxies first")

        proj = await _get_video_project(session, project_uid)
        tenant_id = await _get_tenant_id_by_slug(tenant_slug)
        _usage_token = _set_video_usage_ctx(proj, tenant_id, project_uid)

        # Cut style: DB is the only source — no style file on disk/S3.
        style_prompt = ""
        chosen = (style_uid or "").strip()
        if chosen:
            from packages.db.models.effect_style import EffectStyle

            style = await session.get(EffectStyle, chosen)
            if style is not None and style.kind == "cut" and style.system_prompt:
                style_prompt = style.system_prompt
                log.info(
                    "cut_style_applied",
                    project_uid=project_uid,
                    style_uid=chosen,
                    style_name=style.name,
                    prompt_chars=len(style_prompt),
                )
            else:
                log.warning("cut_style_uid_unresolved", project_uid=project_uid, style_uid=chosen)

        records = json.loads(manifest_file.read_text(encoding="utf-8"))
        records.sort(key=lambda r: int(r.get("order") or 0))
        clip_videos: list[tuple[str, pathlib.Path, float]] = []
        for rec in records:
            proxy_path = output_dir / "proxy" / rec["file"]
            if not proxy_path.is_file():
                log.warning("local_proxy_missing", file=rec["file"], project_uid=project_uid)
                continue
            clip_videos.append((rec["clip_id"], proxy_path, float(rec.get("durationSec") or 0)))
        if not clip_videos:
            raise ValueError("No usable proxy clips found in manifest")

        await _video_progress(job_id, 74, "analyze", "กำลัง match script กับซีนวิดีโอ…")

        async def _push_thinking(excerpt: str) -> None:
            await _update_job(
                job_id, "running", 74,
                result={"step": "analyze", "message": "กำลัง match script กับซีนวิดีโอ…", "thinking": excerpt},
            )

        edit_script = await generate_dub_edit_script_video(
            clip_videos,
            brief=proj.brief or "",
            user_script=proj.user_script or "",
            target_duration_sec=getattr(proj, "target_duration_sec", None),
            project_uid=project_uid,
            music_beats=proj.music_beats,
            system=DUB_EDIT_SYSTEM_VIDEO_NO_VO if proj.mode == "highlight" else DUB_EDIT_SYSTEM_VIDEO,
            style_prompt=style_prompt,
            on_thinking=_push_thinking,
        )

        # Belt-and-suspenders: the no-VO prompt instructs the model to omit
        # voiceoverScript, but the schema still technically allows it (live
        # report 2026-07-19: model added real Thai narration to a highlight
        # project anyway on one run) — strip it server-side so "highlight"
        # never leaks a script regardless of what the model decided to do.
        if proj.mode == "highlight":
            for seg in edit_script.get("segments", []):
                seg.pop("voiceoverScript", None)

        edit_script_path = output_dir / "edit_script.json"
        edit_script_path.write_text(
            json.dumps(edit_script, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        rel = str(edit_script_path.relative_to(root))
        # Desktop app renders locally from here; server-side status parks at waiting_vo.
        await _update_video(session, project_uid, edit_script_path=rel, status="waiting_vo")
        await _push_project_files(project_uid)

        segments = len(edit_script.get("segments", []))
        await _update_job(
            job_id, "ok", 100,
            result={"step": "edit_script_ready", "message": "Edit script พร้อมแล้ว", "segments": segments},
        )
        log.info("analyze_dub_video_local_done", project_uid=project_uid, segments=segments)
        return {"segments": segments}
    except Exception as exc:
        ts = await _tenant_session(tenant_slug)
        try:
            if await _abort_if_cancelled(ts, project_uid, job_id):
                return {"cancelled": True}
            await _update_video(ts, project_uid, status="error", error_msg=format_exception_message(exc))
        finally:
            await ts.close()
        await _update_job(
            job_id, "error", 0,
            result={"step": "error", "message": format_exception_message(exc)},
            error=format_exception_message(exc),
        )
        raise
    finally:
        await session.close()
        if _usage_token is not None:
            from packages.llm.usage import reset_usage_ctx
            reset_usage_ctx(_usage_token)


# ── task: plan_effects_local ─────────────────────────────────────────────────


async def plan_effects_local(
    ctx: dict[str, Any],
    *,
    job_id: str,
    project_uid: str,
    tenant_slug: str,
    style_uid: str = "",
    use_previous: bool = False,
) -> dict:
    """AI-assisted effects placement for a local-render project.

    The desktop app uploaded a downscaled proxy of the finished cut video
    (effects/cut_proxy.mp4) plus an optional free-text instruction
    (effects/prompt.txt) via POST /videos/{uid}/plan-effects. This task runs the
    Gemini motion-placement pass and stores effects.json; the desktop then
    bakes those ffmpeg transforms into the footage locally. No cut/timeline is
    touched.

    ``style_uid`` — the EffectStyle the desktop selected for THIS run. Re-applied
    from the DB after S3 pull so a stale ``effects/style.txt`` from a previous
    attempt cannot silently override the user's choice.

    ``use_previous`` — whether to feed a pre-existing effects.json to the model
    as ``<previous_attempt>`` (the "แก้ไข AI" edit flow). False (the fresh-start
    "ให้ AI จัดทั้งคลิป" flow) always ignores any existing effects.json.
    """
    from packages.video.effects_ai import generate_effects_placement

    log.info(
        "task_start",
        task="plan_effects_local",
        project_uid=project_uid,
        style_uid=style_uid or None,
    )
    await _video_progress(job_id, 20, "effects", "กำลังส่งวิดีโอให้ AI วางเอฟเฟกต์…")
    session = await _tenant_session(tenant_slug)
    _usage_token = None
    try:
        if await _abort_if_cancelled(session, project_uid, job_id):
            return {"cancelled": True}

        await _pull_project_files(project_uid)

        root = data_root()
        output_dir = root / "video_outputs" / project_uid
        proxy = output_dir / "effects" / "cut_proxy.mp4"
        if not proxy.is_file():
            raise ValueError("cut_proxy.mp4 missing — upload the cut video proxy first")

        prompt_file = output_dir / "effects" / "prompt.txt"
        user_prompt = prompt_file.read_text(encoding="utf-8") if prompt_file.is_file() else ""

        # Timed voiceover/transcript lines (desktop builds this from the dub edit
        # script or talking_head caption lines) — lets the AI match effects to the
        # actual spoken words, not just what's visually on screen.
        script_file = output_dir / "effects" / "script.txt"
        script_lines = script_file.read_text(encoding="utf-8") if script_file.is_file() else ""

        # Style: DB wins over whatever S3 pull dropped into style.txt. A prior
        # run's zoom-hold prose used to resurrect here when the user had cleared
        # or changed the selection (push never deletes S3 orphans).
        style_file = output_dir / "effects" / "style.txt"
        style_prompt = ""
        chosen = (style_uid or "").strip()
        if chosen:
            from packages.db.models.effect_style import EffectStyle

            style = await session.get(EffectStyle, chosen)
            if style is not None and style.system_prompt:
                style_file.parent.mkdir(parents=True, exist_ok=True)
                style_file.write_text(style.system_prompt, encoding="utf-8")
                style_prompt = style.system_prompt
                log.info(
                    "effects_style_applied",
                    project_uid=project_uid,
                    style_uid=chosen,
                    style_name=style.name,
                    prompt_chars=len(style_prompt),
                )
            else:
                style_file.unlink(missing_ok=True)
                log.warning(
                    "effects_style_uid_unresolved",
                    project_uid=project_uid,
                    style_uid=chosen,
                )
        else:
            style_file.unlink(missing_ok=True)
            log.info("effects_style_cleared", project_uid=project_uid)

        # Optional style-reference video/image — named by real extension
        # (glob since we don't know the suffix upfront).
        reference_path = next((output_dir / "effects").glob("reference.*"), None)

        # Real scene-cut timestamps (output-timeline seconds) the desktop client
        # derives from its own edit script/timeline — lets the AI place a
        # `transitions` whip-pan sweep AT an actual cut boundary. Optional; a
        # project with no cuts.json simply never gets transitions placed.
        cuts_file = output_dir / "effects" / "cuts.json"
        cut_points_sec: list[float] | None = None
        if cuts_file.is_file():
            try:
                raw_cuts = json.loads(cuts_file.read_text(encoding="utf-8"))
                if isinstance(raw_cuts, list):
                    cut_points_sec = [float(c) for c in raw_cuts if isinstance(c, (int, float))]
            except (OSError, json.JSONDecodeError, TypeError, ValueError):
                cut_points_sec = None

        proj = await _get_video_project(session, project_uid)
        tenant_id = await _get_tenant_id_by_slug(tenant_slug)
        _usage_token = _set_video_usage_ctx(proj, tenant_id, project_uid, feature="video_effects")

        async def _push_thinking(excerpt: str) -> None:
            await _update_job(
                job_id, "running", 74,
                result={"step": "effects", "message": "กำลังเลือกและวางเอฟเฟกต์…", "thinking": excerpt},
            )

        # A pre-existing effects.json means this COULD be a regenerate — but
        # only feed it to the model as <previous_attempt> when the client
        # explicitly asked for the edit flow (use_previous). The fresh-start
        # flow must stay a genuinely clean slate even if a prior attempt is
        # still sitting on disk.
        previous_doc: dict | None = None
        if use_previous:
            prev_path = output_dir / "effects.json"
            if prev_path.is_file():
                try:
                    previous_doc = json.loads(prev_path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    previous_doc = None

        await _video_progress(job_id, 74, "effects", "กำลังเลือกและวางเอฟเฟกต์…")
        doc = await generate_effects_placement(
            proxy,
            brief=proj.brief or "",
            user_prompt=user_prompt,
            script_lines=script_lines,
            project_uid=project_uid,
            previous_doc=previous_doc,
            reference_path=reference_path,
            cut_points_sec=cut_points_sec,
            style_prompt=style_prompt,
            on_thinking=_push_thinking,
        )

        effects_path = output_dir / "effects.json"
        effects_path.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
        await _push_project_files(project_uid)

        count = len(doc.get("instances", []))
        await _update_job(
            job_id, "ok", 100,
            result={"step": "effects_ready", "message": "วางเอฟเฟกต์เสร็จแล้ว", "instances": count, "effects": doc},
        )
        log.info("plan_effects_local_done", project_uid=project_uid, instances=count)
        return {"instances": count}
    except Exception as exc:
        await _update_job(
            job_id, "error", 0,
            result={"step": "error", "message": format_exception_message(exc)},
            error=format_exception_message(exc),
        )
        raise
    finally:
        await session.close()
        if _usage_token is not None:
            from packages.llm.usage import reset_usage_ctx
            reset_usage_ctx(_usage_token)


# ── task: distill_style_local ────────────────────────────────────────────────


async def distill_style_local(ctx: dict[str, Any], *, job_id: str, style_uid: str, tenant_slug: str) -> dict:
    """Distil a saved EffectStyle's reference clip + description into reusable
    style-guide prose (packages/video/effects_style.py), store it on the row.

    Enqueued by POST /effect-styles (create) and /effect-styles/{uid}/regenerate
    (see ``_enqueue`` in videos.py — it always forwards ``job_id`` as a task
    kwarg, so every task fn must declare it even when, as here, it's derivable
    from other args; every other *_local task follows this same convention).
    The desktop polls this same Job id for completion.
    """
    from packages.db.models.effect_style import EffectStyle
    from packages.video.effects_style import distill_style_prompt

    log.info("task_start", task="distill_style_local", style_uid=style_uid)
    await _update_job(job_id, "running", 20, result={"step": "style", "message": "กำลังวิเคราะห์สไตล์…"})
    session = await _tenant_session(tenant_slug)
    _usage_token = None
    try:
        style = await session.get(EffectStyle, style_uid)
        if style is None:
            raise ValueError(f"effect style not found: {style_uid}")

        ref_path = None
        if style.reference_clip_path:
            candidate = data_root() / style.reference_clip_path
            if candidate.is_file():
                ref_path = candidate

        tenant_id = await _get_tenant_id_by_slug(tenant_slug)
        _usage_token = _set_video_usage_ctx(style, tenant_id, style_uid, feature="video_style")

        async def _push_thinking(excerpt: str) -> None:
            await _update_job(
                job_id, "running", 60,
                result={"step": "style", "message": "กำลังวิเคราะห์สไตล์…", "thinking": excerpt},
            )

        if style.kind == "cut":
            from packages.video.cut_style import distill_cut_style_prompt

            guide = await distill_cut_style_prompt(
                ref_path, style.description or "",
                target_platform=style.target_platform or "",
                project_uid=style_uid, on_thinking=_push_thinking,
            )
        else:
            guide = await distill_style_prompt(
                ref_path, style.description or "",
                project_uid=style_uid, on_thinking=_push_thinking,
            )

        style.system_prompt = guide
        style.status = "ready"
        style.error_msg = None
        await session.commit()

        await _update_job(
            job_id, "ok", 100,
            result={"step": "style_ready", "message": "วิเคราะห์สไตล์เสร็จแล้ว", "style_uid": style_uid},
        )
        log.info("distill_style_local_done", style_uid=style_uid, chars=len(guide))
        return {"style_uid": style_uid}
    except Exception as exc:
        try:
            style = await session.get(EffectStyle, style_uid)
            if style is not None:
                style.status = "error"
                style.error_msg = format_exception_message(exc)
                await session.commit()
        except Exception:  # noqa: BLE001 — best-effort status write
            pass
        await _update_job(
            job_id, "error", 0,
            result={"step": "error", "message": format_exception_message(exc)},
            error=format_exception_message(exc),
        )
        raise
    finally:
        await session.close()
        if _usage_token is not None:
            from packages.llm.usage import reset_usage_ctx
            reset_usage_ctx(_usage_token)


# ── task: reedit_dub_scenes_local ────────────────────────────────────────────


async def reedit_dub_scenes_local(
    ctx: dict[str, Any],
    *,
    job_id: str,
    project_uid: str,
    tenant_slug: str,
    style_uid: str = "",
) -> dict:
    """AI-assisted re-edit of an existing dub_first edit script (desktop only).

    Reviews the CURRENT edit script + a freshly-encoded preview of the live
    (possibly unsaved) editor state + all raw source clip proxies, against a
    free-form creator instruction. Scoped to selected voiceoverLineIds if any
    were marked; otherwise the whole script is in scope (see
    packages/video/dub_ai.py:DUB_REEDIT_SYSTEM_VIDEO). Splices the result back
    into edit_script.json rather than overwriting it wholesale — see
    packages/video/timeline.py:merge_dub_reedit_segments.

    ``style_uid`` — an optional kind="cut" EffectStyle whose distilled prose
    steers the re-edit prompt. Resolved from the DB only — never persisted to
    disk/S3 (a stale style file from a previous attempt must not override the
    user's current choice; see plan_effects_local's 2026-07-18 note).
    """
    log.info("task_start", task="reedit_dub_scenes_local", project_uid=project_uid)
    await _video_progress(job_id, 20, "analyze", "กำลังเตรียมข้อมูลให้ AI…")
    session = await _tenant_session(tenant_slug)
    _usage_token = None
    try:
        if await _abort_if_cancelled(session, project_uid, job_id):
            return {"cancelled": True}

        await _pull_project_files(project_uid)

        root = data_root()
        output_dir = root / "video_outputs" / project_uid
        proj = await _get_video_project(session, project_uid)
        if not proj.edit_script_path:
            raise ValueError("edit_script_path missing — run analyze first")
        edit_script = json.loads((root / proj.edit_script_path).read_text(encoding="utf-8"))

        proxy_manifest_file = output_dir / "proxy" / "proxy_manifest.json"
        if not proxy_manifest_file.is_file():
            raise ValueError("proxy_manifest.json missing — run analyze first")
        proxy_records = json.loads(proxy_manifest_file.read_text(encoding="utf-8"))
        proxy_records.sort(key=lambda r: int(r.get("order") or 0))
        clip_videos: list[tuple[str, pathlib.Path, float]] = []
        for rec in proxy_records:
            proxy_path = output_dir / "proxy" / rec["file"]
            if not proxy_path.is_file():
                log.warning("reedit_proxy_missing", file=rec["file"], project_uid=project_uid)
                continue
            clip_videos.append((rec["clip_id"], proxy_path, float(rec.get("durationSec") or 0)))
        if not clip_videos:
            raise ValueError("No usable proxy clips found in manifest")

        preview_path = output_dir / "ai_reedit" / "edited_preview.mp4"
        if not preview_path.is_file():
            raise ValueError("edited_preview.mp4 missing — desktop must render a live preview first")
        request_file = output_dir / "ai_reedit" / "reedit_request.json"
        request = json.loads(request_file.read_text(encoding="utf-8")) if request_file.is_file() else {}
        selected_line_ids = [int(x) for x in (request.get("selectedLineIds") or [])]
        instruction = str(request.get("instruction") or "").strip()
        if not instruction:
            raise ValueError("instruction missing")

        tenant_id = await _get_tenant_id_by_slug(tenant_slug)
        _usage_token = _set_video_usage_ctx(proj, tenant_id, project_uid)

        # Cut style: DB is the only source — no style file on disk/S3.
        style_prompt = ""
        chosen = (style_uid or "").strip()
        if chosen:
            from packages.db.models.effect_style import EffectStyle

            style = await session.get(EffectStyle, chosen)
            if style is not None and style.kind == "cut" and style.system_prompt:
                style_prompt = style.system_prompt
                log.info(
                    "cut_style_applied",
                    project_uid=project_uid,
                    style_uid=chosen,
                    style_name=style.name,
                    prompt_chars=len(style_prompt),
                )
            else:
                log.warning("cut_style_uid_unresolved", project_uid=project_uid, style_uid=chosen)

        await _video_progress(job_id, 74, "analyze", "กำลังแก้ไขตามคำสั่ง…")

        async def _push_thinking(excerpt: str) -> None:
            await _update_job(
                job_id, "running", 74,
                result={"step": "analyze", "message": "กำลังแก้ไขตามคำสั่ง…", "thinking": excerpt},
            )

        new_segments = await generate_dub_reedit_script_video(
            clip_videos,
            (preview_path, media_duration(preview_path)),
            current_segments=edit_script.get("segments", []),
            selected_line_ids=selected_line_ids,
            instruction=instruction,
            project_uid=project_uid,
            music_beats=proj.music_beats,
            target_duration_sec=getattr(proj, "target_duration_sec", None),
            style_prompt=style_prompt,
            on_thinking=_push_thinking,
        )

        merged = merge_dub_reedit_segments(edit_script, selected_line_ids, new_segments)

        edit_script_path = output_dir / "edit_script.json"
        edit_script_path.write_text(
            json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        rel = str(edit_script_path.relative_to(root))
        await _update_video(session, project_uid, edit_script_path=rel, status="waiting_vo")
        await _push_project_files(project_uid)

        segments = merged.get("segments", [])
        await _update_job(
            job_id, "ok", 100,
            result={"step": "edit_script_ready", "message": "แก้ไขเรียบร้อยแล้ว", "segments": segments},
        )
        log.info("reedit_dub_scenes_local_done", project_uid=project_uid, segments=len(segments))
        return {"segments": len(segments)}
    except Exception as exc:
        ts = await _tenant_session(tenant_slug)
        try:
            if await _abort_if_cancelled(ts, project_uid, job_id):
                return {"cancelled": True}
            await _update_video(ts, project_uid, status="error", error_msg=format_exception_message(exc))
        finally:
            await ts.close()
        await _update_job(
            job_id, "error", 0,
            result={"step": "error", "message": format_exception_message(exc)},
            error=format_exception_message(exc),
        )
        raise
    finally:
        await session.close()
        if _usage_token is not None:
            from packages.llm.usage import reset_usage_ctx
            reset_usage_ctx(_usage_token)


# ── task: plan_talking_local ─────────────────────────────────────────────────


async def plan_talking_local(ctx: dict[str, Any], *, job_id: str, project_uid: str, tenant_slug: str) -> dict:
    """Local-render (desktop) talking_head: transcribe uploaded WAVs + plan timeline.

    The desktop app extracted the speech WAVs (+ optional downscaled proxy MP4s,
    with audio, for Gemini's per-clip video review) locally and uploaded them via
    POST /videos/{uid}/transcribe-audio. This task runs Whisper + Gemini's review
    and stores transcript.json + timeline.json; the desktop app then renders
    locally — only the small proxy clips ever leave the device, never the
    original full-quality footage.
    """
    log.info("task_start", task="plan_talking_local", project_uid=project_uid)
    await _video_progress(job_id, 10, "transcribe", "กำลังโหลดโมเดล Whisper…")
    session = await _tenant_session(tenant_slug)
    _usage_token = None
    try:
        if await _abort_if_cancelled(session, project_uid, job_id):
            return {"cancelled": True}

        await _pull_project_files(project_uid)

        root = data_root()
        output_dir = root / "video_outputs" / project_uid
        audio_files = sorted((output_dir / "audio").glob("audio_*.wav"))
        if not audio_files:
            raise ValueError("No audio files to transcribe — upload them first")
        proj = await _get_video_project(session, project_uid)
        tenant_id = await _get_tenant_id_by_slug(tenant_slug)
        _usage_token = _set_video_usage_ctx(proj, tenant_id, project_uid)

        clips_meta = (proj.local_meta or {}).get("clips", [])
        if not clips_meta:
            raise ValueError("local_meta.clips missing — create the project with clip metadata")

        _t_progress = _talking_transcribe_callbacks(
            job_id, base_progress=10, transcribe_span=45,
        )

        async def _t_abort() -> bool:
            return await _abort_if_cancelled(session, project_uid, job_id)

        transcript = await run_transcription(
            audio_files,
            keyterms=_project_keyterms(proj),
            project_uid=project_uid,
            on_progress=_t_progress,
            should_abort=_t_abort,
        )
        if transcript is None:
            return {"cancelled": True}
        await _record_stt(transcript)

        transcript_path = output_dir / "transcript.json"
        transcript_path.write_text(json.dumps(transcript, ensure_ascii=False, indent=2), encoding="utf-8")
        await _update_video(session, project_uid, transcript_path=str(transcript_path.relative_to(root)))

        await _video_progress(job_id, 60, "plan", "กำลังประกอบไทม์ไลน์…")
        segments = transcript["segments"]
        silence_gaps = transcript.get("silence_gaps", [])

        clip_durations = [float(c["durationSec"]) for c in clips_meta]
        first = clips_meta[0]
        source_info = {
            "width": int(first.get("width", 0)),
            "height": int(first.get("height", 0)),
            "fps": int(first.get("fps", 30)),
        }
        sources = [
            {"id": str(c["id"]), "file": f"normalized/norm_{i:03d}.mp4"}
            for i, c in enumerate(clips_meta)
        ]

        async def _p_progress(msg: str) -> None:
            await _video_progress(job_id, 70, "plan", msg)

        timeline = await build_talking_head_timeline(
            segments,
            duration_mode=proj.duration_mode,
            target_duration_sec=proj.target_duration_sec,
            clip_durations=clip_durations,
            source_info=source_info,
            sources=sources,
            silence_gaps=silence_gaps,
            on_progress=_p_progress,
        )

        # Flattened word-level timestamps (source-timeline, absolute) so the
        # desktop app can burn in captions locally via remap_words_to_output —
        # dropped otherwise, since build_talking_head_timeline only keeps
        # segment-level plain-text captions.
        timeline["words"] = [
            {"word": w["word"], "start": w["start"], "end": w["end"]}
            for seg in segments
            for w in seg.get("words", [])
        ]
        timeline["captionStyle"] = proj.caption_style

        timeline_path = output_dir / "timeline.json"
        timeline_path.write_text(json.dumps(timeline, ensure_ascii=False, indent=2), encoding="utf-8")
        await _update_video(session, project_uid, timeline_path=str(timeline_path.relative_to(root)))
        await _push_project_files(project_uid)

        cut_count = len(timeline["timeline"])
        await _update_job(
            job_id, "ok", 100,
            result={
                "step": "timeline_ready",
                "message": f"วางแผนเสร็จแล้ว ({cut_count} ช่วง) พร้อม render บนเครื่อง",
                "cuts": cut_count,
            },
        )
        log.info("plan_talking_local_done", project_uid=project_uid, cuts=cut_count)
        return {"cuts": cut_count}
    except Exception as exc:
        ts = await _tenant_session(tenant_slug)
        try:
            if await _abort_if_cancelled(ts, project_uid, job_id):
                return {"cancelled": True}
            await _update_video(ts, project_uid, status="error", error_msg=format_exception_message(exc))
        finally:
            await ts.close()
        await _update_job(
            job_id, "error", 0,
            result={"step": "error", "message": format_exception_message(exc)},
            error=format_exception_message(exc),
        )
        raise
    finally:
        await session.close()
        if _usage_token is not None:
            from packages.llm.usage import reset_usage_ctx
            reset_usage_ctx(_usage_token)


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
        analyze_dub_local,
        analyze_dub_video_local,
        plan_effects_local,
        distill_style_local,
        reedit_dub_scenes_local,
        plan_talking_local,
        render_dub_silent,
        plan_dub_timeline,
    ]
    on_startup = startup
    on_shutdown = shutdown
    max_jobs = 10
    # arq requires a numeric timeout (None breaks worker init) AND derives the
    # per-job `arq:in-progress:<id>` lock TTL from it. A ~1-year timeout meant
    # that any job whose worker died mid-run (crash, Ctrl-C, a stopped run)
    # left a lock alive for a YEAR — arq then skips that job forever, so the
    # queue silently stops draining and the desktop app polls a job that will
    # never start (live 2026-08-13: 4 jobs queued, j_ongoing=0, locks with
    # ttl≈29,000,000s). 3 hours is longer than the slowest real task here
    # (a long talking_head transcribe + render) and short enough that a
    # crashed worker's claim expires on its own.
    job_timeout = 60 * 60 * 3
    keep_result = 3600  # keep result in Redis 1h
