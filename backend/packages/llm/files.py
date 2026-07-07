"""Anthropic + Gemini Files API helpers via LiteLLM (no direct vendor SDKs)."""

from __future__ import annotations

import pathlib
from typing import Any

import litellm

from packages.core.logging import get_logger
from packages.llm.config import anthropic_file_kwargs, gemini_file_kwargs

log = get_logger(__name__)

VISION_JPEG_MIME = "image/jpeg"
VIDEO_MP4_MIME = "video/mp4"


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


async def upload_gemini_file(
    path: pathlib.Path,
    *,
    mime_type: str = VIDEO_MP4_MIME,
) -> str:
    """Upload a video to the Gemini Files API; returns the Gemini file URI.

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

    `detail: "low"` maps to Gemini's media_resolution=LOW (100 tokens/sec of
    video vs 300 at default) — plenty for shot/pose/cut-timing judgment.
    """
    return {
        "type": "file",
        "file": {
            "file_id": file_id,
            "format": mime_type,
            "detail": "low",
        },
    }
