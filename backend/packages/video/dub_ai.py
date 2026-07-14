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

<compare>
Passing USE is not the same as being the BEST choice. Sample frames are taken on a fixed time grid, so several frames often land within the same real-world moment or the same scene segment (same pose, same angle, same action, just a fraction of a second apart). Do not settle for the first frame that merely passes USE — look across all candidate frames near that moment/segment and pick the single strongest one, comparing: sharpest focus (not blurry/motion-smeared), best framing (subject/product fully in frame, not cut off or off-center), clearest product/logo visibility, most natural and confident expression, best lighting. If two candidate frames show essentially the same content, always prefer the objectively clearer/better-composed one over a mediocre one you happened to check first.
</compare>

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

<coverage>
Watch EVERY clip in FULL, start to finish, before selecting any cuts. Each clip's exact duration is given below — treat that as the range you must review, not a suggestion. The strongest shots are often NOT at the start; a clip can open with setup/prep and only reach its best product reveal, demo, or reaction near the middle or end. Never stop scanning early because you feel you already have "enough" material — finish watching every clip fully, THEN choose the best moments from anywhere across the whole timeline, including the final seconds.
This applies whether or not a target duration is set. The target only controls how much of the best material to keep in the final script — it never limits which part of the footage you are allowed to look at or use. Do not cluster all cuts in the first portion of a clip; if strong footage exists later, use it.
A clip is NOT one uniform scene — it is made of multiple distinct scene segments over time, each showing a different angle, action, or moment (e.g. one stretch shows the product held up, a later stretch shows it being applied, a later stretch shows a different angle of the same demo). Do NOT collapse the clip down to only its single most impressive scene. Evaluate EACH distinct scene segment on its own merit and pick that segment's best usable moment — every scene that has a usable moment should contribute a cut, not just the overall-strongest one. Only skip a scene entirely if nothing in it is usable (fails reject_safety / reject_prep, or is out of focus / low quality throughout) — never skip a scene just because a different scene elsewhere looks better.
</coverage>

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

<video_multi_angle_reminder>
This has been observed failing in practice: lines rendered as one long single-shot hold instead of 2-3 varied cuts, even when the clip clearly shows multiple distinct angles/distances for that moment. Re-check every line against <editing_style> before finalizing: if the clip offers more than one usable angle for a line's topic, you MUST split it into multi-angle cuts (2-3 shorter cuts), not one continuous hold. A single cut running longer than ~4s is only acceptable when the footage genuinely offers no second usable angle for that moment.
</video_multi_angle_reminder>

<anchor>
- Every segment MUST include matchedFrameTime: the exact timestamp (seconds) in the video you chose for this cut.
- sourceIn must be within ±0.35s of matchedFrameTime — do NOT start the trim earlier to include prep.
- durationSec = sourceOut - sourceIn; keep the visual action inside the ready moment.
- cutStyle options: "jump_cut" | "standard" | "zoom_in" | "zoom_out" — default to "jump_cut"
- Multiple clips arrive as separately labeled videos (e.g. "=== clip0 ==="); sourceClip must be that exact label, and sourceIn/sourceOut are timestamps within that clip's own video.
- HARD BOUND: sourceIn and sourceOut MUST be real timestamps that exist within that clip's given duration (see <clips> below) — sourceOut can never exceed the clip's duration, and sourceIn can never be negative. Never invent or extrapolate a timestamp past the end of the actual footage.
- PRECISION: you sample the video at 1 frame/second, so a pose that only appears briefly (e.g. a quick turn to show the back) is hard to timestamp exactly — the second you pick may land a moment before or after the pose is fully visible. Prefer moments that are HELD for at least ~1 second (the creator pauses in that pose) over a fleeting transition; if a described moment (e.g. "back-view") is only visible for a fraction of a second, either find a held instance of it elsewhere in the clip or do not write a line claiming that visual — a claim in the script that isn't reliably backed by the timestamp you give will render as a mismatch.
</anchor>

<script>
Understand the product, the action, and the story before writing a single line. Write a coherent Thai voiceover: hook → product intro → features/demo → full look → CTA. Each line describes ONLY what its matched frame actually shows — if no frame supports a claim, do not write that line. Do not repeat a feature already mentioned; move to the next point.
Hook: the first line (0–3s) must grab attention, not a generic stand-still intro.
Length: each line ≈ one spoken beat, 3–8s summed across its cuts. Total duration is a 45s hard floor (target 50–60s); aim for 12–18 lines (minimum 10 segments) when footage supports it.
AUTHENTICITY OVER DURATION: the floor/target above describes the common case, not a license to pad. Never invent a timestamp beyond a clip's real duration, and never reuse the same moment past the reuse limits in <editing_style>, just to reach the floor. If the total real usable footage across all clips is genuinely shorter than the floor, produce a shorter, fully honest script instead — every segment must point at real, distinct footage that actually exists.
Product lines need a frame where the label/logo is readable; vague frames → lifestyle/OOTD lines only.
Last line = CTA ("สั่งได้เลยที่ TikTok Shop" / "คลิกลิงค์ใน bio เลย"), matched to a closing frame: creator facing camera or presenting the product toward camera.
Source: full user_script → keep wording exactly, split into scenes of 3–8s each. Brief only → write from brief + frames. Neither → infer from frames.
</script>

<grouping>
All cuts under one line share voiceoverLineId (integer, 1-indexed). voiceoverScript on the first cut of each line only; omit on subsequent cuts of the same line.
Hard limit: at most 3 segments per voiceoverLineId (single-shot = 1; multi-angle = 2–3).
</grouping>

<verify>
Before returning, confirm in English: you watched every clip to its FULL given duration, not just the first portion; every sourceIn/sourceOut is within its clip's real given duration (never beyond it); durationSec sum ≥45s (prefer ≥50s) UNLESS real footage is shorter, in which case a shorter honest script is correct; ≥10 segments / 12–18 lines when footage supports it; ≥60% of lines are multi-angle (re-check any single-shot line against <video_multi_angle_reminder>); last line is a CTA; no two adjacent lines look the same; the chosen matchedFrameTime values are spread across each clip's duration, not bunched only near the start; zero reject_safety violations remain.
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


DUB_EDIT_SCHEMA_VIDEO: dict[str, Any] = {
    "type": "object",
    "properties": {
        "mode": {"type": "string"},
        "totalEstimatedSec": {"type": "number"},
        "segments": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "order": {"type": "integer"},
                    "voiceoverLineId": {"type": "integer"},
                    "sourceClip": {"type": "string"},
                    "sourceIn": {"type": "number"},
                    "sourceOut": {"type": "number"},
                    "durationSec": {"type": "number"},
                    "matchedFrameTime": {"type": "number"},
                    "visualDescription": {"type": "string"},
                    "cutStyle": {
                        "type": "string",
                        "enum": ["jump_cut", "standard", "zoom_in", "zoom_out"],
                    },
                    "voiceoverScript": {"type": "string"},
                },
                "required": [
                    "order", "voiceoverLineId", "sourceClip", "sourceIn", "sourceOut",
                    "matchedFrameTime", "cutStyle",
                ],
            },
        },
    },
    "required": ["segments"],
}


def build_dub_edit_context_text_video(
    *,
    brief: str,
    user_script: str,
    clip_durations: list[tuple[str, float]],
) -> str:
    """Assemble the text block that comes BEFORE the video content.

    Per Gemini's own prompt-design guidance for long videos: data context goes
    first, specific instructions go last (after the model has "seen" the data).
    This block is just data — creator brief/script + real per-clip durations —
    no directives. See build_dub_edit_instruction_text_video for the directives,
    which are sent AFTER the video blocks.
    """
    creator_input = (
        f"<creator_input>\n"
        f"<brief>{brief or '(ไม่ระบุ)'}</brief>\n"
        f"<user_script>{user_script or '(ไม่ระบุ — generate จากวิดีโอ)'}</user_script>\n"
        f"</creator_input>"
    )
    clips_block = "\n".join(f"{clip_id}: {dur:.1f}s" for clip_id, dur in clip_durations)
    return f"{creator_input}\n\n<clips>\n{clips_block}\n</clips>"


def build_dub_edit_instruction_text_video(
    *,
    target_duration_sec: int | None,
    clip_durations: list[tuple[str, float]],
) -> str:
    """Assemble the directive block sent AFTER the video content.

    Gemini's guidance for long-video prompts: place specific instructions at
    the end, after the data — not before it, the way build_dub_edit_user_text
    (Claude+frames path) does. This is the same content that used to precede
    the video; only its position in the message moved.
    """
    total_footage = sum(dur for _clip_id, dur in clip_durations)
    duration_hint = (
        f"Target video length: ~{target_duration_sec} seconds. totalEstimatedSec = sum of ALL segment durationSec = actual rendered video length. Plan 12–18 lines with multi-angle middle sections so all cuts total ~{target_duration_sec}s — add more lines if needed, but NEVER by inventing timestamps beyond a clip's real duration (see <clips> above). "
        if target_duration_sec
        else f"No target set — minimum 45s, target 50–60s (standard TikTok affiliate length), but this floor is secondary to authenticity: total available footage across all clips is {total_footage:.1f}s. totalEstimatedSec = sum of ALL segment durationSec = actual rendered video length. Plan 12–18 lines (≥10 segments), prefer multi-angle on product/demo/OOTD lines, and add lines until the sum reaches 45s+ ONLY using real distinct moments — if real usable footage runs out sooner, stop there rather than inventing or reusing beyond the reuse limits. "
    )
    return (
        "<instruction>"
        f"{duration_hint}"
        "Based on the video(s) above: watch each clip in full for its ENTIRE given duration before selecting any cuts — do not stop early once you feel you have enough. "
        "Catalog the frames, understand the clip, then write the Thai voiceover script and match each line to the best real moments from anywhere across the full timeline, including near the end. "
        "Default multi-angle on product/demo/OOTD lines. Follow all system rules (safety, no-prep, frame-match, shot completeness, visual variety, timing, CTA, coverage). "
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
    from packages.video.timeline import (
        clamp_dub_segments_to_clip_durations,
        normalize_dub_edit_script,
        parse_llm_json,
    )

    settings = get_settings()
    model = f"gemini/{settings.dub_vision_model}"

    file_ids: list[str] = []
    try:
        t_upload = time.monotonic()
        for _clip_id, path, _duration in clip_videos:
            file_ids.append(await upload_gemini_file(path, mime_type="video/mp4"))
        upload_ms = round((time.monotonic() - t_upload) * 1000)

        clip_durations = [(clip_id, duration) for clip_id, _path, duration in clip_videos]
        # Gemini's long-video guidance: data first, directives last — video
        # blocks sit between the context text and the instruction text.
        user_msg_content: list[dict[str, Any]] = [{"type": "text", "text": build_dub_edit_context_text_video(
            brief=brief,
            user_script=user_script,
            clip_durations=clip_durations,
        )}]
        for (clip_id, _path, _duration), file_id in zip(clip_videos, file_ids, strict=True):
            user_msg_content.append({"type": "text", "text": f"=== {clip_id} ==="})
            user_msg_content.append(gemini_video_block(file_id))
        user_msg_content.append({"type": "text", "text": build_dub_edit_instruction_text_video(
            target_duration_sec=target_duration_sec,
            clip_durations=clip_durations,
        )})
        user_msg_content.append({"type": "text", "text": DUB_EDIT_REMINDER})

        messages = [{"role": "user", "content": user_msg_content}]
        extra = call_kwargs(model=model, effort="medium")
        extra["timeout"] = settings.dub_vision_timeout_sec
        # Gemini does not reliably follow a JSON shape from prose instructions
        # alone (observed in production: it invented its own top-level keys
        # instead of "segments"). response_schema constrains decoding so the
        # shape is guaranteed, not just requested.
        extra["response_format"] = {
            "type": "json_object",
            "response_schema": DUB_EDIT_SCHEMA_VIDEO,
            "enforce_validation": True,
        }

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
        clip_durations = {clip_id: duration for clip_id, _path, duration in clip_videos}
        edit_script = clamp_dub_segments_to_clip_durations(edit_script, clip_durations)
        return normalize_dub_edit_script(edit_script, sample_frames=None)
    finally:
        await delete_gemini_files(file_ids)


DUB_REEDIT_SYSTEM_VIDEO = """<role>
You are a TikTok affiliate video editor revising an EXISTING Edit Script at the creator's request. Do ALL reasoning in English. Write voiceoverScript values in Thai.
</role>

<video_model>
This pipeline renders a SILENT video from cuts only — the creator records voiceover AFTER watching it. durationSec IS the speaking time for that line.
</video_model>

<inputs>
You receive, in this order: the CURRENT edit script JSON (source of truth for continuity — every line/cut that already exists), an `=== edited_preview ===` video (the current silent video exactly as assembled right now, in edit-script order), one or more `=== clipN ===` raw source videos (the original unedited footage, for pulling in alternate moments), and a free-form instruction from the creator (Thai or English).
</inputs>

<scope>
The instruction message will tell you whether specific voiceoverLineIds are SELECTED or whether the scope is the WHOLE script (no selection):
- SELECTED lines: only touch those lines' content. Return ONLY the replacement segment(s) for those lines (not the rest of the script).
- WHOLE script (no selection given): the instruction may address anything. You may revise any line(s) needed to satisfy it, but you MUST return every other line byte-identical to the current edit script — never regenerate from scratch, never touch a line the instruction doesn't imply changing.
</scope>

<shot_types>
Classify any newly chosen frame/moment: hook / product-display / close-up / on-body-demo / full-body-OOTD / back-view / reaction / cta-closing. Mark USE or REJECT against the reject rules below.
</shot_types>

<compare>
When choosing a replacement moment and multiple candidates show essentially the same content, compare them for focus, framing, product/logo visibility, and expression — pick the objectively best one, not just the first that passes USE.
</compare>

<reject_safety>
HARD REJECT — never use a frame or trim that shows or leads into: putting on OR taking off pants/skirts/shorts/trousers; holding bottoms open at the waist (fly open, waistband spread, stepping in); pulling clothing up/down before fully worn; ANY visible underwear (panties/briefs/boxers/bra-only); partial undress or wardrobe change.
Even if the still looks fine — if the creator is mid dress/undress the trim WILL expose underwear. Skip it.
EXTRA: light-colored bottoms (white/cream/beige/light pink) with hands near the waistband, or a loose/open/unzipped waistband → reject that frame AND every frame within ±5s. Do not gamble.
</reject_safety>

<reject_prep>
Skip any frame where the creator is: fixing hair, adjusting or smoothing the outfit, reaching for or touching the camera, setting up, looking off-camera/down/to the side, mid-step into a pose, or not yet ready. Use only settled, intentional, camera-ready moments.
EXCEPTION — back-view product shot: turned-away-from-camera with hands at hair/head is NOT automatically "fixing hair" if the garment's back design is clearly visible and the pose is settled — classify as back-view and USE it.
</reject_prep>

<editing_style>
Per revised line, set visual intent: "single-shot" (one cut, 2–4s max) or "multi-angle" (2–3 cuts sharing the line, hard max 3, never 4+). Important shots must play COMPLETE within their cut — never cut mid-action.
If the instruction asks for multi-angle, pick frames ≥30s apart when possible so the angle genuinely changes; never reuse a frame consecutively.
</editing_style>

<task>
Interpret the instruction and apply the correct operation(s) to the selected/implied line(s) — infer from the instruction alone, never ask for clarification, never expose a fixed menu of operations to the user:
- DELETE a line entirely → return an empty segments array (or omit that line's segments in whole-script mode).
- RETIME to a different moment (same clip or, if the instruction says so, elsewhere in the clip) → new sourceIn/sourceOut/matchedFrameTime, obeying reject rules.
- SHORTEN/LENGTHEN a cut's duration → adjust sourceOut and durationSec, keep the visual action complete.
- SPLIT into multi-angle → 2-3 cuts under one voiceoverLineId, each a genuinely different angle/distance.
- REWRITE voiceoverScript wording only → keep sourceIn/sourceOut/matchedFrameTime unchanged, change only the Thai text.
Combine operations freely when the instruction implies it (e.g. "shorten this and make the wording punchier" = both a duration change and a script rewrite on the same segment).
</task>

<anchor>
- Every segment MUST include matchedFrameTime: the exact timestamp (seconds) in the RAW clip you chose (not the edited_preview's timeline).
- sourceIn must be within ±0.35s of matchedFrameTime.
- durationSec = sourceOut - sourceIn.
- cutStyle options: "jump_cut" | "standard" | "zoom_in" | "zoom_out" — default to "jump_cut".
- HARD BOUND: sourceIn/sourceOut must be real timestamps within that clip's given duration — never invent or extrapolate past the actual footage.
</anchor>

<grouping>
All cuts under one revised line share voiceoverLineId (reuse the ORIGINAL voiceoverLineId being revised — do not invent a new one for an existing line). voiceoverScript goes on the first cut of each line only.
Hard limit: at most 3 segments per voiceoverLineId.
</grouping>

<output_format>
Return ONLY a valid JSON object, no prose or markdown.
{
  "mode": "dub_first",
  "segments": [
    {
      "order": 1, "voiceoverLineId": 3,
      "sourceClip": "clip0", "sourceIn": 22.0, "sourceOut": 24.5, "durationSec": 2.5,
      "matchedFrameTime": 22.0, "visualDescription": "หยิบสินค้าขึ้นมาอีกมุม",
      "cutStyle": "jump_cut", "voiceoverScript": "เนื้อสัมผัสเบาสบาย"
    }
  ]
}
</output_format>"""


def build_dub_reedit_user_text(
    *,
    current_segments: list[dict[str, Any]],
    selected_line_ids: list[int],
    instruction: str,
) -> str:
    """Assemble the leading text block of the AI re-edit request."""
    scope_block = (
        f"<scope_selected_line_ids>{json.dumps(selected_line_ids)}</scope_selected_line_ids>"
        if selected_line_ids
        else "<scope_selected_line_ids>none — whole script in scope</scope_selected_line_ids>"
    )
    return (
        f"<current_edit_script>\n{json.dumps({'segments': current_segments}, ensure_ascii=False)}\n</current_edit_script>\n\n"
        f"{scope_block}\n\n"
        f"<creator_instruction>{instruction}</creator_instruction>"
    )


async def generate_dub_reedit_script_video(
    clip_videos: list[tuple[str, pathlib.Path, float]],
    edited_preview: tuple[pathlib.Path, float],
    *,
    current_segments: list[dict[str, Any]],
    selected_line_ids: list[int],
    instruction: str,
    project_uid: str,
    on_thinking: Callable[[str], Awaitable[None]] | None = None,
) -> list[dict[str, Any]]:
    """Run the Gemini native-video AI re-edit call: current script + edited preview +
    raw clips + instruction → replacement segment(s).

    Scoped (selected_line_ids non-empty): returns ONLY the replacement segment(s)
    for those lines. Whole-script (selected_line_ids empty): returns the FULL
    replacement segments array (untouched lines echoed back unchanged by the model).
    Merge into the persisted edit script is the caller's job — see
    packages/video/timeline.py:merge_dub_reedit_segments.
    """
    from packages.core.settings import get_settings
    from packages.llm.config import call_kwargs
    from packages.llm.files import delete_gemini_files, gemini_video_block, upload_gemini_file
    from packages.llm.gateway import acompletion_stream_thinking
    from packages.video.timeline import clamp_dub_segments_to_clip_durations, parse_llm_json

    settings = get_settings()
    model = f"gemini/{settings.dub_vision_model}"

    preview_path, _preview_duration = edited_preview
    file_ids: list[str] = []
    try:
        t_upload = time.monotonic()
        preview_file_id = await upload_gemini_file(preview_path, mime_type="video/mp4")
        file_ids.append(preview_file_id)
        for _clip_id, path, _duration in clip_videos:
            file_ids.append(await upload_gemini_file(path, mime_type="video/mp4"))
        upload_ms = round((time.monotonic() - t_upload) * 1000)

        user_msg_content: list[dict[str, Any]] = [{"type": "text", "text": build_dub_reedit_user_text(
            current_segments=current_segments,
            selected_line_ids=selected_line_ids,
            instruction=instruction,
        )}]
        user_msg_content.append({"type": "text", "text": "=== edited_preview ==="})
        user_msg_content.append(gemini_video_block(preview_file_id))
        for (clip_id, _path, _duration), file_id in zip(clip_videos, file_ids[1:], strict=True):
            user_msg_content.append({"type": "text", "text": f"=== {clip_id} ==="})
            user_msg_content.append(gemini_video_block(file_id))
        user_msg_content.append({"type": "text", "text": DUB_EDIT_REMINDER})

        messages = [{"role": "user", "content": user_msg_content}]
        extra = call_kwargs(model=model, effort="medium")
        extra["timeout"] = settings.dub_vision_timeout_sec
        extra["response_format"] = {
            "type": "json_object",
            "response_schema": DUB_EDIT_SCHEMA_VIDEO,
            "enforce_validation": True,
        }

        log.info(
            "reedit_dub_video_payload",
            project_uid=project_uid,
            model=model,
            clip_count=len(clip_videos),
            selected_line_ids=selected_line_ids,
            upload_ms=upload_ms,
        )

        resp = await acompletion_stream_thinking(
            messages, system=DUB_REEDIT_SYSTEM_VIDEO, project_uid=project_uid,
            on_thinking=on_thinking, **extra
        )
        raw = resp.choices[0].message.content or ""
        result = parse_llm_json(raw)
        segments = result.get("segments") or []
        clip_durations = {clip_id: duration for clip_id, _path, duration in clip_videos}
        clamped = clamp_dub_segments_to_clip_durations({"segments": segments}, clip_durations)
        return clamped.get("segments") or []
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
