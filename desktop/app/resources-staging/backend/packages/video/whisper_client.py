"""Whisper transcription core — shared by the worker task and the local-render API.

Extracted verbatim from ``services/worker/tasks.py`` transcribe_video: Modal
GPU endpoint transport (with chunking + 303 polling), local faster-whisper
fallback, and the coverage/retry/word-gap post-processing. No DB/arq — callers
provide progress + abort via callbacks.
"""

from __future__ import annotations

import pathlib
import time
from collections.abc import Awaitable, Callable
from typing import Any

from packages.core.logging import get_logger
from packages.video.ffmpeg_bin import media_duration, run_ffmpeg
from packages.video.transcribe import (
    build_transcribe_options,
    is_hallucinated_segment,
    should_retry_transcription_without_vad,
    split_segment_on_word_gaps,
    tighten_segment_bounds,
    transcript_coverage_stats,
)
from packages.video.transcribe_refine import (
    GEMINI_REFINE_SCHEMA,
    apply_refine_results,
    batch_segment_indices,
    build_refine_prompt,
    build_refine_request,
)

log = get_logger(__name__)

# Modal default function timeout ≈300s. GPU ~0.55s per 1s audio → 3-min chunks finish ~100s.
MODAL_CHUNK_SEC = 180.0         # max audio seconds per Modal request
MODAL_CHUNK_WHEN_SEC = 240.0    # chunk when WAV longer than 4 min (5-min uploads → 2 chunks)
MODAL_CHUNK_WHEN_MB = 28.0      # chunk when WAV exceeds ~28 MB (16 kHz mono ≈ 4 min)

# Cap the audio span per Gemini refine call so the inline base64 payload stays
# well under the ~20 MB request limit. 16 kHz mono s16le ≈ 32 KB/s → 240 s ≈
# 7.7 MB raw ≈ 10 MB base64. Comfortable headroom.
REFINE_MAX_SPAN_SEC = 240.0

# (phase, clip_index, clip_total) — phase: "clip_modal" | "clip_local" | "retry"
ProgressFn = Callable[[str, int, int], Awaitable[None]]
# return True to abort (partial result is discarded by the caller)
AbortFn = Callable[[], Awaitable[bool]]


async def transcribe_modal_request(
    audio_bytes: bytes,
    modal_url: str,
    language: str,
    *,
    clip_sec: float,
    vad_filter: bool = True,
) -> dict[str, Any]:
    """POST audio to Modal; poll async 303 redirect until transcript JSON is ready."""
    import asyncio
    import base64
    import httpx

    size_mb = len(audio_bytes) / 1024 / 1024
    read_timeout = max(600.0, clip_sec * 2.5 + 300.0)
    write_timeout = max(300.0, size_mb * 4.0)
    timeout = httpx.Timeout(connect=120.0, read=read_timeout, write=write_timeout, pool=60.0)
    payload = {
        "audio_b64": base64.b64encode(audio_bytes).decode(),
        "language": language,
        "vad_filter": vad_filter,
    }

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


def offset_modal_segments(segments: list[dict[str, Any]], offset_sec: float) -> list[dict[str, Any]]:
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


async def transcribe_via_modal(
    wav_path: pathlib.Path,
    modal_url: str,
    language: str,
    *,
    vad_filter: bool = True,
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
        vad_filter=vad_filter,
    )

    need_chunk = duration > MODAL_CHUNK_WHEN_SEC or size_mb > MODAL_CHUNK_WHEN_MB
    if not need_chunk:
        data = await transcribe_modal_request(
            wav_path.read_bytes(), modal_url, language, clip_sec=duration, vad_filter=vad_filter,
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
            data = await transcribe_modal_request(
                chunk_bytes, modal_url, language, clip_sec=chunk_dur, vad_filter=vad_filter,
            )
            dropped_total += int(data.get("dropped", 0))
            all_segments.extend(offset_modal_segments(data.get("segments", []), offset))
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


def _slice_wav_bytes(wav_path: pathlib.Path, start: float, end: float) -> bytes:
    """Extract [start, end] of a WAV as 16 kHz mono s16le bytes (small payload)."""
    import ffmpeg as ffmpeg_lib

    dur = max(0.1, end - start)
    tmp = wav_path.parent / f"_refine_{wav_path.stem}_{int(start * 1000)}.wav"
    try:
        run_ffmpeg(
            ffmpeg_lib
            .input(str(wav_path), ss=max(0.0, start), t=dur)
            .output(str(tmp), ac=1, ar=16000, acodec="pcm_s16le", f="wav")
            .overwrite_output(),
            label="refine_slice_wav",
        )
        return tmp.read_bytes()
    finally:
        tmp.unlink(missing_ok=True)


async def _call_gemini_refine(
    model: str,
    audio_bytes: bytes,
    request_items: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """One Gemini refine call: audio slice + segment list → [{id, text, action}]."""
    import base64
    import json

    from packages.llm.config import call_kwargs
    from packages.llm.gateway import acompletion

    encoded = base64.b64encode(audio_bytes).decode()
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": build_refine_prompt(request_items)},
                {"type": "file", "file": {"file_data": f"data:audio/wav;base64,{encoded}"}},
            ],
        }
    ]
    extra = call_kwargs(model=model)
    resp = await acompletion(
        messages,
        response_format={
            "type": "json_object",
            "response_schema": GEMINI_REFINE_SCHEMA,
            "enforce_validation": True,
        },
        **extra,
    )
    content = resp.choices[0].message.content or "{}"
    data = json.loads(content)
    results = data.get("results", []) if isinstance(data, dict) else []
    return results if isinstance(results, list) else []


async def refine_via_gemini(
    wav_path: pathlib.Path,
    segments: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Gemini refine pass over ONE clip's Whisper segments (local timestamps).

    ``segments`` carry timestamps local to ``wav_path`` (before any clip offset).
    The audio is sliced into spans ≤ ``REFINE_MAX_SPAN_SEC`` so each request stays
    under the inline-audio limit; each span's audio + its segments' text is sent
    to Gemini, and the corrected text / cut decisions are merged back by id.
    Timestamps are never touched. Raises on hard failure — the caller wraps this
    and falls back to the unmodified segments.
    """
    from packages.core.settings import get_settings

    _s = get_settings()
    model = f"gemini/{_s.gemini_refine_model}"
    request_items = build_refine_request(segments)

    all_results: list[dict[str, Any]] = []
    for start_i, end_i in batch_segment_indices(segments, REFINE_MAX_SPAN_SEC):
        span_start = float(segments[start_i]["start"])
        span_end = max(float(segments[k]["end"]) for k in range(start_i, end_i))
        audio_bytes = _slice_wav_bytes(wav_path, span_start, span_end)
        batch_items = request_items[start_i:end_i]
        log.info(
            "gemini_refine_batch",
            wav=wav_path.name,
            model=model,
            segments=len(batch_items),
            span_sec=round(span_end - span_start, 1),
            audio_kb=round(len(audio_bytes) / 1024),
        )
        all_results.extend(await _call_gemini_refine(model, audio_bytes, batch_items))

    return apply_refine_results(segments, all_results)


async def run_transcription(
    audio_files: list[pathlib.Path],
    *,
    on_progress: ProgressFn | None = None,
    should_abort: AbortFn | None = None,
) -> dict[str, Any] | None:
    """Transcribe WAVs (Modal if configured, else local faster-whisper).

    Returns ``{"segments": [...]}`` — timestamps absolute across the
    concatenated clips — or None when aborted via ``should_abort``.
    Includes the hallucination filter, coverage-based no-VAD retry, and
    word-gap splitting the worker has always applied.
    """
    from packages.core.settings import get_settings

    _s = get_settings()
    use_modal = bool(_s.modal_whisper_url)

    async def _progress(phase: str, idx: int, total: int) -> None:
        if on_progress:
            await on_progress(phase, idx, total)

    async def _aborted() -> bool:
        return bool(should_abort and await should_abort())

    # Gemini refine runs per-clip on LOCAL (pre-offset) timestamps so it hears the
    # exact audio that produced those segments. Additive + never blocking: any
    # failure logs and falls back to the raw Whisper segments unchanged.
    refine_on = bool(_s.gemini_refine_enabled and _s.gemini_api_key)

    async def _refine_clip(wav: pathlib.Path, local: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not refine_on or not local:
            return local
        try:
            refined = await refine_via_gemini(wav, local)
            log.info("gemini_refine_done", wav=wav.name, before=len(local), after=len(refined),
                     model=_s.gemini_refine_model)
            return refined
        except Exception as exc:  # noqa: BLE001
            log.warning("gemini_refine_failed", wav=wav.name, error=str(exc)[:300])
            return local

    def _append_with_offset(collected: list[dict[str, Any]], local: list[dict[str, Any]], offset: float) -> None:
        for s in local:
            collected.append({
                "start": round(float(s["start"]) + offset, 3),
                "end": round(float(s["end"]) + offset, 3),
                "text": s["text"],
                "words": [
                    {"word": w["word"],
                     "start": round(float(w["start"]) + offset, 3),
                     "end": round(float(w["end"]) + offset, 3)}
                    for w in s.get("words", [])
                ],
            })

    if use_modal:
        log.info("whisper_config", backend="modal", url=_s.modal_whisper_url, language=_s.whisper_language)
        model = None
    else:
        from faster_whisper import WhisperModel  # type: ignore[import-untyped]
        model = WhisperModel(_s.whisper_model, device=_s.whisper_device, compute_type=_s.whisper_compute)
        log.info("whisper_config", backend="local", model=_s.whisper_model, device=_s.whisper_device,
                 language=_s.whisper_language or "auto")

    aborted = False

    async def _collect_segments_modal(*, vad_filter: bool = True) -> tuple[list[dict[str, Any]], int, float]:
        nonlocal aborted
        collected: list[dict[str, Any]] = []
        offset = 0.0
        for idx, wav in enumerate(audio_files):
            if await _aborted():
                aborted = True
                return collected, 0, offset
            await _progress("clip_modal", idx, len(audio_files))
            segs = await transcribe_via_modal(
                wav, _s.modal_whisper_url, _s.whisper_language, vad_filter=vad_filter,
            )
            clip_dur = media_duration(wav)
            local: list[dict[str, Any]] = []
            for seg in segs:
                tight = tighten_segment_bounds({
                    "start": float(seg["start"]),
                    "end": float(seg["end"]),
                    "text": str(seg.get("text", "")).strip(),
                    "words": seg.get("words", []),
                })
                local.append({
                    "start": tight["start"],
                    "end": tight["end"],
                    "text": tight["text"],
                    "words": tight.get("words", []),
                })
            local = await _refine_clip(wav, local)
            _append_with_offset(collected, local, offset)
            offset += clip_dur
        return collected, 0, offset

    async def _collect_segments(
        transcribe_options: dict[str, Any],
        *,
        pass_label: str,
    ) -> tuple[list[dict[str, Any]], int, float]:
        nonlocal aborted
        collected: list[dict[str, Any]] = []
        dropped_count = 0
        offset = 0.0
        for idx, wav in enumerate(audio_files):
            if await _aborted():
                aborted = True
                return collected, dropped_count, offset
            await _progress("clip_local", idx, len(audio_files))
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
            local: list[dict[str, Any]] = []
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
                local.append({
                    "start": tight["start"],
                    "end": tight["end"],
                    "text": tight["text"],
                    "words": tight["words"],
                })
                raw_count += 1
            local = await _refine_clip(wav, local)
            _append_with_offset(collected, local, offset)
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
        options = build_transcribe_options(language=_s.whisper_language)
        all_segments, dropped, total_source = await _collect_segments(options, pass_label="vad")
    if aborted:
        return None

    coverage = transcript_coverage_stats(all_segments, total_source)
    log.info("transcribe_coverage", **coverage, total_source=round(total_source, 1), dropped=dropped)

    if should_retry_transcription_without_vad(all_segments, total_source):
        log.warning("transcribe_retry_no_vad", backend="modal" if use_modal else "local", **coverage)
        await _progress("retry", 0, len(audio_files))
        if use_modal:
            retry_segments, retry_dropped, _ = await _collect_segments_modal(vad_filter=False)
        else:
            retry_options = build_transcribe_options(language=_s.whisper_language, vad_filter=False)
            retry_segments, retry_dropped, _ = await _collect_segments(retry_options, pass_label="no_vad")
        if aborted:
            return None
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

    # Split segments whose words straddle long internal silence (Whisper
    # sometimes merges speech across a 60s pause into one segment).
    before_split = len(all_segments)
    all_segments = [
        part for seg in all_segments for part in split_segment_on_word_gaps(seg)
    ]
    if len(all_segments) != before_split:
        log.info("transcribe_word_gap_split", before=before_split, after=len(all_segments))

    return {"segments": all_segments}
