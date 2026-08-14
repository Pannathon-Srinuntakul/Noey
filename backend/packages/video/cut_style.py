"""Cut-style distillation — turn a reference clip into a reusable
natural-language CUT STYLE GUIDE for the dub_first/highlight edit pass.

Sibling of effects_style.py, but for the CUT decision instead of the effects
layer: it describes HOW the reference is edited (hook treatment, shot-length
rhythm, multi-angle vs held shots, pacing curve, ending) so the dub edit
prompts (dub_ai.py, via the ``__CUT_STYLE_BLOCK__`` token) can cut OTHER
footage in the same style. Runs ONCE when a user saves a cut style in the
Studio (packages/db/models/effect_style.py rows with kind="cut"); the stored
prose is spliced on every analyze/re-edit run.

Two signals feed the distillation:

1. The reference clip itself — Gemini watches it natively (same Files API
   path as the dub analyze pass).
2. ``compute_cut_stats()`` — deterministic PySceneDetect cut boundaries.
   Gemini samples video at ~1 fps, so it cannot reliably COUNT fast cuts no
   matter how the proxy was encoded; exact measured numbers beat more frames.
   The stats go into the distillation prompt as ground truth AND are appended
   to the final prose so the runtime edit prompt keeps the real rhythm
   numbers forever.
"""

from __future__ import annotations

import pathlib
from collections.abc import Awaitable, Callable
from statistics import median
from typing import Any

from packages.core.logging import get_logger
from packages.video.effects_style import (
    _CADENCE,
    _CADENCE_PROP,
    _VIDEO_SUFFIXES,
    _band,
    _parse_observation_json,
)

log = get_logger(__name__)

# Fixed checklist of cut-style axes the dub edit pass can act on. Shown to the
# model AND mirrored in CUT_OBSERVATION_SCHEMA so nothing important is skipped.
# Cadence-band axes describe frequency; free-text axes describe shape.
CUT_AXES_LIST: list[tuple[str, str]] = [
    ("hookStructure", "What happens visually in the first 1-3 seconds (shot type, cut count, motion, text/no-text) — PATTERNS only, never the reference's literal words or product"),
    ("shotLengthRhythm", "The FEEL of the shot-length rhythm (steady metronome / accelerating / burst-then-breathe). Do NOT guess numeric counts — exact measurements are provided separately"),
    ("multiAngleVsHeld", "Rapid multi-angle flashes vs long held single shots (cadence of angle changes within one beat/line)"),
    ("punchInsCameraMove", "Punch-ins, synthetic zooms, or camera movement used ACROSS cuts (reframe on cut, push-in on detail)"),
    ("brollProductInserts", "B-roll / product close-up inserts breaking up creator footage"),
    ("pacingCurve", "How pace evolves start → middle → end (front-loaded chaos, steady ramp, flat, sawtooth)"),
    ("sceneOrderStory", "Story shape / scene ordering (hook → demo → CTA, vibe montage, before/after, problem → reveal)"),
    ("musicSyncBehavior", "Cuts landing on music beats / audio hits"),
    ("endingCta", "How the video closes (dedicated CTA shot, freeze, loop-back to hook, hard stop mid-energy)"),
]

_FREE_TEXT_AXES = {"hookStructure", "shotLengthRhythm", "pacingCurve", "sceneOrderStory", "endingCta"}

CUT_OBSERVATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "hookStructure": {"type": "string"},
        "shotLengthRhythm": {"type": "string"},
        "multiAngleVsHeld": _CADENCE_PROP,
        "punchInsCameraMove": _CADENCE_PROP,
        "brollProductInserts": _CADENCE_PROP,
        "pacingCurve": {"type": "string"},
        "sceneOrderStory": {"type": "string"},
        "musicSyncBehavior": _CADENCE_PROP,
        "endingCta": {"type": "string"},
        # Open-ended: anything the checklist missed (energy of performance,
        # jump-cut habit inside one angle, silence gaps, etc.) — may be [].
        "openObservations": {
            "type": "array",
            "items": {"type": "string"},
        },
    },
    "required": [
        "hookStructure",
        "shotLengthRhythm",
        "multiAngleVsHeld",
        "punchInsCameraMove",
        "brollProductInserts",
        "pacingCurve",
        "sceneOrderStory",
        "musicSyncBehavior",
        "endingCta",
        "openObservations",
    ],
}


def _axes_block() -> str:
    lines = [f"- `{key}` — {desc}" for key, desc in CUT_AXES_LIST]
    return "\n".join(lines)


CUT_STYLE_DISTILL_SYSTEM = f"""<role>
You are a short-form (TikTok/Reels/Shorts) video EDITING-RHYTHM analyst. You
are given a REFERENCE clip. Fill the checklist JSON below so a DIFFERENT
video-editing AI can later CUT other raw footage in this same style — same
hook treatment, same shot-length rhythm, same pacing curve, same ending.
Describe reusable PATTERNS only — never the reference's exact product,
literal spoken/caption words, or one-off content. English only.
</role>

<cut_axes_checklist>
These axes map to decisions our cut pass actually makes. Fill EVERY one.

{_axes_block()}

Cadence bands (use exactly these strings for every `cadence` field):
  {" | ".join(_CADENCE)}

Also fill `openObservations`: an OPEN list of short notes for anything
important that is NOT covered by the checklist above (may be empty []).
Examples: jump-cuts inside a single angle, deliberate breathing pauses,
match-cuts on motion, text-beat driven cutting — only if you actually see it.
</cut_axes_checklist>

<anti_absolutes>
A `<measured_cut_stats>` block with EXACT deterministic scene-detection
numbers may be provided — trust those numbers over your own visual count;
you sample the video too sparsely to count fast cuts yourself. Use the
numbers to CALIBRATE your rhythm/pacing descriptions, then describe the feel.
Prefer an honest cadence band over words like "completely / never / zero"
unless the band is truly almost-never for nearly the whole clip.
Ignore platform watermarks and UI chrome.
</anti_absolutes>

<output>
Return ONLY JSON matching the schema. No markdown fences, no preamble.
</output>
"""


def compute_cut_stats(ref_path: str | pathlib.Path) -> dict[str, Any] | None:
    """Deterministic rhythm ground truth via PySceneDetect.

    Returns None on ANY failure — this is an enhancement, never a blocker.
    """
    try:
        path = pathlib.Path(ref_path)
        if path.suffix.lower() not in _VIDEO_SUFFIXES:
            return None
        from packages.video.scene import detect_scenes

        scenes = detect_scenes(path)
        if not scenes:
            return None
        durations = [max(0.0, float(s["duration"])) for s in scenes]
        total = float(scenes[-1]["end"]) or sum(durations)
        if total <= 0:
            return None
        cut_count = max(0, len(scenes) - 1)

        buckets = {"under_0_5s": 0, "s0_5_to_1": 0, "s1_to_2": 0, "s2_to_4": 0, "over_4s": 0}
        for d in durations:
            if d < 0.5:
                buckets["under_0_5s"] += 1
            elif d < 1.0:
                buckets["s0_5_to_1"] += 1
            elif d < 2.0:
                buckets["s1_to_2"] += 1
            elif d < 4.0:
                buckets["s2_to_4"] += 1
            else:
                buckets["over_4s"] += 1

        # Cuts per minute per third of the clip — pacing-curve evidence.
        third = total / 3.0
        thirds = [0, 0, 0]
        for s in scenes[1:]:  # each scene start after the first is a cut point
            t = float(s["start"])
            idx = min(2, int(t / third)) if third > 0 else 0
            thirds[idx] += 1
        per_min_thirds = [round(c / (third / 60.0), 1) if third > 0 else 0.0 for c in thirds]

        return {
            "duration_sec": round(total, 2),
            "shot_count": len(scenes),
            "cut_count": cut_count,
            "cuts_per_minute": round(cut_count / (total / 60.0), 1),
            "avg_shot_sec": round(sum(durations) / len(durations), 2),
            "median_shot_sec": round(median(durations), 2),
            "min_shot_sec": round(min(durations), 2),
            "max_shot_sec": round(max(durations), 2),
            "histogram": buckets,
            "cuts_per_minute_by_third": per_min_thirds,
        }
    except Exception as exc:  # noqa: BLE001 — best-effort by design
        log.warning("cut_stats_failed", path=str(ref_path), error=str(exc))
        return None


def format_cut_stats_text(stats: dict[str, Any]) -> str:
    """Render measured stats as a prompt block. Trustworthy exact numbers."""
    h = stats.get("histogram") or {}
    hist = (
        f"<0.5s: {h.get('under_0_5s', 0)}, 0.5-1s: {h.get('s0_5_to_1', 0)}, "
        f"1-2s: {h.get('s1_to_2', 0)}, 2-4s: {h.get('s2_to_4', 0)}, >4s: {h.get('over_4s', 0)}"
    )
    thirds = stats.get("cuts_per_minute_by_third") or [0, 0, 0]
    return (
        "<measured_cut_stats>\n"
        "These are EXACT measurements from deterministic scene detection on the\n"
        "reference clip. Trust these numbers over your own visual count.\n"
        f"Duration: {stats.get('duration_sec')}s | shots: {stats.get('shot_count')} | "
        f"cuts: {stats.get('cut_count')} | cuts/min: {stats.get('cuts_per_minute')}\n"
        f"Shot length: avg {stats.get('avg_shot_sec')}s, median {stats.get('median_shot_sec')}s, "
        f"min {stats.get('min_shot_sec')}s, max {stats.get('max_shot_sec')}s\n"
        f"Shot-length histogram: {hist}\n"
        f"Cuts/min by clip third (start/middle/end): {thirds[0]} / {thirds[1]} / {thirds[2]}\n"
        "</measured_cut_stats>"
    )


# Thai UI labels map to these API values (packages/db/models/effect_style.py
# CUT_STYLE_PLATFORMS); the prompt gets a human-readable English label.
_PLATFORM_LABELS = {
    "tiktok": "TikTok",
    "reels": "Instagram Reels",
    "shorts": "YouTube Shorts",
    "youtube": "YouTube (long-form)",
    "other": "another platform",
}


def _band_or(obj: Any, default: str) -> tuple[str, str]:
    """Shared ``_band`` returns None for an unusable answer (effects_style
    omits that axis entirely rather than inventing a cadence). The cut prompt
    is built from a fixed sentence per axis, so it needs SOME band — fall back
    to this axis's documented default instead of dropping the line."""
    return _band(obj) or (default, "")


def format_cut_style_guide(obs: dict[str, Any], stats: dict[str, Any] | None = None) -> str:
    """Render checklist JSON (+ measured stats) into edit-prompt prose."""
    hook = str(obs.get("hookStructure") or "").strip() or "Open on the strongest visual moment available."
    rhythm = str(obs.get("shotLengthRhythm") or "").strip() or "Keep a steady short-form rhythm."
    multi_c, multi_n = _band_or(obs.get("multiAngleVsHeld"), "most-scenes")
    punch_c, punch_n = _band_or(obs.get("punchInsCameraMove"), "some-scenes")
    broll_c, broll_n = _band_or(obs.get("brollProductInserts"), "some-scenes")
    pacing = str(obs.get("pacingCurve") or "").strip() or "Keep energy consistent throughout."
    story = str(obs.get("sceneOrderStory") or "").strip() or "Hook first, then demonstrate, then close."
    music_c, music_n = _band_or(obs.get("musicSyncBehavior"), "some-scenes")
    ending = str(obs.get("endingCta") or "").strip() or "Close on a clear final shot."
    extras = obs.get("openObservations") or []
    if not isinstance(extras, list):
        extras = []
    extra_lines = [str(x).strip() for x in extras if str(x).strip()]

    parts: list[str] = [
        f"Hook (first 1-3s): {hook}",
        f"Shot-length rhythm: {rhythm}",
        f"Multi-angle flashes vs held shots: cadence {multi_c}." + (f" {multi_n}" if multi_n else ""),
        f"Punch-ins / camera moves across cuts: cadence {punch_c}." + (f" {punch_n}" if punch_n else ""),
        f"B-roll / product inserts: cadence {broll_c}." + (f" {broll_n}" if broll_n else ""),
        f"Pacing curve: {pacing}",
        f"Story shape: {story}",
        f"Music sync: cadence {music_c}." + (f" {music_n}" if music_n else ""),
        f"Ending: {ending}",
    ]
    if extra_lines:
        parts.append("Also observe: " + "; ".join(extra_lines))
    if stats:
        thirds = stats.get("cuts_per_minute_by_third") or [0, 0, 0]
        parts.append(
            "Measured rhythm from the reference: "
            f"~{stats.get('cuts_per_minute')} cuts/min, median shot {stats.get('median_shot_sec')}s "
            f"(avg {stats.get('avg_shot_sec')}s); pacing across the video: "
            f"{thirds[0]} / {thirds[1]} / {thirds[2]} cuts/min (start/middle/end)."
        )
    return "\n".join(parts)


async def distill_cut_style_prompt(
    reference_path: str | pathlib.Path | None,
    description: str = "",
    *,
    target_platform: str = "",
    project_uid: str,
    on_thinking: Callable[[str], Awaitable[None]] | None = None,
) -> str:
    """Distil a reference clip into a cut-style prose block.

    The router requires a video reference for kind="cut" styles, but this
    tolerates description-only input for robustness. The caller sets UsageCtx
    before invoking (same as the dub/effects tasks). Returns the plain-prose
    guide to store on the EffectStyle row (kind="cut").
    """
    from packages.core.settings import get_settings
    from packages.llm.config import call_kwargs
    from packages.llm.files import delete_gemini_files, gemini_video_block, upload_gemini_file
    from packages.llm.gateway import acompletion_stream_thinking

    settings = get_settings()
    # Same tier as the dub analyze pass — rhythm analysis is the hard part
    # the flash models fail at (see settings.dub_vision_model comment).
    model = f"gemini/{settings.dub_vision_model}"
    ref_path = pathlib.Path(reference_path) if reference_path else None
    desc = (description or "").strip()

    if ref_path is None and not desc:
        raise ValueError("distill_cut_style_prompt needs a reference clip or a description")

    stats = compute_cut_stats(ref_path) if ref_path is not None else None

    file_ids: list[str] = []
    try:
        user_content: list[dict] = []
        if ref_path is not None:
            ref_mime = _VIDEO_SUFFIXES.get(ref_path.suffix.lower(), "video/mp4")
            ref_file_id = await upload_gemini_file(ref_path, mime_type=ref_mime)
            file_ids.append(ref_file_id)
            block = gemini_video_block(ref_file_id, mime_type=ref_mime)
            # GATED enhancement: denser frame sampling for rhythm comprehension.
            # Default 0 = off; enable only after scripts/probe_gemini_fps.py
            # proves LiteLLM passes per-block video metadata through to Gemini.
            if settings.cut_style_ref_fps > 0 and isinstance(block.get("file"), dict):
                block["file"]["video_metadata"] = {"fps": settings.cut_style_ref_fps}
            user_content += [
                {"type": "text", "text": "=== reference clip (the CUT/editing style to distil) ==="},
                block,
            ]
        if stats:
            user_content.append({"type": "text", "text": format_cut_stats_text(stats)})
        platform = (target_platform or "").strip().lower()
        if platform:
            label = _PLATFORM_LABELS.get(platform, platform)
            user_content.append({
                "type": "text",
                "text": (
                    f"<target_platform>Target platform: {label}. Judge the style through "
                    "that platform's native pacing norms and note platform-specific "
                    "habits you observe.</target_platform>"
                ),
            })
        desc_block = desc or "(none — derive the style entirely from the reference clip)"
        user_content.append({
            "type": "text",
            "text": (
                f"<style_description>{desc_block}</style_description>\n\n"
                "Fill the checklist JSON now (every required axis + openObservations). "
                "Patterns only — no product-specific content."
            ),
        })

        # Distillation, not placement — it shares effects_style's depth setting
        # because it is the same "watch a reference and judge it" call, even
        # though the model it runs on is the dub one.
        extra = call_kwargs(model=model, effort=settings.effects_vision_effort)
        extra["timeout"] = settings.dub_vision_timeout_sec
        extra["response_format"] = {
            "type": "json_schema",
            "response_schema": CUT_OBSERVATION_SCHEMA,
        }

        log.info(
            "cut_style_distill_start",
            project_uid=project_uid, model=model,
            has_reference=ref_path is not None, has_description=bool(desc),
            has_stats=stats is not None, target_platform=platform or None,
        )

        resp = await acompletion_stream_thinking(
            [{"role": "user", "content": user_content}],
            system=CUT_STYLE_DISTILL_SYSTEM,
            project_uid=project_uid,
            on_thinking=on_thinking,
            **extra,
        )
        raw = (resp.choices[0].message.content or "").strip()
        obs = _parse_observation_json(raw)
        guide = format_cut_style_guide(obs, stats).strip()
        if not guide:
            raise RuntimeError("cut style distillation produced empty guide")
        log.info(
            "cut_style_distill_done",
            project_uid=project_uid,
            chars=len(guide),
            open_notes=len(obs.get("openObservations") or []),
        )
        return guide
    finally:
        await delete_gemini_files(file_ids)
