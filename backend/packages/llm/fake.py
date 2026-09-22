"""LOAD-TEST fake AI: canned vendor answers behind the real call path.

Switched on by ``LOADTEST_FAKE_AI=1`` (settings refuse to load it in a
production environment — see ``packages/core/settings.py``). It replaces
exactly the three places that would otherwise reach a paid vendor:

* the ``litellm.acompletion`` call inside ``packages/llm/gateway.py``
  (``acompletion`` and ``acompletion_stream_thinking``),
* the Files API upload/delete in ``packages/llm/files.py``,
* the Scribe POST in ``packages/video/elevenlabs_stt.py``.

Everything around those calls stays real: the verified-email gate, the per-call
billing guard, the Redis vendor slots, the durable metering rows, the arq
queue, DB, Redis and S3. So a load test measures the real system with the
vendors' latency simulated by a sleep.

Answers are shaped per caller, detected from the request itself (the response
schema a caller sends, or a marker in its prompt), so every parser downstream
accepts them: dub edit scripts with alternates inside the real clip bounds,
re-edit replacement segments, dub timeline cuts, speech-mode picks and trim
verdicts, effects placement, style/cut distillation checklists. Usage token
counts come from the guard's own input estimate plus a per-caller output size,
so reservations settle on realistic numbers.
"""

from __future__ import annotations

import asyncio
import json
import random
import re
import uuid
from collections.abc import AsyncIterator, Sequence
from typing import Any

from packages.core.logging import get_logger

log = get_logger(__name__)

#: Prefix of every fake Files API id — lets delete calls recognise them.
FAKE_FILE_PREFIX = "loadtest-fake-file/"

#: Visible-output token counts per answer kind (what the real calls measured
#: roughly produce), and the thinking budget billed on top as output.
_OUTPUT_TOKENS = {
    "dub_edit": 2_600,
    "dub_reedit": 900,
    "dub_timeline": 700,
    "speech_highlights": 900,
    "speech_scenes": 700,
    "speech_trim": 500,
    "effects": 800,
    "observation": 700,
    "frames_edit": 2_400,
    "generic": 300,
}
_THINKING_TOKENS = 2_500

#: Input fallback when no billing estimate is available (no paid run active).
_VIDEO_BLOCK_TOKENS = 25_000


# ── switches ──────────────────────────────────────────────────────────────────


def active() -> bool:
    """Whether fake AI is on. Re-checks the production guard on every call so a
    vendor call can never be faked in production even if settings were cached
    before the environment said so."""
    from packages.core.settings import (
        FakeAIInProduction,
        get_settings,
        production_environment_marker,
    )

    if not get_settings().loadtest_fake_ai:
        return False
    env = production_environment_marker()
    if env:
        raise FakeAIInProduction(f"LOADTEST_FAKE_AI is on but {env} — refusing to fake an AI call")
    return True


def _jittered(base: float) -> float:
    from packages.core.settings import get_settings

    jitter = max(0.0, min(0.95, float(get_settings().loadtest_fake_ai_jitter)))
    return max(0.0, float(base) * random.uniform(1.0 - jitter, 1.0 + jitter))


async def sleep_model() -> float:
    from packages.core.settings import get_settings

    delay = _jittered(get_settings().loadtest_fake_ai_delay_sec)
    await asyncio.sleep(delay)
    return delay


async def sleep_stt() -> float:
    from packages.core.settings import get_settings

    delay = _jittered(get_settings().loadtest_fake_stt_delay_sec)
    await asyncio.sleep(delay)
    return delay


async def sleep_upload() -> None:
    from packages.core.settings import get_settings

    await asyncio.sleep(_jittered(get_settings().loadtest_fake_upload_sec))


def fake_file_id(filename: str) -> str:
    return f"{FAKE_FILE_PREFIX}{uuid.uuid4().hex[:12]}-{filename[:40]}"


def is_fake_file_id(file_id: str) -> bool:
    return str(file_id or "").startswith(FAKE_FILE_PREFIX)


# ── request inspection ────────────────────────────────────────────────────────


def _texts(messages: Sequence[dict[str, Any]], *, role: str | None = None) -> str:
    out: list[str] = []
    for m in messages:
        if role is not None and m.get("role") != role:
            continue
        content = m.get("content")
        if isinstance(content, str):
            out.append(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    out.append(str(block.get("text") or ""))
    return "\n".join(out)


def _file_blocks(messages: Sequence[dict[str, Any]]) -> int:
    n = 0
    for m in messages:
        content = m.get("content")
        if isinstance(content, list):
            n += sum(1 for b in content if isinstance(b, dict) and b.get("type") in ("file", "image_url"))
    return n


def _schema(kwargs: dict[str, Any]) -> dict[str, Any] | None:
    rf = kwargs.get("response_format")
    if isinstance(rf, dict) and isinstance(rf.get("response_schema"), dict):
        return rf["response_schema"]
    return None


_CLIP_BOUND_RE = re.compile(r"(?m)^(\S+): (\d+(?:\.\d+)?)s — valid timestamps")
_CLIP_MARKER_RE = re.compile(r"=== (clip\w*) ===")
_TRANSCRIPT_LINE_RE = re.compile(r"(?m)^#(\d+)\b")
_FRAME_RE = re.compile(r"\[(\S+) [^\]]*? at (\d+(?:\.\d+)?)s")


def _between(text: str, tag: str) -> str | None:
    m = re.search(rf"<{tag}>\s*(.*?)\s*</{tag}>", text, re.DOTALL)
    return m.group(1) if m else None


# ── answer builders ───────────────────────────────────────────────────────────

_THAI_LINES = [
    "ของมันต้องมี ใช้แล้วติดใจ",
    "ดูใกล้ ๆ เนื้อสัมผัสดีมาก",
    "ใส่แล้วสบาย ใช้ได้ทุกวัน",
    "มาดูรายละเอียดกันชัด ๆ",
    "ราคานี้คุ้มสุด ๆ",
    "กดตะกร้าเลย ของมีจำนวนจำกัด",
]


def _dub_edit(text: str) -> dict[str, Any]:
    """A fresh dub edit script: short distinct cuts inside every clip's real
    bounds, clear of the last 2.2 s of each take, each with one alternate."""
    bounds = [(c, float(d)) for c, d in _CLIP_BOUND_RE.findall(text)]
    if not bounds:
        bounds = [(c, 8.0) for c in dict.fromkeys(_CLIP_MARKER_RE.findall(text))] or [("clip0", 8.0)]
    segments: list[dict[str, Any]] = []
    order = 0
    for clip, dur in bounds:
        usable = max(0.0, dur - 2.2)
        t = 0.3
        while t + 1.2 <= usable and order < 14:
            length = min(1.6, usable - t)
            order += 1
            line_id = (order + 1) // 2
            seg: dict[str, Any] = {
                "order": order,
                "voiceoverLineId": line_id,
                "sourceClip": clip,
                "sourceIn": round(t, 2),
                "sourceOut": round(t + length, 2),
                "durationSec": round(length, 2),
                "matchedFrameTime": round(t + length / 2, 2),
                "visualDescription": "loadtest: product shown to camera",
                "cutStyle": "jump_cut" if order % 2 else "standard",
                "voiceoverScript": _THAI_LINES[(line_id - 1) % len(_THAI_LINES)] if order % 2 else "",
                "alternates": [],
            }
            alt_in = t + length + 0.1
            if alt_in + 0.8 <= usable:
                seg["alternates"] = [{
                    "sourceClip": clip,
                    "sourceIn": round(alt_in, 2),
                    "sourceOut": round(min(usable, alt_in + 1.2), 2),
                    "matchedFrameTime": round(alt_in + 0.4, 2),
                    "note": "มุมสำรอง (loadtest)",
                }]
            segments.append(seg)
            t += length + 0.3
    if not segments:
        clip, dur = bounds[0]
        end = round(max(0.6, min(dur, 1.6)), 2)
        segments.append({
            "order": 1, "voiceoverLineId": 1, "sourceClip": clip,
            "sourceIn": 0.0, "sourceOut": end, "durationSec": end, "matchedFrameTime": round(end / 2, 2),
            "visualDescription": "loadtest", "cutStyle": "standard",
            "voiceoverScript": _THAI_LINES[0], "alternates": [],
        })
    total = round(sum(float(s["durationSec"]) for s in segments), 2)
    return {
        "clipBounds": [{"clip": c, "endsAt": d} for c, d in bounds],
        "mode": "dub_first",
        "totalEstimatedSec": total,
        "segments": segments,
    }


def _dub_reedit(text: str) -> dict[str, Any]:
    """Echo the current script back (scoped: only the selected lines), with the
    revised lines' wording marked — the merge downstream is real."""
    try:
        current = json.loads(_between(text, "current_edit_script") or "{}").get("segments") or []
    except json.JSONDecodeError:
        current = []
    scope = _between(text, "scope_selected_line_ids") or ""
    selected: set[int] = set()
    if scope.startswith("["):
        try:
            selected = {int(x) for x in json.loads(scope)}
        except (json.JSONDecodeError, TypeError, ValueError):
            selected = set()
    out: list[dict[str, Any]] = []
    for seg in current:
        if not isinstance(seg, dict):
            continue
        lid = seg.get("voiceoverLineId")
        if selected and lid not in selected:
            continue
        copy_seg = {**seg}
        copy_seg.setdefault("alternates", [])
        if seg.get("voiceoverScript"):
            copy_seg["voiceoverScript"] = f"{seg['voiceoverScript']} (แก้แล้ว)"
        out.append(copy_seg)
    return {"mode": "dub_first", "segments": out}


def _dub_timeline(text: str) -> dict[str, Any]:
    """Map every edit-script segment onto the voiceover length, proportionally."""
    try:
        script = json.loads(_between(text, "edit_script") or "{}")
    except json.JSONDecodeError:
        script = {}
    vo = float(_between(text, "voDurationSec") or 30.0)
    segs = [s for s in (script.get("segments") or []) if isinstance(s, dict)]
    total = sum(max(0.1, float(s.get("durationSec") or 0) or 1.0) for s in segs) or 1.0
    timeline: list[dict[str, Any]] = []
    for s in segs:
        share = max(0.1, float(s.get("durationSec") or 0) or 1.0) / total * vo
        start = float(s.get("sourceIn") or 0.0)
        timeline.append({
            "type": "cut",
            "source": str(s.get("sourceClip") or "clip0"),
            "in": round(start, 2),
            "out": round(start + share, 2),
            "label": str(s.get("visualDescription") or "loadtest")[:40],
        })
    return {"timeline": timeline}


def _transcript_count(text: str) -> int:
    nums = [int(n) for n in _TRANSCRIPT_LINE_RE.findall(text)]
    return (max(nums) + 1) if nums else 0


def _speech_picks(text: str, *, highlights: bool) -> dict[str, Any]:
    n = _transcript_count(text)
    if n == 0:
        return {"picks": []}
    size = max(1, n // 3) if highlights else max(1, n // 4)
    picks: list[dict[str, Any]] = []
    start = 0
    while start < n and len(picks) < 5:
        end = min(n - 1, start + size - 1)
        pick: dict[str, Any] = {"segFrom": start, "segTo": end, "why": "loadtest pick"}
        if highlights:
            pick.update({
                "score": 8, "title": f"ไฮไลต์ {len(picks) + 1}",
                "opensWith": "loadtest", "endsWith": "loadtest",
            })
        picks.append(pick)
        start = end + (1 if highlights else 2)
    return {"picks": picks}


def _speech_trim(text: str) -> dict[str, Any]:
    n = _transcript_count(text)
    return {
        "story": {"subject": "loadtest", "payoff": "loadtest"},
        "verdicts": [{"n": i, "v": "keep", "why": "loadtest"} for i in range(n)],
        "opening": {"firstKept": 0, "whyItOpens": "loadtest"},
        "closing": {"lastKept": max(0, n - 1), "promiseKept": "loadtest", "whyNothingAfterIsNeeded": "loadtest"},
    }


def _effects() -> dict[str, Any]:
    return {
        "zoomPunches": [{
            "startSec": 1.0, "durationSec": 1.4, "focusX": 0.5, "focusY": 0.42,
            "focusOn": "product label", "zoomFrom": 1.0, "zoomTo": 1.3, "style": "push",
            "rampSec": 0.4, "driftX": 0.5, "driftY": 0.42,
        }],
        "transitions": [],
        "sceneDrifts": [],
    }


def _frames_edit(text: str) -> dict[str, Any]:
    """Legacy frames path (Claude vision): one cut per sampled frame, snapped by
    the caller's own frame anchoring."""
    frames = [(c, float(t)) for c, t in _FRAME_RE.findall(text)][:12]
    segments = []
    for i, (clip, t) in enumerate(frames, start=1):
        segments.append({
            "order": i, "voiceoverLineId": i, "sourceClip": clip,
            "sourceIn": round(t, 2), "sourceOut": round(t + 1.5, 2), "durationSec": 1.5,
            "matchedFrameTime": round(t, 2), "visualDescription": "loadtest", "cutStyle": "standard",
            "voiceoverScript": _THAI_LINES[(i - 1) % len(_THAI_LINES)],
        })
    return {"mode": "dub_first", "segments": segments}


def from_schema(schema: dict[str, Any], *, key: str = "") -> Any:
    """A minimal value satisfying a Gemini-style JSON schema (every property
    filled, enums take a middle value, arrays get one item)."""
    kind = schema.get("type")
    if "enum" in schema:
        values = list(schema["enum"])
        return values[len(values) // 2] if values else ""
    if kind == "object":
        props = schema.get("properties") or {}
        return {name: from_schema(sub, key=name) for name, sub in props.items()}
    if kind == "array":
        item = schema.get("items") or {"type": "string"}
        return [from_schema(item, key=key)]
    if kind == "integer":
        return 1
    if kind == "number":
        return 1.0
    if kind == "boolean":
        return False
    return f"loadtest {key}".strip()


def build_answer(kwargs: dict[str, Any]) -> tuple[str, str]:
    """(answer kind, JSON/text content) for one request."""
    messages = kwargs.get("messages") or []
    system = _texts(messages, role="system")
    text = _texts([m for m in messages if m.get("role") != "system"])
    schema = _schema(kwargs)
    props = (schema or {}).get("properties") or {}

    if "segments" in props:
        if "<current_edit_script>" in text:
            return "dub_reedit", json.dumps(_dub_reedit(text), ensure_ascii=False)
        return "dub_edit", json.dumps(_dub_edit(text), ensure_ascii=False)
    if "zoomPunches" in props:
        return "effects", json.dumps(_effects())
    if "picks" in props:
        item_props = ((props["picks"].get("items") or {}).get("properties") or {})
        highlights = "score" in item_props
        return (
            "speech_highlights" if highlights else "speech_scenes",
            json.dumps(_speech_picks(text, highlights=highlights), ensure_ascii=False),
        )
    if "verdicts" in props:
        return "speech_trim", json.dumps(_speech_trim(text), ensure_ascii=False)
    if schema is not None:
        return "observation", json.dumps(from_schema(schema))
    if "<edit_script>" in text and "<voDurationSec>" in text:
        return "dub_timeline", json.dumps(_dub_timeline(text), ensure_ascii=False)
    if _FRAME_RE.search(text) and "Edit Script" in (system + text):
        return "frames_edit", json.dumps(_frames_edit(text), ensure_ascii=False)
    return "generic", "loadtest fake answer"


def _usage_numbers(kind: str, kwargs: dict[str, Any], input_estimate: int | None) -> tuple[int, int]:
    """(prompt tokens, completion tokens incl. thinking), capped by max_tokens."""
    from packages.billing import guard

    messages = kwargs.get("messages") or []
    inp = int(input_estimate or 0)
    if inp <= 0:
        try:
            inp = int(guard.count_text_tokens(messages))
        except Exception:  # noqa: BLE001
            inp = len(_texts(messages)) // 4
        inp += _file_blocks(messages) * _VIDEO_BLOCK_TOKENS
    inp = max(1, int(inp * random.uniform(0.92, 1.05)))
    thinking = _THINKING_TOKENS if kind not in ("generic", "dub_timeline") else 400
    out = int((_OUTPUT_TOKENS.get(kind, 300) + thinking) * random.uniform(0.8, 1.2))
    cap = kwargs.get("max_tokens") or kwargs.get("max_completion_tokens")
    if cap:
        out = min(out, max(1, int(cap) - 1))
    return inp, out


# ── response objects (real LiteLLM types) ─────────────────────────────────────


def _model_response(model: str, content: str, inp: int, out: int) -> Any:
    from litellm import ModelResponse
    from litellm.types.utils import Usage

    return ModelResponse(
        id=f"loadtest-{uuid.uuid4().hex[:16]}",
        model=model,
        choices=[{
            "index": 0,
            "finish_reason": "stop",
            "message": {"role": "assistant", "content": content},
        }],
        usage=Usage(prompt_tokens=inp, completion_tokens=out, total_tokens=inp + out),
    )


async def _stream(model: str, content: str, inp: int, out: int, *, thinking: str) -> AsyncIterator[Any]:
    from litellm.types.utils import Delta, ModelResponseStream, StreamingChoices, Usage

    rid = f"loadtest-{uuid.uuid4().hex[:16]}"
    if thinking:
        yield ModelResponseStream(id=rid, model=model, choices=[
            StreamingChoices(index=0, delta=Delta(role="assistant", content=None, reasoning_content=thinking))
        ])
    step = max(1, len(content) // 4)
    for i in range(0, len(content), step):
        piece = content[i:i + step]
        last = i + step >= len(content)
        yield ModelResponseStream(id=rid, model=model, choices=[
            StreamingChoices(index=0, delta=Delta(content=piece), finish_reason="stop" if last else None)
        ])
    tail = ModelResponseStream(id=rid, model=model, choices=[StreamingChoices(index=0, delta=Delta())])
    tail.usage = Usage(prompt_tokens=inp, completion_tokens=out, total_tokens=inp + out)
    yield tail


async def acompletion(kwargs: dict[str, Any], *, input_estimate: int | None = None) -> Any:
    """Stand-in for ``litellm.acompletion(**kwargs)``: sleeps the configured
    delay, then answers in the shape the caller parses. Returns an async
    iterator of chunks when ``kwargs["stream"]`` is true."""
    kind, content = build_answer(kwargs)
    inp, out = _usage_numbers(kind, kwargs, input_estimate)
    model = str(kwargs.get("model") or "loadtest")
    delay = await sleep_model()
    log.info(
        "loadtest_fake_llm_answer", model=model, kind=kind, delay_s=round(delay, 1),
        input_tokens=inp, output_tokens=out, chars=len(content),
    )
    if kwargs.get("stream"):
        return _stream(model, content, inp, out, thinking="loadtest: reviewing the footage (fake)")
    return _model_response(model, content, inp, out)


# ── speech-to-text ────────────────────────────────────────────────────────────

_THAI_WORDS = ["สวัสดี", "ค่ะ", "วันนี้", "จะ", "มา", "รีวิว", "สินค้า", "ตัว", "นี้", "กัน", "นะ", "คะ"]


def scribe_response(audio_sec: float, *, diarize: bool = False) -> dict[str, Any]:
    """A Scribe-shaped reply for ``audio_sec`` of speech: Thai grapheme-ish
    word pieces, spacing tokens, a real pause every ~6 words so the gap
    arithmetic has something to cut."""
    words: list[dict[str, Any]] = []
    t = 0.25
    count = 0
    end_limit = max(0.5, float(audio_sec) - 0.2)
    while t + 0.3 < end_limit:
        word = _THAI_WORDS[count % len(_THAI_WORDS)]
        dur = 0.18 + 0.04 * (len(word) % 4)
        tok: dict[str, Any] = {
            "text": word, "start": round(t, 3), "end": round(min(end_limit, t + dur), 3),
            "type": "word", "logprob": -0.05,
        }
        if diarize:
            tok["speaker_id"] = "speaker_0"
        words.append(tok)
        count += 1
        t += dur
        gap = 0.7 if count % 6 == 0 else 0.06
        words.append({"text": " ", "start": round(t, 3), "end": round(t + gap, 3), "type": "spacing"})
        t += gap
    text = "".join(w["text"] for w in words)
    return {
        "language_code": "tha",
        "language_probability": 0.99,
        "text": text,
        "words": words,
        "audio_duration_secs": round(float(audio_sec), 3),
    }
