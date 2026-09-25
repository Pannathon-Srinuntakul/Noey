"""Let a video block ask for agentic processing, which LiteLLM cannot express.

Gemini takes a per-video-part field that decides HOW the model reads the file:

* ``static`` (the default) — the file is sampled into frames at a fixed rate,
  1/second unless ``fps`` says otherwise, and every frame is sent. The model
  sees the whole clip at one density and the token cost follows its length.
* ``agentic`` — the file goes over as a file, and the model navigates it: it
  scans, seeks, re-checks a moment, and raises the frame rate on the parts that
  matter to the prompt. Cost follows what it chose to look at, not the length.

The field is ``mediaProcessing`` on the part in the GenerateContent API (the
Interactions API spells the same thing ``processing``). LiteLLM does not know
about it — its ``_apply_gemini_metadata`` copies exactly ``fps``,
``start_offset`` and ``end_offset`` out of ``video_metadata`` and drops
everything else, in 1.100.1 and still in 1.102.1, the newest release as of
2026-09-25. An unknown key is not rejected; it is silently ignored, which is the
same trap this codebase already hit once by passing ``video_metadata`` as a
top-level kwarg and watching the token count refuse to move.

So the request is carried through LiteLLM inside ``video_metadata`` — where the
library ignores it — and this patch lifts it back out onto the part on the way
to the wire. Nothing else in the request changes.

**Verify it arrived by the token count, never by the absence of an error.** A
dropped field looks exactly like a working one from the caller's side. See
``scripts/probe_agentic_video.py``.
"""

from __future__ import annotations

from typing import Any

from packages.core.logging import get_logger

log = get_logger(__name__)

#: What ``processing`` may be. Gemini spells them upper-case on the wire.
MODES = ("static", "agentic")

#: Key used to smuggle the mode through LiteLLM's video_metadata.
CARRIER_KEY = "media_processing"

#: Key Gemini reads on the part itself.
WIRE_KEY = "mediaProcessing"

_installed = False


def normalize(mode: str | None) -> str | None:
    """A mode name the wire accepts, or None for "say nothing and take the default"."""
    value = (mode or "").strip().lower()
    if value in ("", "static"):
        # Static IS the default. Sending it changes nothing and only adds a
        # field to explain later, so an explicit "static" stays silent.
        return None
    if value not in MODES:
        raise ValueError(f"video processing mode must be one of {MODES}, got {mode!r}")
    return value.upper()


def install() -> None:
    """Teach LiteLLM to pass ``mediaProcessing`` through. Safe to call repeatedly."""
    global _installed
    if _installed:
        return
    try:
        from litellm.llms.vertex_ai.gemini import transformation as tr
    except Exception as exc:  # noqa: BLE001 — a missing provider is not fatal
        log.warning("gemini_video_mode_patch_skipped", error=str(exc)[:200])
        return

    original = tr._apply_gemini_metadata

    def patched(part, model, media_resolution_enum, video_metadata):
        out = original(part, model, media_resolution_enum, video_metadata)
        mode = (video_metadata or {}).get(CARRIER_KEY)
        if mode:
            out = dict(out)
            out[WIRE_KEY] = mode
        return out

    tr._apply_gemini_metadata = patched  # type: ignore[assignment]
    _installed = True
    log.info("gemini_video_mode_patch_installed")


def carrier(mode: str | None) -> dict[str, Any]:
    """The ``video_metadata`` fragment that requests ``mode`` — empty for static."""
    wire = normalize(mode)
    if wire is None:
        return {}
    install()
    return {CARRIER_KEY: wire}
