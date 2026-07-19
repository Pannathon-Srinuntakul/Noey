"""Style distillation — turn a reference clip and/or a text description into a
reusable natural-language STYLE GUIDE for the effects-placement pass.

Runs ONCE when a user saves a style in the Studio (packages/db/models/
effect_style.py). The resulting prose is stored and later spliced verbatim into
EFFECTS_PLACEMENT_SYSTEM (effects_ai.py, via the ``__STYLE_BLOCK__`` token) on
every placement run — so the reference video is analysed a single time instead
of being re-uploaded to Gemini on each run.

Analysis is checklist-first: the model fills a fixed list of style axes that
map to what our effects pipeline can actually reproduce (captions, overlays,
hard-cut reframes, punch-zooms, scene-drift, transitions, fonts), PLUS an
open-ended ``openObservations`` field for anything outside that list. We then
render the JSON into plain prose for the placement prompt.
"""

from __future__ import annotations

import json
import pathlib
import re
from collections.abc import Awaitable, Callable
from typing import Any

from packages.core.logging import get_logger

log = get_logger(__name__)

# Cadence bands — flexible intensity labels, not hard counts.
_CADENCE = ("almost-every-beat", "most-scenes", "some-scenes", "rare", "almost-never")

# Fixed checklist of style axes our effects layer can act on. Shown to the
# model AND mirrored in STYLE_OBSERVATION_SCHEMA so nothing important is skipped.
STYLE_AXES_LIST: list[tuple[str, str]] = [
    ("captionVoice", "Spoken/on-screen voice & tone (first-person vs narrator, casual vs polished, emoji habit) — do NOT quote literal caption words"),
    ("onScreenText", "Intentional captions/labels density & placement (ignore tiny platform watermarks)"),
    ("decorativeEffects", "Flashy overlays: neon/glow/glitch/particles/animated stickers"),
    ("hardCutReframes", "Hard-cut changes of framing (wide ↔ mid/close across cuts) — NOT the same as a push-zoom"),
    ("pushZoomHolds", "Synthetic push / zoom-hold onto a detail inside a shot (our punch-zoom)"),
    ("ambientDrift", "Continuous ambient handheld-style drift across a whole scene (our scene-drift)"),
    ("transitions", "Cut transitions: plain hard cuts vs whip-pan/sweep (our whip-pan)"),
    ("fontMood", "Font mood when intentional text exists (e.g. bold geometric, friendly rounded, display serif)"),
]

_CADENCE_PROP = {
    "type": "object",
    "properties": {
        "cadence": {"type": "string", "enum": list(_CADENCE)},
        "notes": {"type": "string"},
    },
    "required": ["cadence", "notes"],
}

STYLE_OBSERVATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "captionVoice": {"type": "string"},
        "onScreenText": _CADENCE_PROP,
        "decorativeEffects": _CADENCE_PROP,
        "hardCutReframes": _CADENCE_PROP,
        "pushZoomHolds": _CADENCE_PROP,
        "ambientDrift": _CADENCE_PROP,
        "transitions": _CADENCE_PROP,
        "fontMood": {"type": "string"},
        # Open-ended: anything the checklist missed (color grade, pacing, music
        # feel, product-demo habits, etc.) — short English phrases, may be [].
        "openObservations": {
            "type": "array",
            "items": {"type": "string"},
        },
    },
    "required": [
        "captionVoice",
        "onScreenText",
        "decorativeEffects",
        "hardCutReframes",
        "pushZoomHolds",
        "ambientDrift",
        "transitions",
        "fontMood",
        "openObservations",
    ],
}


def _axes_block() -> str:
    lines = [f"- `{key}` — {desc}" for key, desc in STYLE_AXES_LIST]
    return "\n".join(lines)


STYLE_DISTILL_SYSTEM = f"""<role>
You are a short-form (TikTok) video-editing analyst. You are given a REFERENCE
clip and/or a text description of an editing style. Fill the checklist JSON
below so a DIFFERENT motion-graphics AI can later edit OTHER clips in this
same style. Describe reusable PATTERNS only — never the reference's exact
product, literal caption words, or one-off colors. English only.
</role>

<style_axes_checklist>
These axes map to what our editor can reproduce. Fill EVERY one.

{_axes_block()}

Cadence bands (use exactly these strings for every `cadence` field):
  {" | ".join(_CADENCE)}

Also fill `openObservations`: an OPEN list of short notes for anything
important that is NOT covered by the checklist above (may be empty []).
Examples of open notes: color-grade mood, beat pacing vs music, how long
holds linger, whether B-roll inserts are used, silence vs VO energy — only
if you actually see/hear them.
</style_axes_checklist>

<anti_absolutes>
Do not collapse hard-cut reframes into "camera completely static".
Do not treat platform watermarks as intentional captions.
Prefer an honest cadence band over words like "completely / never / zero"
unless the band is truly almost-never for nearly the whole clip.
</anti_absolutes>

<output>
Return ONLY JSON matching the schema. No markdown fences, no preamble.
</output>
"""


_IMAGE_SUFFIXES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}
_VIDEO_SUFFIXES = {".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm"}


def _guess_mime(path: pathlib.Path, *, default: str) -> str:
    return _IMAGE_SUFFIXES.get(path.suffix.lower()) or _VIDEO_SUFFIXES.get(path.suffix.lower()) or default


def _band(obj: Any, default: str = "some-scenes") -> tuple[str, str]:
    if not isinstance(obj, dict):
        return default, ""
    cad = str(obj.get("cadence") or default).strip()
    if cad not in _CADENCE:
        cad = default
    notes = str(obj.get("notes") or "").strip()
    return cad, notes


def format_style_guide(obs: dict[str, Any]) -> str:
    """Render checklist JSON (+ open notes) into placement-prompt prose."""
    voice = str(obs.get("captionVoice") or "").strip() or "Match the creator's natural speaking tone."
    text_c, text_n = _band(obs.get("onScreenText"), "some-scenes")
    deco_c, deco_n = _band(obs.get("decorativeEffects"), "almost-never")
    cut_c, cut_n = _band(obs.get("hardCutReframes"), "some-scenes")
    zoom_c, zoom_n = _band(obs.get("pushZoomHolds"), "rare")
    drift_c, drift_n = _band(obs.get("ambientDrift"), "almost-never")
    trans_c, trans_n = _band(obs.get("transitions"), "almost-never")
    font = str(obs.get("fontMood") or "").strip()
    extras = obs.get("openObservations") or []
    if not isinstance(extras, list):
        extras = []
    extra_lines = [str(x).strip() for x in extras if str(x).strip()]

    parts: list[str] = [
        f"Voice & tone: {voice}",
        f"On-screen text: cadence {text_c}."
        + (f" {text_n}" if text_n else " Intentional captions only; ignore watermarks."),
        f"Decorative effects (stickers/particles/glow/glitch): cadence {deco_c}."
        + (f" {deco_n}" if deco_n else ""),
        f"Hard-cut reframes (wide↔mid across cuts): cadence {cut_c}."
        + (f" {cut_n}" if cut_n else " Do not confuse with push-zooms."),
        f"Push/zoom-holds on a detail (punch-zoom): cadence {zoom_c}."
        + (f" {zoom_n}" if zoom_n else ""),
        f"Ambient scene drift: cadence {drift_c}."
        + (f" {drift_n}" if drift_n else ""),
        f"Sweep/whip transitions (else plain hard cuts): cadence {trans_c}."
        + (f" {trans_n}" if trans_n else ""),
    ]
    if font:
        parts.append(f"Font mood (when text is used): {font}")
    if extra_lines:
        parts.append("Also observe: " + "; ".join(extra_lines))
    return "\n".join(parts)


def _parse_observation_json(raw: str) -> dict[str, Any]:
    text = (raw or "").strip()
    if not text:
        raise RuntimeError("style distillation returned empty content")
    # Tolerate accidental markdown fences from non-schema paths.
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence:
        text = fence.group(1).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"style distillation returned non-JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise RuntimeError("style distillation JSON must be an object")
    return data


async def distill_style_prompt(
    reference_path: str | pathlib.Path | None,
    description: str = "",
    *,
    project_uid: str,
    on_thinking: Callable[[str], Awaitable[None]] | None = None,
) -> str:
    """Distil a reference clip and/or description into a style-guide prose block.

    Exactly one of ``reference_path`` / ``description`` must be meaningful (the
    caller enforces this); this handles all three shapes: ref+desc, ref-only,
    desc-only. The caller sets UsageCtx before invoking (same as the dub/effects
    tasks). Returns the plain-prose style guide to store on the EffectStyle row.
    """
    from packages.core.settings import get_settings
    from packages.llm.config import call_kwargs
    from packages.llm.files import delete_gemini_files, gemini_video_block, upload_gemini_file
    from packages.llm.gateway import acompletion_stream_thinking

    settings = get_settings()
    model = f"gemini/{settings.effects_vision_model}"
    ref_path = pathlib.Path(reference_path) if reference_path else None
    desc = (description or "").strip()

    if ref_path is None and not desc:
        raise ValueError("distill_style_prompt needs a reference clip or a description")

    file_ids: list[str] = []
    try:
        user_content: list[dict] = []
        if ref_path is not None:
            ref_mime = _guess_mime(ref_path, default="video/mp4")
            ref_file_id = await upload_gemini_file(ref_path, mime_type=ref_mime)
            file_ids.append(ref_file_id)
            user_content += [
                {"type": "text", "text": "=== reference clip (the editing style to distil) ==="},
                gemini_video_block(ref_file_id, mime_type=ref_mime),
            ]
        desc_block = desc or "(none — derive the style entirely from the reference clip)"
        user_content.append({
            "type": "text",
            "text": (
                f"<style_description>{desc_block}</style_description>\n\n"
                "Fill the checklist JSON now (every required axis + openObservations). "
                "Patterns only — no product-specific content."
            ),
        })

        extra = call_kwargs(model=model, effort="high")
        extra["timeout"] = settings.effects_vision_timeout_sec
        # Same Gemini structured-output path as effects placement.
        extra["response_format"] = {
            "type": "json_schema",
            "response_schema": STYLE_OBSERVATION_SCHEMA,
        }

        log.info(
            "effects_style_distill_start",
            project_uid=project_uid, model=model,
            has_reference=ref_path is not None, has_description=bool(desc),
        )

        resp = await acompletion_stream_thinking(
            [{"role": "user", "content": user_content}],
            system=STYLE_DISTILL_SYSTEM,
            project_uid=project_uid,
            on_thinking=on_thinking,
            **extra,
        )
        raw = (resp.choices[0].message.content or "").strip()
        obs = _parse_observation_json(raw)
        guide = format_style_guide(obs).strip()
        if not guide:
            raise RuntimeError("style distillation produced empty guide")
        log.info(
            "effects_style_distill_done",
            project_uid=project_uid,
            chars=len(guide),
            open_notes=len(obs.get("openObservations") or []),
        )
        return guide
    finally:
        await delete_gemini_files(file_ids)
