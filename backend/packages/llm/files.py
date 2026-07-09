"""Anthropic + Gemini Files API helpers via LiteLLM (no direct vendor SDKs)."""

from __future__ import annotations

import asyncio
import pathlib
import time
from typing import Any

import litellm

from packages.core.logging import get_logger
from packages.llm.config import anthropic_file_kwargs, gemini_file_kwargs

log = get_logger(__name__)

VISION_JPEG_MIME = "image/jpeg"
VIDEO_MP4_MIME = "video/mp4"

# Gemini processes uploaded video files asynchronously (state PROCESSING ->
# ACTIVE/FAILED); using a file before it reaches ACTIVE returns a 400
# FAILED_PRECONDITION from generateContent. Poll until ready.
GEMINI_FILE_POLL_INTERVAL_SEC = 2.0
GEMINI_FILE_ACTIVE_TIMEOUT_SEC = 180.0


async def upload_message_file(
    *,
    content: bytes,
    filename: str,
    mime_type: str = VISION_JPEG_MIME,
) -> str:
    """Upload one file for Messages API; returns Anthropic file_id."""
    kwargs = anthropic_file_kwargs()
    uploaded = await litellm.acreate_file(
        file=(filename, content, mime_type),
        purpose="messages",
        **kwargs,
    )
    file_id = str(getattr(uploaded, "id", "") or "")
    if not file_id:
        raise RuntimeError("file upload returned empty id")
    return file_id


async def upload_message_file_path(path: pathlib.Path) -> str:
    """Upload a JPEG from disk."""
    raw = path.read_bytes()
    return await upload_message_file(
        content=raw,
        filename=path.name,
        mime_type=VISION_JPEG_MIME,
    )


async def delete_message_file(file_id: str) -> None:
    """Best-effort delete of an uploaded file."""
    if not file_id:
        return
    kwargs = anthropic_file_kwargs()
    await litellm.afile_delete(file_id, **kwargs)


async def delete_message_files(file_ids: list[str]) -> None:
    """Delete uploaded files after a vision call (errors logged, not raised)."""
    for file_id in file_ids:
        try:
            await delete_message_file(file_id)
        except Exception as exc:  # noqa: BLE001
            log.warning("llm_file_delete_failed", file_id=file_id[:24], error=str(exc)[:200])


def vision_file_block(file_id: str, *, mime_type: str = VISION_JPEG_MIME) -> dict[str, Any]:
    """LiteLLM/OpenAI-shaped block → Anthropic image+file_id via gateway."""
    return {
        "type": "file",
        "file": {
            "file_id": file_id,
            "format": mime_type,
        },
    }


async def _wait_for_gemini_file_active(
    file_id: str,
    *,
    timeout_sec: float = GEMINI_FILE_ACTIVE_TIMEOUT_SEC,
) -> None:
    """Poll a Gemini file until it finishes server-side processing (state ACTIVE).

    LiteLLM maps Gemini's `state` to an OpenAI-style `status`: ACTIVE -> "processed",
    FAILED -> "error", PROCESSING/unknown -> "uploaded".
    """
    kwargs = gemini_file_kwargs()
    deadline = time.monotonic() + timeout_sec
    while True:
        info = await litellm.afile_retrieve(file_id, **kwargs)
        status = str(getattr(info, "status", "") or "")
        if status == "processed":
            return
        if status == "error":
            detail = getattr(info, "status_details", None)
            raise RuntimeError(f"Gemini file processing failed ({file_id}): {detail}")
        if time.monotonic() >= deadline:
            raise TimeoutError(f"Gemini file did not become ACTIVE within {timeout_sec:.0f}s: {file_id}")
        await asyncio.sleep(GEMINI_FILE_POLL_INTERVAL_SEC)


async def upload_gemini_file(
    path: pathlib.Path,
    *,
    mime_type: str = VIDEO_MP4_MIME,
) -> str:
    """Upload a video to the Gemini Files API; returns the Gemini file URI.

    Blocks until the file reaches ACTIVE state — Gemini processes uploaded
    video async, and referencing it before that fails with FAILED_PRECONDITION.
    `purpose` is ignored by LiteLLM's Gemini handler (it always returns the
    uploaded file's URI as `id`), so any value works.
    """
    kwargs = gemini_file_kwargs()
    raw = path.read_bytes()
    uploaded = await litellm.acreate_file(
        file=(path.name, raw, mime_type),
        purpose="user_data",
        **kwargs,
    )
    file_id = str(getattr(uploaded, "id", "") or "")
    if not file_id:
        raise RuntimeError("Gemini file upload returned empty id")
    await _wait_for_gemini_file_active(file_id)
    return file_id


async def delete_gemini_file(file_id: str) -> None:
    """Best-effort delete of an uploaded Gemini file (also auto-expires at 48h)."""
    if not file_id:
        return
    kwargs = gemini_file_kwargs()
    await litellm.afile_delete(file_id, **kwargs)


async def delete_gemini_files(file_ids: list[str]) -> None:
    """Delete uploaded Gemini files after a video analysis call (errors logged, not raised)."""
    for file_id in file_ids:
        try:
            await delete_gemini_file(file_id)
        except Exception as exc:  # noqa: BLE001
            log.warning("gemini_file_delete_failed", file_id=file_id[:60], error=str(exc)[:200])


def gemini_video_block(file_id: str, *, mime_type: str = VIDEO_MP4_MIME) -> dict[str, Any]:
    """LiteLLM/OpenAI-shaped block → Gemini file_uri pass-through via gateway.

    Uses Gemini's default media_resolution (300 tokens/sec) rather than "low"
    (100 tokens/sec) — production runs showed timestamp/content mismatches
    (e.g. a "back-view" moment described but not actually at that timestamp)
    that are consistent with reduced visual fidelity. Correctness over token
    cost while this path is still stabilizing.
    """
    return {
        "type": "file",
        "file": {
            "file_id": file_id,
            "format": mime_type,
        },
    }
