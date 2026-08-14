"""Style distillation — turn a reference clip and/or a text description into a
reusable natural-language STYLE GUIDE for the effects-placement pass.

Runs ONCE when a user saves a style in the Studio (packages/db/models/
effect_style.py). The resulting prose is stored and later spliced verbatim into
EFFECTS_PLACEMENT_SYSTEM (effects_ai.py, via the ``__STYLE_BLOCK__`` token) on
every placement run — so the reference video is analysed a single time instead
of being re-uploaded to Gemini on each run.

SCOPE: camera motion only — the three ffmpeg transforms in
``transforms.TRANSFORM_REGISTRY`` (punch-zoom, whip-pan, scene-drift). Overlay
matters (captions, stickers, decorative effects, fonts) are deliberately NOT
distilled: a style that described them would be steering a half of the pipeline
this style system does not own, and every axis we cannot reproduce is an
invitation for the model to invent one.

Analysis is checklist-first: the model fills a fixed list of motion axes, PLUS
an open-ended ``openObservations`` field for motion notes outside that list. We
then render the JSON into plain prose for the placement prompt.
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

# Fixed checklist of motion axes our ffmpeg transforms can act on — one axis per
# entry in TRANSFORM_REGISTRY, no more. Shown to the model AND mirrored in
# STYLE_OBSERVATION_SCHEMA so nothing in the list is skipped.
STYLE_AXES_LIST: list[tuple[str, str]] = [
    ("pushZoomHolds", "Zoom onto a detail inside a shot — our punch-zoom, which can either RAMP in smoothly or SNAP straight to the tighter framing (its `cut` prop). Count both; say which one the reference favours in `notes`"),
    ("ambientDrift", "Continuous ambient handheld-style drift across a whole scene (our scene-drift)"),
    ("transitions", "Cut transitions: plain hard cuts vs whip-pan/sweep (our whip-pan)"),
]

# Free-text axes that shape HOW a motion is applied rather than how often.
STYLE_TEXT_AXES: list[tuple[str, str]] = [
    ("zoomAttack", "For the zooms counted above: mostly 'ramp' (smooth push), mostly 'cut' (snaps straight in, no ramp), or 'mixed'. Empty string if there are no zooms to judge"),
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
        "pushZoomHolds": _CADENCE_PROP,
        "ambientDrift": _CADENCE_PROP,
        "transitions": _CADENCE_PROP,
        # Ramp vs snap — punch-zoom's `cut` prop, a different look at the same
        # cadence, so it rides alongside the bands rather than inside one.
        "zoomAttack": {"type": "string"},
        # Open-ended, but still MOTION only: how long a hold lingers, whether
        # motion tracks the music, whether zooms favour faces or products.
        # Short English phrases, may be [].
        "openObservations": {
            "type": "array",
            "items": {"type": "string"},
        },
    },
    "required": [
        "pushZoomHolds",
        "ambientDrift",
        "transitions",
        "zoomAttack",
        "openObservations",
    ],
}


def _axes_block() -> str:
    lines = [f"- `{key}` (cadence + notes) — {desc}" for key, desc in STYLE_AXES_LIST]
    lines += [f"- `{key}` (short text) — {desc}" for key, desc in STYLE_TEXT_AXES]
    return "\n".join(lines)


STYLE_DISTILL_SYSTEM = f"""<role>
You are a short-form (TikTok) video-editing analyst. You are given a REFERENCE
clip and/or a text description of an editing style. Fill the checklist JSON
below so a DIFFERENT AI can later apply the same CAMERA MOTION to OTHER clips.
Describe reusable PATTERNS only — never the reference's exact product or
one-off content. English only.
</role>

<scope>
CAMERA MOTION ONLY. The three axes below are the only motions our renderer can
apply, and they are the only thing you are being asked about.

Say NOTHING about captions, on-screen text, stickers, emoji, particles, glow,
glitch, fonts, colour grade, or voice/tone — a different part of the system
owns those, and notes about them here would be ignored at best and would
mislead the editor at worst. If the reference is full of captions and
stickers, that is simply not what this analysis is for.
</scope>

<style_axes_checklist>
Fill EVERY axis.

{_axes_block()}

Cadence bands (use exactly these strings for every `cadence` field):
  {" | ".join(_CADENCE)}

Also fill `openObservations`: an OPEN list of short notes about MOTION that the
three axes do not capture (may be empty []). Good examples: how long a zoom
holds before releasing, whether motion lands on the beat, whether pushes favour
faces or products, whether motion is stronger at the hook than later.
</style_axes_checklist>

<honesty>
A cadence you cannot actually observe is worse than no style at all — it will
be followed literally. From a TEXT-ONLY description, only state a band the
description really implies; leave the rest at the honest default and put what
you do know in `notes`.
A hard SNAP to a tighter framing inside the same shot still counts as
`pushZoomHolds` — our punch-zoom renders that with no ramp. Only a genuine cut
to different footage is not a zoom.
Prefer an honest band over "completely / never / zero" unless it is truly
almost-never across nearly the whole clip.
</honesty>

<output>
Return ONLY JSON matching the schema. No markdown fences, no preamble.
</output>
"""


_IMAGE_SUFFIXES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}
_VIDEO_SUFFIXES = {".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm"}


def _guess_mime(path: pathlib.Path, *, default: str) -> str:
    return _IMAGE_SUFFIXES.get(path.suffix.lower()) or _VIDEO_SUFFIXES.get(path.suffix.lower()) or default


def _band(obj: Any) -> tuple[str, str] | None:
    """`(cadence, notes)` for one axis, or None when the model did not give a
    usable band. None means "say nothing about this axis" — see
    format_style_guide for why a default would be worse than silence."""
    if not isinstance(obj, dict):
        return None
    cad = str(obj.get("cadence") or "").strip()
    if cad not in _CADENCE:
        return None
    return cad, str(obj.get("notes") or "").strip()


def format_style_guide(obs: dict[str, Any]) -> str:
    """Render the motion checklist (+ open notes) into placement-prompt prose.

    An axis the model did not answer is OMITTED rather than defaulted. A
    fabricated "cadence almost-never" reads exactly like an observed one, and
    the placement prompt treats the style as authoritative — so a silent
    default would quietly switch a motion off across every future render.
    """
    labelled = [
        ("pushZoomHolds", "Push/zoom-holds on a detail (punch-zoom)"),
        ("ambientDrift", "Ambient scene drift"),
        ("transitions", "Sweep/whip transitions (else plain hard cuts)"),
    ]

    parts: list[str] = []
    for key, label in labelled:
        band = _band(obs.get(key))
        if band is None:
            continue
        cadence, notes = band
        parts.append(f"{label}: cadence {cadence}." + (f" {notes}" if notes else ""))

    attack = str(obs.get("zoomAttack") or "").strip()
    if attack and parts:
        parts.append(f"Zoom attack: {attack} (ramp = smooth push, cut = snap straight in).")

    extras = obs.get("openObservations") or []
    if not isinstance(extras, list):
        extras = []
    extra_lines = [str(x).strip() for x in extras if str(x).strip()]
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

        extra = call_kwargs(model=model, effort=settings.effects_vision_effort)
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
