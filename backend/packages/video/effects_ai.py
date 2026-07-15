"""AI-assisted effects placement pass (Gemini).

A SEPARATE stage from the cut/dub AI (own system prompt, own schema, own model
setting) — REMOTION_EFFECTS_REQUIREMENTS.md §3/§8. Watches the already-rendered
cut video and returns effect instances (overlays + transforms) chosen from the
component catalog (effects_catalog.py), placed by moment/time-range, optionally
steered by a free-text user prompt (§3 hard requirement).

Output is a normalized EffectsDoc dict (effects.py) with ``source="ai"`` on every
instance and unknown componentIds dropped, ready to write to effects.json and
feed the render engine (effects_render.py).
"""

from __future__ import annotations

import pathlib
import time
from collections.abc import Awaitable, Callable
from typing import Any

import copy

from packages.core.logging import get_logger
from packages.video.effects import (
    EFFECTS_PLACEMENT_SCHEMA,
    EffectsDoc,
    normalize_effects_doc,
)
from packages.video.effects_catalog import (
    catalog_prompt_text,
    known_component_ids,
    normalize_props_for_component,
)

log = get_logger(__name__)

# Common componentId synonyms the model reaches for despite the enum/prompt,
# mapped to real catalog ids. A safety net; the schema enum is the primary guard.
_COMPONENT_ALIASES: dict[str, str] = {
    "zoom": "punch-zoom",
    "zoom_effect": "punch-zoom",
    "punch_zoom": "punch-zoom",
    "sale_tag": "sticker-badge",
    "promo_banner": "sticker-badge",
    "promo_overlay": "sticker-badge",
    "badge": "sticker-badge",
    "sticker": "sticker-badge",
    "text": "text-reveal",
    "text_overlay": "text-reveal",
    "title": "text-reveal",
}


def _placement_schema_with_enum() -> dict[str, Any]:
    """EFFECTS_PLACEMENT_SCHEMA with componentId constrained to real catalog ids.

    Built at call time (not baked into the static schema) to avoid an import
    cycle effects.py ↔ effects_catalog.py, and so newly-registered components are
    picked up automatically. Constraining componentId as an enum is what actually
    stops Gemini inventing ids like `zoom`/`sale_tag` (observed) — prompt text
    alone does not, same lesson as the dub edit schema.
    """
    schema = copy.deepcopy(EFFECTS_PLACEMENT_SCHEMA)
    schema["properties"]["instances"]["items"]["properties"]["componentId"]["enum"] = sorted(
        known_component_ids()
    )
    return schema


EFFECTS_PLACEMENT_SYSTEM = """<role>
You are a short-form (TikTok) motion-graphics editor. You are given a video that
is ALREADY CUT and finished. Your ONLY job is to decide what animated effects to
layer on top to make it punchier — you do NOT re-cut, re-time, or change the
footage. Do ALL reasoning in English. Any on-screen text you author (labels,
captions) must be in Thai — this is Thai affiliate content.
</role>

<effect_model>
Every effect you place is one instance with: a `kind`, a `componentId` from the
catalog, a `startSec`, a `durationSec`, an optional `zOrder`, and a `props` bag.

Two kinds:
- "overlay"   — an animated element composited ON TOP of the video (stickers,
                badges, popping text). Does not alter the footage.
- "transform" — an effect applied to the FOOTAGE ITSELF (e.g. punch-zoom pushing
                into a product or face). Use sparingly, only on a real focal
                moment.
</effect_model>

<catalog>
Only these components exist. Use ONLY these componentIds and ONLY the listed
props. Do not invent components or props.
{catalog}
</catalog>

<rules>
- `punch-zoom` MUST include `focusX` and `focusY` — these pick the EXACT point
  the zoom pushes into (0..1 across the frame: 0,0=top-left, 1,0=top-right,
  0.5,0.5=center, 0,1=bottom-left, 1,1=bottom-right). Look at the actual frame
  at that moment and set focusX/focusY to the real screen position of the
  product/face/detail you are zooming into — NOT the frame center by default.
  A punch-zoom without focusX/focusY zooms into the center regardless of where
  the product/face actually is, which is almost always wrong.
- If a <script> block is given below, it is the EXACT voiceover/spoken text with
  timing. This is your PRIMARY source for placement — an effect must match not
  just what is visually on screen, but the SPECIFIC WORDS being said at that
  moment (e.g. place a price/promo badge exactly when the price/promo is spoken,
  a punch-zoom when the speaker says something emphatic about the product, a
  text-reveal echoing a keyword just said). Do not place an effect at a time
  whose script line is unrelated to that effect's content. If no <script> is
  given, fall back to visual judgment alone.
- Place effects on SPECIFIC moments, not blanketed across the whole clip. Quality
  over quantity — a few well-timed effects beat clutter. Aim for roughly one
  effect per 3-6 seconds of video unless the user asks otherwise.
- startSec + durationSec must stay within the video length given below. Never
  place an effect past the end.
- ALWAYS fill in EVERY prop listed for that component in the catalog above —
  never leave `propsJson` empty or partial (e.g. shape-highlight needs `shape`
  AND `color` AND `x` AND `y` AND `size`, not just one of them). `propsJson` is
  a JSON OBJECT encoded as a STRING (e.g. "{\\"label\\":\\"ลด 50%\\",\\"x\\":0.5}").
  Choose real values that fit the moment: write the actual Thai label text, pick
  colors that match the scene, set the position (x/y) ON the thing you are
  drawing attention to. Use ONLY the exact enum values listed in the catalog
  (e.g. shape-highlight's `shape` must be exactly one of circle/star/heart/
  spark/arrow — not "rect" or anything else invented). A partial or empty
  propsJson renders a generic placeholder and is wrong.
- Match the clip: pick colors/labels that fit what is on screen at that moment
  (a price/promo badge when a product is shown, a punch-zoom when the creator
  points at a detail, etc.).
- STYLE-MATCH each instance's color props to what is ACTUALLY visible in that
  moment of the footage — look at the real dominant colors on screen (the
  product, the outfit, the background, the lighting mood) and pick a color that
  either matches or deliberately contrasts for legibility, not a generic
  default. Two different clips with different color palettes should NOT get the
  same hardcoded colors — vary bg/color per instance based on the real frame.
- Give overlays that overlap in time distinct zOrder values (higher = on top).
- Respect the user's instruction below if one is given (tone, density, style).
- Return ONLY the placement JSON matching the schema. No prose.
</rules>

<example>
One well-formed instance (componentId/props depend on the real catalog above):
{
  "kind": "overlay",
  "componentId": "sticker-badge",
  "startSec": 6.2,
  "durationSec": 3.5,
  "zOrder": 1,
  "propsJson": "{\\"label\\":\\"ลด 50%\\",\\"emoji\\":\\"🔥\\",\\"bg\\":\\"#FF2D55\\",\\"color\\":\\"#FFFFFF\\",\\"x\\":0.5,\\"y\\":0.15,\\"fontSize\\":72,\\"anim\\":\\"pop\\"}"
}
</example>
"""


def _build_user_text(
    *, brief: str, user_prompt: str, duration_sec: float, script_lines: str = ""
) -> str:
    brief_block = brief.strip() or "(none)"
    prompt_block = user_prompt.strip() or "(none — use your judgment)"
    script_block = (
        f"<script>\n{script_lines.strip()}\n</script>\n"
        if script_lines.strip()
        else ""
    )
    return (
        f"<video_length>{duration_sec:.1f} seconds</video_length>\n"
        f"<creator_brief>{brief_block}</creator_brief>\n"
        f"{script_block}"
        f"<user_instruction>{prompt_block}</user_instruction>\n\n"
        "Watch the whole video, then place effects per the rules"
        + (" — match effects to the exact words in <script> where relevant." if script_block else ".")
        + " Return ONLY the placement JSON."
    )


def _parse_props(inst: dict[str, Any]) -> dict[str, Any]:
    """Extract the param bag, tolerating both `propsJson` (string) and `props`.

    The placement schema returns props as a JSON string in `propsJson` (Gemini
    empties a schemaless object field); parse it back to a dict. Fall back to a
    literal `props` dict if a caller/model provided one directly.
    """
    import json

    raw = inst.get("propsJson")
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                return parsed
        except (ValueError, TypeError):
            log.warning("effects_ai_bad_propsjson", raw=raw[:120])
    props = inst.get("props")
    return props if isinstance(props, dict) else {}


def _sanitize(doc_raw: dict[str, Any], *, duration_sec: float) -> EffectsDoc:
    """Drop unknown components, clamp to the clip length, stamp source=ai."""
    known = known_component_ids()
    kept: list[dict[str, Any]] = []
    for inst in doc_raw.get("instances", []):
        if not isinstance(inst, dict):
            continue
        cid = inst.get("componentId")
        if cid not in known:
            aliased = _COMPONENT_ALIASES.get(str(cid))
            if aliased is None:
                log.warning("effects_ai_unknown_component", componentId=cid)
                continue
            inst = {**inst, "componentId": aliased}
        start = max(0.0, float(inst.get("startSec", 0) or 0))
        dur = max(0.01, float(inst.get("durationSec", 0) or 0))
        # keep the whole window inside the clip
        if start >= duration_sec:
            continue
        dur = min(dur, duration_sec - start)
        props = normalize_props_for_component(inst["componentId"], _parse_props(inst))
        # focusX/focusY are top-level (schema-enforced) fields, not inside
        # propsJson — merge them in here so punch-zoom actually gets a real
        # target point instead of the props-based version that kept getting
        # dropped. normalize_props_for_component already filters to keys the
        # component declares, so this is a no-op for components without them.
        if inst["componentId"] == "punch-zoom":
            for key in ("focusX", "focusY"):
                if key in inst and key not in props:
                    try:
                        props[key] = max(0.0, min(1.0, float(inst[key])))
                    except (TypeError, ValueError):
                        pass
        inst = {
            **{k: v for k, v in inst.items() if k not in ("propsJson", "reason", "focusX", "focusY")},
            "startSec": start,
            "durationSec": dur,
            "props": props,
            "source": "ai",
        }
        kept.append(inst)
    return normalize_effects_doc({"instances": kept})


async def generate_effects_placement(
    video_path: str | pathlib.Path,
    *,
    brief: str = "",
    user_prompt: str = "",
    script_lines: str = "",
    project_uid: str,
    on_thinking: Callable[[str], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Run the Gemini effects placement call over one cut video.

    Returns a normalized effects.json dict (``{"version", "instances"}``). The
    caller sets the UsageCtx before invoking (same pattern as the dub tasks).
    """
    from packages.core.settings import get_settings
    from packages.llm.config import call_kwargs
    from packages.llm.files import delete_gemini_files, gemini_video_block, upload_gemini_file
    from packages.llm.gateway import acompletion_stream_thinking
    from packages.video.ffmpeg_bin import media_duration
    from packages.video.timeline import parse_llm_json

    settings = get_settings()
    model = f"gemini/{settings.effects_vision_model}"
    video_path = pathlib.Path(video_path)
    duration_sec = media_duration(video_path)

    file_ids: list[str] = []
    try:
        t_upload = time.monotonic()
        file_ids.append(await upload_gemini_file(video_path, mime_type="video/mp4"))
        upload_ms = round((time.monotonic() - t_upload) * 1000)

        system = EFFECTS_PLACEMENT_SYSTEM.replace("{catalog}", catalog_prompt_text())
        user_content: list[dict[str, Any]] = [
            {"type": "text", "text": "=== cut video ==="},
            gemini_video_block(file_ids[0]),
            {"type": "text", "text": _build_user_text(
                brief=brief, user_prompt=user_prompt, duration_sec=duration_sec,
                script_lines=script_lines,
            )},
        ]
        messages = [{"role": "user", "content": user_content}]

        # "high" not "medium": this call's failure mode is silently incomplete
        # propsJson (empty {} / half-filled), which degrades to generic
        # placeholder visuals instead of erroring — worth the extra reasoning
        # budget for reliability, observed empirically (medium regularly
        # skipped color/label props under the fuller style-matching prompt).
        extra = call_kwargs(model=model, effort="high")
        extra["timeout"] = settings.effects_vision_timeout_sec
        extra["response_format"] = {
            "type": "json_object",
            "response_schema": _placement_schema_with_enum(),
            "enforce_validation": True,
        }

        log.info(
            "effects_ai_payload",
            project_uid=project_uid,
            model=model,
            duration_sec=round(duration_sec, 1),
            upload_ms=upload_ms,
        )

        resp = await acompletion_stream_thinking(
            messages, system=system, project_uid=project_uid,
            on_thinking=on_thinking, **extra
        )
        raw = resp.choices[0].message.content or ""
        placement = parse_llm_json(raw)
        doc = _sanitize(placement, duration_sec=duration_sec)
        log.info("effects_ai_done", project_uid=project_uid, instances=len(doc.instances))
        return doc.model_dump()
    finally:
        await delete_gemini_files(file_ids)
