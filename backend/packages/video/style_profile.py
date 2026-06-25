"""Extract a Style Profile JSON from a reference TikTok clip.

Uses PySceneDetect (cut rate) + Claude Vision (visual style) to build a
Style Profile that plan_edit can use to match the creator's editing style.
"""

from __future__ import annotations

import pathlib
import statistics
from typing import Any

from packages.core.logging import get_logger

log = get_logger(__name__)

# Default style when no reference is provided
DEFAULT_STYLE: dict[str, Any] = {
    "avgCutLengthSec": 3.0,
    "sfxPerMinute": 4,
    "sfxTypes": ["pop", "whoosh"],
    "zoomOnOpening": True,
    "popupAtProductMention": False,
    "captionWordsPerLine": 3,
    "maxDurationSec": None,
}


def extract_style_profile(
    reference_clip: pathlib.Path,
    *,
    use_vision: bool = True,
) -> dict[str, Any]:
    """Analyse a reference clip and return a Style Profile dict.

    Steps:
      1. PySceneDetect → average cut length
      2. media_duration → maxDurationSec
      3. Claude Vision on sample frames → zoomOnOpening, popupAtProductMention
    """
    from packages.video.scene import detect_scenes, extract_sample_frames, frames_to_vision_content
    from packages.video.ffmpeg_bin import media_duration

    profile: dict[str, Any] = dict(DEFAULT_STYLE)

    # 1. Scene detection → average cut length
    try:
        scenes = detect_scenes(reference_clip)
        durations = [s["duration"] for s in scenes if s["duration"] > 0]
        if durations:
            profile["avgCutLengthSec"] = round(statistics.mean(durations), 2)
            clip_dur = media_duration(reference_clip)
            profile["maxDurationSec"] = round(clip_dur, 1)
            # SFX per minute: rough estimate based on cut frequency
            cuts_per_min = (len(scenes) / max(clip_dur, 1)) * 60
            profile["sfxPerMinute"] = round(min(cuts_per_min * 0.6, 12))
            log.info(
                "style_scenes_analysed",
                clip=str(reference_clip),
                scene_count=len(scenes),
                avg_cut=profile["avgCutLengthSec"],
            )
    except Exception as exc:
        log.warning("style_scene_detect_failed", error=str(exc))

    # 2. Claude Vision analysis (optional, skipped if use_vision=False)
    if use_vision:
        try:
            import tempfile, pathlib as _pl
            with tempfile.TemporaryDirectory() as tmp:
                frames = extract_sample_frames(
                    reference_clip,
                    detect_scenes(reference_clip),
                    _pl.Path(tmp) / "frames",
                    clip_id="ref",
                )
                vision_blocks = frames_to_vision_content(frames)

            if vision_blocks:
                _style_via_vision(profile, vision_blocks)
        except Exception as exc:
            log.warning("style_vision_failed", error=str(exc))

    return profile


def _style_via_vision(profile: dict, vision_blocks: list[dict]) -> None:
    """Ask Claude Vision to detect zoom + popup usage in sample frames."""
    import asyncio
    from packages.llm.gateway import acompletion

    system = (
        "You are a TikTok video style analyser. "
        "Given sample frames from a video, answer ONLY with valid JSON (no markdown, no prose). "
        "Keys: zoomOnOpening (bool), popupAtProductMention (bool), estimatedSfxPerMinute (int 1-12). "
        "zoomOnOpening: true if the first frame appears zoomed/scale-in compared to later frames. "
        "popupAtProductMention: true if you see price badges, product name overlays, or CTA buttons. "
        "Example: {\"zoomOnOpening\": true, \"popupAtProductMention\": false, \"estimatedSfxPerMinute\": 4}"
    )
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Analyse these sample frames from a TikTok video:"},
                *vision_blocks,
                {"type": "text", "text": "Respond with JSON only."},
            ],
        }
    ]

    async def _call() -> str:
        resp = await acompletion(messages, system=system)
        return resp.choices[0].message.content or ""

    raw = asyncio.run(_call())

    import json, re
    m = re.search(r"\{.*?\}", raw, re.DOTALL)
    if m:
        try:
            parsed = json.loads(m.group())
            if "zoomOnOpening" in parsed:
                profile["zoomOnOpening"] = bool(parsed["zoomOnOpening"])
            if "popupAtProductMention" in parsed:
                profile["popupAtProductMention"] = bool(parsed["popupAtProductMention"])
            if "estimatedSfxPerMinute" in parsed:
                profile["sfxPerMinute"] = int(parsed["estimatedSfxPerMinute"])
        except Exception as exc:
            log.warning("style_vision_parse_failed", raw=raw[:200], error=str(exc))
