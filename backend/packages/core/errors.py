"""User-facing error message formatting — never expose raw exception reprs."""

from __future__ import annotations

from typing import Any


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


def format_exception_message(exc: BaseException) -> str:
    """Format any exception for display in UI, job rows, or chat errors."""
    from fastapi import HTTPException

    if isinstance(exc, HTTPException):
        return format_http_detail(exc.status_code, exc.detail)

    text = str(exc).strip()
    if text.startswith("429:") or text.startswith("403:") or text.startswith("401:"):
        import re

        msg_match = re.search(r"'message':\s*'([^']+)'", text)
        if msg_match:
            return msg_match.group(1)
        if "token_limit_exceeded" in text or "token" in text.lower():
            return "คุณใช้ token ครบโควตาแล้ว กรุณาติดต่อแอดมินเพื่ออัปเกรดแพลน"
        return "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง"

    if text.startswith("{") and text.endswith("}"):
        return "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง"

    return text or "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง"


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
