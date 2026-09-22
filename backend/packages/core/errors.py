"""User-facing error message formatting — never expose raw exception reprs."""

from __future__ import annotations

import json
import re
from typing import Any


class UserInputError(ValueError):
    """A job cannot finish because of what the USER sent: missing uploads, a
    bad manifest, footage over a limit, a clip the model provider refuses to
    look at, an audio file the transcription service rejects.

    A paid run that ends with one settles as ``user_error`` (charged what it
    used — packages/billing/runs.py), not ``our_failure`` (refunded): the
    vendor has usually billed the attempt already, and refunding input the
    user controls lets one account burn vendor spend for free, over and over.
    Lives here, not in the worker, so the shared video/LLM packages (and the
    desktop sidecar that imports them) can raise it without a billing import.
    """


def format_http_detail(status_code: int, detail: Any) -> str:
    """Turn a FastAPI HTTPException.detail into a short user-facing string."""
    if isinstance(detail, dict):
        message = detail.get("message")
        if isinstance(message, str) and message.strip():
            return message.strip()
        error = detail.get("error")
        if error == "token_limit_exceeded":
            used = detail.get("used")
            limit = detail.get("limit")
            if isinstance(used, int) and isinstance(limit, int):
                return (
                    f"คุณใช้ token ครบโควตาแล้ว ({used:,}/{limit:,} tokens) "
                    "กรุณาติดต่อแอดมินเพื่ออัปเกรดแพลน"
                )
            return "คุณใช้ token ครบโควตาแล้ว กรุณาติดต่อแอดมินเพื่ออัปเกรดแพลน"
        if isinstance(error, str) and error.strip():
            return error.replace("_", " ")
    if isinstance(detail, list):
        parts: list[str] = []
        for item in detail:
            if isinstance(item, dict):
                msg = item.get("msg")
                if isinstance(msg, str) and msg.strip():
                    parts.append(msg.strip())
        if parts:
            return "; ".join(parts)
    if isinstance(detail, str) and detail.strip():
        return detail.strip()
    return _status_fallback(status_code)


def _extract_json_status(text: str) -> int | None:
    m = re.search(r'"status"\s*:\s*(\d{3})', text)
    return int(m.group(1)) if m else None


def _extract_json_type(text: str) -> str | None:
    nested = re.search(r'"error"\s*:\s*\{[^}]*"type"\s*:\s*"([^"]+)"', text)
    if nested:
        return nested.group(1).lower()
    top = re.search(r'"type"\s*:\s*"([^"]+)"', text)
    return top.group(1).lower() if top else None


def _extract_upstream_message(text: str) -> str | None:
    """Pull the inner `message` field from LiteLLM / Anthropic JSON blobs."""
    for pattern in (
        r'"error"\s*:\s*\{[^}]*"message"\s*:\s*"((?:\\.|[^"\\])*)"',
        r'"message"\s*:\s*"((?:\\.|[^"\\])*)"',
    ):
        m = re.search(pattern, text)
        if m:
            return m.group(1).replace("\\n", " ").replace('\\"', '"').strip()
    # Sometimes the payload is valid JSON after the first `{`
    brace = text.find("{")
    if brace >= 0:
        try:
            payload = json.loads(text[brace:])
        except json.JSONDecodeError:
            return None
        if isinstance(payload, dict):
            err = payload.get("error")
            if isinstance(err, dict):
                msg = err.get("message")
                if isinstance(msg, str) and msg.strip():
                    return msg.strip()
            msg = payload.get("message")
            if isinstance(msg, str) and msg.strip():
                return msg.strip()
            detail = payload.get("detail")
            if isinstance(detail, str) and detail.strip():
                return detail.strip()
    return None


def _map_anthropic_message(raw: str) -> str | None:
    """Map known Anthropic / LiteLLM upstream messages to Thai user text."""
    lower = raw.lower()

    if any(k in lower for k in ("prompt is too long", "context length", "too many tokens", "maximum context")):
        return "ข้อมูลส่งให้ AI มากเกินไป (วิดีโอ/รูปยาวเกิน) ลองคลิปสั้นลงหรือลองใหม่"

    if any(k in lower for k in ("credit balance", "insufficient credit", "billing", "payment")):
        return "เครดิต AI หมด กรุณาติดต่อแอดมิน"

    if "overloaded" in lower:
        return "AI รับงานเต็มชั่วคราว กรุณารอ 1–2 นาทีแล้วกดลองใหม่"

    if "rate limit" in lower or "rate_limit" in lower:
        return "AI ถูกจำกัดการเรียกชั่วคราว กรุณารอแล้วกดลองใหม่"

    if any(k in lower for k in ("invalid api key", "authentication", "x-api-key", "unauthorized")):
        return "การตั้งค่า AI API ไม่ถูกต้อง กรุณาติดต่อแอดมิน"

    if any(k in lower for k in ("model not found", "not_found", "does not exist")):
        return "โมเดล AI ที่ตั้งค่าไว้ใช้งานไม่ได้ กรุณาติดต่อแอดมิน"

    if any(k in lower for k in ("content policy", "safety", "blocked")):
        return "เนื้อหาไม่ผ่านนโยบายของ AI กรุณาตรวจสอบวิดีโอแล้วลองใหม่"

    if any(k in lower for k in ("image", "vision")) and "too large" in lower:
        return "รูปตัวอย่างจากวิดีโอใหญ่เกินไป ลองคลิปสั้นลงหรือลองใหม่"

    return None


def _map_http_status(status: int) -> str | None:
    if status == 401:
        return "การตั้งค่า AI API ไม่ถูกต้อง กรุณาติดต่อแอดมิน"
    if status == 403:
        return "ไม่มีสิทธิ์เรียก AI กรุณาติดต่อแอดมิน"
    if status == 429:
        return "AI ถูกจำกัดการเรียกชั่วคราว กรุณารอแล้วกดลองใหม่"
    if status == 529:
        return "AI รับงานเต็มชั่วคราว กรุณารอ 1–2 นาทีแล้วกดลองใหม่"
    if status == 520:
        return "เซิร์ฟเวอร์ AI มีปัญหาชั่วคราว กรุณารอ 1–2 นาทีแล้วกดลองใหม่"
    if status in (502, 503, 504):
        return "เซิร์ฟเวอร์ AI ไม่พร้อมชั่วคราว กรุณาลองใหม่ภายหลัง"
    if status >= 500:
        return "เซิร์ฟเวอร์ AI มีปัญหา กรุณาลองใหม่ภายหลัง"
    if status == 400:
        return "คำขอ AI ไม่ถูกต้อง กรุณาลองใหม่หรือติดต่อแอดมิน"
    return None


def _is_upstream_llm_error(text: str) -> bool:
    lower = text.lower()
    markers = (
        "litellm.",
        "litellm.exceptions",
        "anthropicexception",
        "anthropic.",
        "openai.",
        "api.anthropic.com",
        "cloudflare",
        "ray_id",
    )
    return any(m in lower for m in markers)


#: Names, product names and model-id shapes that must never reach a user. The
#: mapping table below only recognises the phrasings that have actually been
#: seen; a provider that words a new error differently used to fall straight
#: through `return text` and print its own name on screen. This list is the
#: backstop for everything the table has not met yet.
_VENDOR_MARKERS = re.compile(
    r"(anthropic|claude|openai|gpt-|chatgpt|gemini|google|vertex|palm|"
    r"eleven\s*labs|elevenlabs|scribe|whisper|deepgram|assemblyai|"
    r"twelve\s*labs|pegasus|litellm|bedrock|azure|huggingface|\bLLM\b|"
    r"x-api-key|api[_-]?key|sk-[a-z0-9-]{8,}|"
    r"\b[a-z]+-\d+(\.\d+)?-(flash|pro|sonnet|haiku|opus|mini|turbo)\b)",
    re.IGNORECASE,
)

_GENERIC = "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง"


def scrub_vendor_tokens(text: str) -> str:
    """Blank the vendor-shaped TOKENS inside free text, keeping the rest.

    For streamed model reasoning ('thinking' excerpts): the model can name
    itself or its provider mid-sentence, and the excerpt is shown in the UI.
    Replacing the whole excerpt would kill a feature; replacing the tokens
    keeps it honest.
    """
    return _VENDOR_MARKERS.sub("AI", text)


def _scrub_vendor(text: str) -> str:
    """Replace anything that names the stack with the generic message.

    Applied to EVERY return value of `sanitize_technical_error`, including its
    fall-through. The fall-through is the whole point: it returns the raw
    exception text, which is correct for the app's own Thai errors and a
    business-secret leak for anything raised by a provider SDK.
    """
    return _GENERIC if _VENDOR_MARKERS.search(text) else text


def sanitize_technical_error(message: str) -> str:
    """Map raw upstream / SDK exception text to a short user-facing Thai message."""
    return _scrub_vendor(_classify_technical_error(message))


def _classify_technical_error(message: str) -> str:
    text = message.strip()
    if not text:
        return "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง"

    lower = text.lower()

    if text.startswith("429:") or text.startswith("403:") or text.startswith("401:"):
        msg_match = re.search(r"'message':\s*'([^']+)'", text)
        if msg_match:
            return msg_match.group(1)
        if "token_limit_exceeded" in text:
            return "คุณใช้ token ครบโควตาแล้ว กรุณาติดต่อแอดมินเพื่ออัปเกรดแพลน"
        status = int(text[:3])
        mapped = _map_http_status(status)
        if mapped:
            return mapped
        return "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง"

    if text.startswith("{") and text.endswith("}"):
        return "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง"

    if "token_limit_exceeded" in lower:
        return "คุณใช้ token ครบโควตาแล้ว กรุณาติดต่อแอดมินเพื่ออัปเกรดแพลน"

    # Anthropic / LiteLLM JSON payload embedded in exception text
    json_status = _extract_json_status(text)
    if json_status is not None:
        mapped = _map_http_status(json_status)
        if mapped:
            return mapped

    err_type = _extract_json_type(text)
    if err_type in ("overloaded_error", "overloaded"):
        return "AI รับงานเต็มชั่วคราว กรุณารอ 1–2 นาทีแล้วกดลองใหม่"
    if err_type in ("rate_limit_error", "rate_limit"):
        return "AI ถูกจำกัดการเรียกชั่วคราว กรุณารอแล้วกดลองใหม่"
    if err_type in ("authentication_error", "permission_error"):
        return "การตั้งค่า AI API ไม่ถูกต้อง กรุณาติดต่อแอดมิน"
    if err_type in ("invalid_request_error", "not_found_error", "api_error"):
        upstream = _extract_upstream_message(text)
        if upstream:
            mapped = _map_anthropic_message(upstream)
            if mapped:
                return mapped

    upstream = _extract_upstream_message(text)
    if upstream:
        mapped = _map_anthropic_message(upstream)
        if mapped:
            return mapped
        if _is_upstream_llm_error(text):
            return "เชื่อมต่อ AI ไม่สำเร็จ กรุณารอสักครู่แล้วกดลองใหม่"

    if "error 520" in lower or "error_520" in lower:
        return "เซิร์ฟเวอร์ AI มีปัญหาชั่วคราว กรุณารอ 1–2 นาทีแล้วกดลองใหม่"

    if "error 502" in lower or "error 503" in lower or "error 504" in lower or "error 529" in lower:
        return "เซิร์ฟเวอร์ AI ไม่พร้อมชั่วคราว กรุณาลองใหม่ภายหลัง"

    if "apiconnectionerror" in lower or "connection error" in lower:
        return "เชื่อมต่อ AI ไม่ได้ชั่วคราว กรุณารอ 1–2 นาทีแล้วกดลองใหม่"

    if "timeout" in lower or "timed out" in lower:
        return "AI ใช้เวลานานเกินไป กรุณาลองใหม่"

    if _is_upstream_llm_error(text):
        return "เชื่อมต่อ AI ไม่สำเร็จ กรุณารอสักครู่แล้วกดลองใหม่"

    if "{" in text and (
        _is_upstream_llm_error(text)
        or "cloudflare_error" in lower
        or "ray_id" in lower
        or '"status":' in text
    ):
        return "เชื่อมต่อ AI ไม่สำเร็จ กรุณารอสักครู่แล้วกดลองใหม่"

    return text


def format_exception_message(exc: BaseException) -> str:
    """Format any exception for display in UI, job rows, or chat errors."""
    from fastapi import HTTPException

    if isinstance(exc, HTTPException):
        # Scrubbed as well: a router is free to build a detail out of an
        # upstream string, and this is the one funnel every one of them exits
        # through on the way to a job row or a UI toast.
        return _scrub_vendor(format_http_detail(exc.status_code, exc.detail))

    return sanitize_technical_error(str(exc))


def _status_fallback(status_code: int) -> str:
    if status_code == 429:
        return "คุณใช้งานเกินโควตาแล้ว กรุณาติดต่อแอดมิน"
    if status_code == 403:
        return "คุณไม่มีสิทธิ์เข้าถึง"
    if status_code == 401:
        return "กรุณาเข้าสู่ระบบใหม่"
    if status_code == 404:
        return "ไม่พบข้อมูลที่ต้องการ"
    return "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง"
