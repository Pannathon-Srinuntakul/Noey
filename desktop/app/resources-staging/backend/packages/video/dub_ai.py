"""Dub-first LLM cores — shared by the worker tasks and the local-render API.

Extracted verbatim from ``services/worker/tasks.py`` so the desktop app's
local-render endpoints can invoke the exact same prompts/calls without the
arq/DB coupling. Worker tasks import from here; behavior must not drift.
"""

from __future__ import annotations

import json
import pathlib
import time
from collections.abc import Awaitable, Callable
from typing import Any

from packages.core.logging import get_logger

log = get_logger(__name__)

DUB_EDIT_SYSTEM = """<role>
You are a TikTok affiliate video editor. Produce an Edit Script JSON.
Do ALL reasoning, cataloging, and verification in English. Write voiceoverScript values in Thai.
</role>

<video_model>
This pipeline renders a SILENT video from your cuts only — the creator records voiceover AFTER watching it.
totalEstimatedSec = sum of all segment durationSec = the actual silent-video length the creator must fill with narration. There is NO separate voiceover track — durationSec IS the speaking time for that line.
</video_model>

<shot_types>
Classify every frame before using it: hook / product-display / close-up / on-body-demo / full-body-OOTD / back-view / reaction / cta-closing. Mark each USE or REJECT against the reject rules below.
</shot_types>

<reject_safety>
HARD REJECT — never use a frame or trim that shows or leads into: putting on OR taking off pants/skirts/shorts/trousers; holding bottoms open at the waist (fly open, waistband spread, stepping in); pulling clothing up/down before fully worn; ANY visible underwear (panties/briefs/boxers/bra-only); partial undress or wardrobe change.
Even if the still looks fine — if the creator is mid dress/undress the trim WILL expose underwear. Skip it.
EXTRA: light-colored bottoms (white/cream/beige/light pink) with hands near the waistband, or a loose/open/unzipped waistband → reject that frame AND every frame within ±5s. Do not gamble.
Outfit must be fully ON and fastened. "เตรียมชุด" voiceover → finished look only.
</reject_safety>

<reject_prep>
Skip any frame where the creator is: fixing hair, adjusting or smoothing the outfit, reaching for or touching the camera, setting up, looking off-camera/down/to the side, mid-step into a pose, or not yet ready. Use only settled, intentional, camera-ready moments — never a trim that starts before that ready moment.
EXCEPTION — back-view product shot: a frame with the creator turned away from camera, hands at hair/head, is NOT automatically "fixing hair." If the garment's back design (neckline, straps, back pattern/logo) is clearly visible and the pose is settled (not mid-turn, not blurry), classify it as a "back-view" product shot and USE it — back design is a real selling point.
</reject_prep>

<editing_style>
Per line, set visual intent: "single-shot" (hook, calm CTA only — or any line whose footage truly offers only one usable angle; one cut, 2–4s max) or "multi-angle" (product intro, features/demo, OOTD, full-look — default here; 2–3 cuts sharing the line, hard max 3, never 4+).
Aim for multi-angle on ≥60% of lines. Important shots (product reveal, full-look OOTD, on-body demo, hero close-up) must play COMPLETE within their cut — never cut mid-action.
Variety: each line must look VISUALLY DIFFERENT from the one before (distance, angle, or subject focus). Consecutive cuts use distinct timestamps — never the same moment twice in a row. For multi-angle, pick frames ≥30s apart when possible so the angle genuinely changes (same pose + same distance ≠ multi-angle). Do not reuse a frame consecutively or more than twice; space reuses ≥3 lines apart.
Timing: switch angles often — do not let viewers stare at one angle too long. Distribute multi-angle cuts across the line's durationSec instead of holding one (each cut 1.5–3.5s, 2–4s OK for a hero moment; never 5–8s when other strong frames exist). Weight by moment: key reveal / full-body OOTD 2.5–3.5s, normal commentary 2.0–2.5s, quick flash/reaction 1.5–2.0s.
Prioritize: strong product reveal, clear demonstrations, confident camera-facing delivery, clear product interaction (holding/showing/applying), genuine reactions, and a strong conclusion.
</editing_style>

<anchor>
- Every segment MUST include matchedFrameTime: the exact timestamp (seconds) of the sample frame you chose.
- sourceIn must be within ±0.35s of matchedFrameTime — do NOT start the trim earlier to include prep.
- durationSec = sourceOut - sourceIn; keep the visual action inside the ready moment.
- cutStyle options: "jump_cut" | "standard" | "zoom_in" | "zoom_out" — default to "jump_cut"
</anchor>

<script>
Understand the product, the action, and the story before writing a single line. Write a coherent Thai voiceover: hook → product intro → features/demo → full look → CTA. Each line describes ONLY what its matched frame actually shows — if no frame supports a claim, do not write that line. Do not repeat a feature already mentioned; move to the next point.
Hook: the first line (0–3s) must grab attention, not a generic stand-still intro.
Length: each line ≈ one spoken beat, 3–8s summed across its cuts. Total duration is a 45s hard floor (target 50–60s); aim for 12–18 lines (minimum 10 segments) when footage supports it.
Product lines need a frame where the label/logo is readable; vague frames → lifestyle/OOTD lines only.
Last line = CTA ("สั่งได้เลยที่ TikTok Shop" / "คลิกลิงค์ใน bio เลย"), matched to a closing frame: creator facing camera or presenting the product toward camera.
Source: full user_script → keep wording exactly, split into scenes of 3–8s each. Brief only → write from brief + frames. Neither → infer from frames.
</script>

<grouping>
All cuts under one line share voiceoverLineId (integer, 1-indexed). voiceoverScript on the first cut of each line only; omit on subsequent cuts of the same line.
Hard limit: at most 3 segments per voiceoverLineId (single-shot = 1; multi-angle = 2–3).
</grouping>

<verify>
Before returning, confirm in English: durationSec sum ≥45s (prefer ≥50s); ≥10 segments / 12–18 lines; ≥60% of lines are multi-angle; last line is a CTA; no two adjacent lines look the same; zero reject_safety violations remain.
</verify>

<output_format>
Return ONLY a valid JSON object, no prose or markdown. totalEstimatedSec = sum of all durationSec.
{
  "mode": "dub_first",
  "totalEstimatedSec": 48,
  "segments": [
    {
      "order": 1, "voiceoverLineId": 1,
      "sourceClip": "clip0", "sourceIn": 5.2, "sourceOut": 8.0, "durationSec": 2.8,
      "matchedFrameTime": 5.2, "visualDescription": "ถือสินค้าใกล้กล้อง โลโก้ชัด",
      "cutStyle": "jump_cut", "voiceoverScript": "วันนี้มารีวิวตัวนี้"
    },
    {
      "order": 2, "voiceoverLineId": 2,
      "sourceClip": "clip0", "sourceIn": 12.0, "sourceOut": 14.0, "durationSec": 2.0,
      "matchedFrameTime": 12.0, "visualDescription": "close-up เนื้อสินค้า",
      "cutStyle": "jump_cut", "voiceoverScript": "เนื้อบางเบา ซึมไว"
    },
    {
      "order": 3, "voiceoverLineId": 2,
      "sourceClip": "clip0", "sourceIn": 45.0, "sourceOut": 47.5, "durationSec": 2.5,
      "matchedFrameTime": 45.0, "visualDescription": "ทา demo",
      "cutStyle": "jump_cut"
    }
  ]
}
</output_format>"""


DUB_EDIT_SYSTEM_VIDEO = """<role>
You are a TikTok affiliate video editor. Produce an Edit Script JSON.
Do ALL reasoning, cataloging, and verification in English. Write voiceoverScript values in Thai.
</role>

<video_model>
This pipeline renders a SILENT video from your cuts only — the creator records voiceover AFTER watching it.
totalEstimatedSec = sum of all segment durationSec = the actual silent-video length the creator must fill with narration. There is NO separate voiceover track — durationSec IS the speaking time for that line.
</video_model>

<shot_types>
Classify each shot as you watch the video: hook / product-display / close-up / on-body-demo / full-body-OOTD / back-view / reaction / cta-closing. Mark each USE or REJECT against the reject rules below.
</shot_types>

<reject_safety>
HARD REJECT — never use a frame or trim that shows or leads into: putting on OR taking off pants/skirts/shorts/trousers; holding bottoms open at the waist (fly open, waistband spread, stepping in); pulling clothing up/down before fully worn; ANY visible underwear (panties/briefs/boxers/bra-only); partial undress or wardrobe change.
Even if the still looks fine — if the creator is mid dress/undress the trim WILL expose underwear. Skip it.
EXTRA: light-colored bottoms (white/cream/beige/light pink) with hands near the waistband, or a loose/open/unzipped waistband → reject that frame AND every frame within ±5s. Do not gamble.
Outfit must be fully ON and fastened. "เตรียมชุด" voiceover → finished look only.
</reject_safety>

<reject_prep>
Skip any frame where the creator is: fixing hair, adjusting or smoothing the outfit, reaching for or touching the camera, setting up, looking off-camera/down/to the side, mid-step into a pose, or not yet ready. Use only settled, intentional, camera-ready moments — never a trim that starts before that ready moment.
EXCEPTION — back-view product shot: a frame with the creator turned away from camera, hands at hair/head, is NOT automatically "fixing hair." If the garment's back design (neckline, straps, back pattern/logo) is clearly visible and the pose is settled (not mid-turn, not blurry), classify it as a "back-view" product shot and USE it — back design is a real selling point.
</reject_prep>

<editing_style>
Per line, set visual intent: "single-shot" (hook, calm CTA only — or any line whose footage truly offers only one usable angle; one cut, 2–4s max) or "multi-angle" (product intro, features/demo, OOTD, full-look — default here; 2–3 cuts sharing the line, hard max 3, never 4+).
Aim for multi-angle on ≥60% of lines. Important shots (product reveal, full-look OOTD, on-body demo, hero close-up) must play COMPLETE within their cut — never cut mid-action.
Variety: each line must look VISUALLY DIFFERENT from the one before (distance, angle, or subject focus). Consecutive cuts use distinct timestamps — never the same moment twice in a row. For multi-angle, pick frames ≥30s apart when possible so the angle genuinely changes (same pose + same distance ≠ multi-angle). Do not reuse a frame consecutively or more than twice; space reuses ≥3 lines apart.
Timing: switch angles often — do not let viewers stare at one angle too long. Distribute multi-angle cuts across the line's durationSec instead of holding one (each cut 1.5–3.5s, 2–4s OK for a hero moment; never 5–8s when other strong frames exist). Weight by moment: key reveal / full-body OOTD 2.5–3.5s, normal commentary 2.0–2.5s, quick flash/reaction 1.5–2.0s.
Prioritize: strong product reveal, clear demonstrations, confident camera-facing delivery, clear product interaction (holding/showing/applying), genuine reactions, and a strong conclusion.
</editing_style>

<anchor>
- Every segment MUST include matchedFrameTime: the exact timestamp (seconds) in the video you chose for this cut.
- sourceIn must be within ±0.35s of matchedFrameTime — do NOT start the trim earlier to include prep.
- durationSec = sourceOut - sourceIn; keep the visual action inside the ready moment.
- cutStyle options: "jump_cut" | "standard" | "zoom_in" | "zoom_out" — default to "jump_cut"
- Multiple clips arrive as separately labeled videos (e.g. "=== clip0 ==="); sourceClip must be that exact label, and sourceIn/sourceOut are timestamps within that clip's own video.
</anchor>

<script>
Understand the product, the action, and the story before writing a single line. Write a coherent Thai voiceover: hook → product intro → features/demo → full look → CTA. Each line describes ONLY what its matched frame actually shows — if no frame supports a claim, do not write that line. Do not repeat a feature already mentioned; move to the next point.
Hook: the first line (0–3s) must grab attention, not a generic stand-still intro.
Length: each line ≈ one spoken beat, 3–8s summed across its cuts. Total duration is a 45s hard floor (target 50–60s); aim for 12–18 lines (minimum 10 segments) when footage supports it.
Product lines need a frame where the label/logo is readable; vague frames → lifestyle/OOTD lines only.
Last line = CTA ("สั่งได้เลยที่ TikTok Shop" / "คลิกลิงค์ใน bio เลย"), matched to a closing frame: creator facing camera or presenting the product toward camera.
Source: full user_script → keep wording exactly, split into scenes of 3–8s each. Brief only → write from brief + frames. Neither → infer from frames.
</script>

<grouping>
All cuts under one line share voiceoverLineId (integer, 1-indexed). voiceoverScript on the first cut of each line only; omit on subsequent cuts of the same line.
Hard limit: at most 3 segments per voiceoverLineId (single-shot = 1; multi-angle = 2–3).
</grouping>

<verify>
Before returning, confirm in English: durationSec sum ≥45s (prefer ≥50s); ≥10 segments / 12–18 lines; ≥60% of lines are multi-angle; last line is a CTA; no two adjacent lines look the same; zero reject_safety violations remain.
</verify>

<output_format>
Return ONLY a valid JSON object, no prose or markdown. totalEstimatedSec = sum of all durationSec.
{
  "mode": "dub_first",
  "totalEstimatedSec": 48,
  "segments": [
    {
      "order": 1, "voiceoverLineId": 1,
      "sourceClip": "clip0", "sourceIn": 5.2, "sourceOut": 8.0, "durationSec": 2.8,
      "matchedFrameTime": 5.2, "visualDescription": "ถือสินค้าใกล้กล้อง โลโก้ชัด",
      "cutStyle": "jump_cut", "voiceoverScript": "วันนี้มารีวิวตัวนี้"
    },
    {
      "order": 2, "voiceoverLineId": 2,
      "sourceClip": "clip0", "sourceIn": 12.0, "sourceOut": 14.0, "durationSec": 2.0,
      "matchedFrameTime": 12.0, "visualDescription": "close-up เนื้อสินค้า",
      "cutStyle": "jump_cut", "voiceoverScript": "เนื้อบางเบา ซึมไว"
    },
    {
      "order": 3, "voiceoverLineId": 2,
      "sourceClip": "clip0", "sourceIn": 45.0, "sourceOut": 47.5, "durationSec": 2.5,
      "matchedFrameTime": 45.0, "visualDescription": "ทา demo",
      "cutStyle": "jump_cut"
    }
  ]
}
</output_format>"""


DUB_TIMELINE_SYSTEM = """<role>
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


def build_dub_edit_user_text(
    *,
    brief: str,
    user_script: str,
    target_duration_sec: int | None,
    frame_descs: str,
    frame_count: int,
) -> str:
    """Assemble the leading text block of the Vision edit-script request."""
    duration_hint = (
        f"Target video length: ~{target_duration_sec} seconds. totalEstimatedSec = sum of ALL segment durationSec = actual rendered video length. Plan 12–18 lines with multi-angle middle sections so all cuts total ~{target_duration_sec}s — add more lines if needed. "
        if target_duration_sec
        else "No target set — minimum 45s, target 50–60s (standard TikTok affiliate length). totalEstimatedSec = sum of ALL segment durationSec = actual rendered video length. 45s is a hard floor — plan 12–18 lines (≥10 segments), prefer multi-angle on product/demo/OOTD lines, and keep adding until the sum reaches 45s+. "
    )
    creator_input = (
        f"<creator_input>\n"
        f"<brief>{brief or '(ไม่ระบุ)'}</brief>\n"
        f"<user_script>{user_script or '(ไม่ระบุ — generate จากวิดีโอ)'}</user_script>\n"
        f"</creator_input>"
    )
    return (
        f"{creator_input}\n\n"
        f"<frame_timestamps count=\"{frame_count}\">\n{frame_descs}\n</frame_timestamps>\n\n"
        "<instruction>"
        f"{duration_hint}"
        "Catalog the frames, understand the clip, then write the Thai voiceover script and match each line to the best real moments. "
        "Default multi-angle on product/demo/OOTD lines. Follow all system rules (safety, no-prep, frame-match, shot completeness, visual variety, timing, CTA). "
        "Return ONLY the Edit Script JSON."
        "</instruction>"
    )


DUB_EDIT_REMINDER = "<reminder>Return ONLY the Edit Script JSON object — no prose.</reminder>"


async def generate_dub_edit_script(
    frames: list[dict[str, Any]],
    *,
    brief: str,
    user_script: str,
    target_duration_sec: int | None,
    project_uid: str,
    on_thinking: Callable[[str], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Run the single-step Claude Vision call: frames → normalized Edit Script dict."""
    from packages.llm.config import vision_call_kwargs
    from packages.llm.files import delete_message_files
    from packages.llm.gateway import acompletion_stream_thinking
    from packages.video.scene import build_vision_content_uploaded, format_frame_descriptor
    from packages.video.timeline import normalize_dub_edit_script, parse_llm_json

    t_payload = time.monotonic()
    vision_content, vision_stats, uploaded_file_ids = await build_vision_content_uploaded(frames)
    payload_build_ms = round((time.monotonic() - t_payload) * 1000)
    frame_descs = "\n".join(format_frame_descriptor(f) for f in frames)
    user_msg_content: list[dict[str, Any]] = [{"type": "text", "text": build_dub_edit_user_text(
        brief=brief,
        user_script=user_script,
        target_duration_sec=target_duration_sec,
        frame_descs=frame_descs,
        frame_count=len(frames),
    )}]
    user_msg_content.extend(vision_content)
    user_msg_content.append({"type": "text", "text": DUB_EDIT_REMINDER})

    messages = [{"role": "user", "content": user_msg_content}]
    vx = vision_call_kwargs()
    text_chars = len(user_msg_content[0]["text"]) + len(user_msg_content[-1]["text"])
    log.info(
        "analyze_dub_scene_match_payload",
        project_uid=project_uid,
        model=vx.get("model", "default"),
        reasoning_effort=vx.get("reasoning_effort"),
        payload_build_ms=payload_build_ms,
        text_chars=text_chars,
        frame_count=len(frames),
        **vision_stats,
    )

    try:
        resp = await acompletion_stream_thinking(
            messages, system=DUB_EDIT_SYSTEM, project_uid=project_uid,
            on_thinking=on_thinking, **vx
        )
        raw = resp.choices[0].message.content or ""
        edit_script = parse_llm_json(raw)
        return normalize_dub_edit_script(edit_script, sample_frames=frames)
    finally:
        await delete_message_files(uploaded_file_ids)


def build_dub_edit_user_text_video(
    *,
    brief: str,
    user_script: str,
    target_duration_sec: int | None,
) -> str:
    """Assemble the leading text block of the Gemini video edit-script request.

    Same as build_dub_edit_user_text minus the <frame_timestamps> block — Gemini
    watches the video directly, no frame descriptors to hand it.
    """
    duration_hint = (
        f"Target video length: ~{target_duration_sec} seconds. totalEstimatedSec = sum of ALL segment durationSec = actual rendered video length. Plan 12–18 lines with multi-angle middle sections so all cuts total ~{target_duration_sec}s — add more lines if needed. "
        if target_duration_sec
        else "No target set — minimum 45s, target 50–60s (standard TikTok affiliate length). totalEstimatedSec = sum of ALL segment durationSec = actual rendered video length. 45s is a hard floor — plan 12–18 lines (≥10 segments), prefer multi-angle on product/demo/OOTD lines, and keep adding until the sum reaches 45s+. "
    )
    creator_input = (
        f"<creator_input>\n"
        f"<brief>{brief or '(ไม่ระบุ)'}</brief>\n"
        f"<user_script>{user_script or '(ไม่ระบุ — generate จากวิดีโอ)'}</user_script>\n"
        f"</creator_input>"
    )
    return (
        f"{creator_input}\n\n"
        "<instruction>"
        f"{duration_hint}"
        "Catalog the frames, understand the clip, then write the Thai voiceover script and match each line to the best real moments. "
        "Default multi-angle on product/demo/OOTD lines. Follow all system rules (safety, no-prep, frame-match, shot completeness, visual variety, timing, CTA). "
        "Return ONLY the Edit Script JSON."
        "</instruction>"
    )


async def generate_dub_edit_script_video(
    clip_videos: list[tuple[str, pathlib.Path, float]],
    *,
    brief: str,
    user_script: str,
    target_duration_sec: int | None,
    project_uid: str,
    on_thinking: Callable[[str], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Run the Gemini native-video edit-script call: proxy clips → normalized Edit Script dict.

    Each clip is uploaded to the Gemini Files API and referenced by URI (not
    inline base64 — see packages/llm/files.py). sample_frames=None deliberately
    skips frame-anchoring in normalize_dub_edit_script: Gemini picks exact real
    timestamps, so there is nothing to snap to.
    """
    from packages.core.settings import get_settings
    from packages.llm.config import call_kwargs
    from packages.llm.files import delete_gemini_files, gemini_video_block, upload_gemini_file
    from packages.llm.gateway import acompletion_stream_thinking
    from packages.video.timeline import normalize_dub_edit_script, parse_llm_json

    settings = get_settings()
    model = f"gemini/{settings.dub_vision_model}"

    file_ids: list[str] = []
    try:
        t_upload = time.monotonic()
        for _clip_id, path, _duration in clip_videos:
            file_ids.append(await upload_gemini_file(path, mime_type="video/mp4"))
        upload_ms = round((time.monotonic() - t_upload) * 1000)

        user_msg_content: list[dict[str, Any]] = [{"type": "text", "text": build_dub_edit_user_text_video(
            brief=brief,
            user_script=user_script,
            target_duration_sec=target_duration_sec,
        )}]
        for (clip_id, _path, _duration), file_id in zip(clip_videos, file_ids, strict=True):
            user_msg_content.append({"type": "text", "text": f"=== {clip_id} ==="})
            user_msg_content.append(gemini_video_block(file_id))
        user_msg_content.append({"type": "text", "text": DUB_EDIT_REMINDER})

        messages = [{"role": "user", "content": user_msg_content}]
        extra = call_kwargs(model=model)
        extra["timeout"] = settings.dub_vision_timeout_sec

        log.info(
            "analyze_dub_video_payload",
            project_uid=project_uid,
            model=model,
            clip_count=len(clip_videos),
            upload_ms=upload_ms,
        )

        resp = await acompletion_stream_thinking(
            messages, system=DUB_EDIT_SYSTEM_VIDEO, project_uid=project_uid,
            on_thinking=on_thinking, **extra
        )
        raw = resp.choices[0].message.content or ""
        edit_script = parse_llm_json(raw)
        return normalize_dub_edit_script(edit_script, sample_frames=None)
    finally:
        await delete_gemini_files(file_ids)


def build_dub_timeline_prompt(edit_script: dict[str, Any], vo_duration: float) -> str:
    """Assemble the text prompt for the dub timeline planning call."""
    return (
        f"<voiceover>\n"
        f"<voDurationSec>{round(vo_duration, 2)}</voDurationSec>\n"
        f"</voiceover>\n\n"
        f"<edit_script>\n{json.dumps(edit_script, ensure_ascii=False)}\n</edit_script>\n\n"
        f"<instruction>Map each segment to a timeline cut. "
        f"Total cut duration MUST NOT exceed {round(vo_duration, 2)} seconds.</instruction>"
    )


async def plan_dub_timeline_cuts(
    edit_script: dict[str, Any],
    vo_duration: float,
    clip_durations: list[float],
) -> list[dict[str, Any]]:
    """Claude text call mapping Edit Script segments to render cuts.

    Returns localized, length-filtered render cuts (same post-processing the
    worker applies). Raises ValueError on empty/invalid model output.
    """
    from packages.llm.gateway import complete
    from packages.video.timeline import (
        MIN_RENDER_CUT_SEC,
        build_clip_boundaries,
        filter_short_cuts,
        localize_cuts,
        parse_llm_json,
    )

    raw = await complete(build_dub_timeline_prompt(edit_script, vo_duration), system=DUB_TIMELINE_SYSTEM)
    parsed = parse_llm_json(raw)
    raw_cuts = parsed.get("timeline", [])
    if not raw_cuts:
        raise ValueError("Claude returned empty timeline for dub_first")

    boundaries = build_clip_boundaries(clip_durations)
    render_cuts = filter_short_cuts(
        localize_cuts(raw_cuts, boundaries),
        min_sec=MIN_RENDER_CUT_SEC,
    )
    if not render_cuts:
        raise ValueError("No valid cuts remain after localization")
    return render_cuts
