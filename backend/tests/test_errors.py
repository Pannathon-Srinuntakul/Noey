"""Tests for user-facing error formatting."""

from fastapi import HTTPException

from packages.core.errors import format_exception_message, format_http_detail


def test_format_http_detail_token_limit_dict() -> None:
    msg = format_http_detail(
        429,
        {
            "error": "token_limit_exceeded",
            "used": 66794,
            "limit": 50000,
            "plan": "free",
            "message": "คุณใช้ token ครบโควตาแล้ว (66,794/50,000 tokens) กรุณาติดต่อแอดมินเพื่ออัปเกรดแพลน",
        },
    )
    assert "66,794" in msg
    assert "โควตา" in msg
    assert "{" not in msg


def test_format_exception_message_http_exception() -> None:
    exc = HTTPException(
        status_code=429,
        detail={
            "error": "token_limit_exceeded",
            "message": "คุณใช้ token ครบโควตาแล้ว",
        },
    )
    assert format_exception_message(exc) == "คุณใช้ token ครบโควตาแล้ว"


def test_format_exception_message_legacy_repr() -> None:
    raw = "429: {'error': 'token_limit_exceeded', 'used': 66794, 'limit': 50000, 'message': 'โควตาเต็ม'}"
    assert format_exception_message(Exception(raw)) == "โควตาเต็ม"


def test_format_http_detail_string() -> None:
    assert format_http_detail(400, "At least one video file required") == "At least one video file required"
