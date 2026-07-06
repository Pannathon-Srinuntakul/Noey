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


def test_format_exception_message_litellm_cloudflare_520() -> None:
    raw = (
        'litellm.exceptions.APIConnectionError: litellm.APIConnectionError: AnthropicException - '
        '{"type":"https://developers.cloudflare.com/support/troubleshooting/http-status-codes/'
        'cloudflare-5xx-errors/error-520/","title":"Error 520: Web server is returning an unknown error",'
        '"status":520,"cloudflare_error":true,"ray_id":"a117c5c1fe75ee2d","zone":"api.anthropic.com"}'
    )
    msg = format_exception_message(Exception(raw))
    assert "520" not in msg
    assert "litellm" not in msg
    assert "cloudflare" not in msg.lower()
    assert "ray_id" not in msg
    assert "ลองใหม่" in msg


def test_format_exception_message_anthropic_overloaded() -> None:
    raw = (
        'litellm.RateLimitError: AnthropicException - {"type":"error",'
        '"error":{"type":"overloaded_error","message":"Overloaded"}}'
    )
    msg = format_exception_message(Exception(raw))
    assert "overloaded" not in msg.lower()
    assert "รับงานเต็ม" in msg


def test_format_exception_message_anthropic_prompt_too_long() -> None:
    raw = (
        'litellm.BadRequestError: AnthropicException - {"type":"error",'
        '"error":{"type":"invalid_request_error",'
        '"message":"prompt is too long: 213462 tokens > 200000 maximum"}}'
    )
    msg = format_exception_message(Exception(raw))
    assert "tokens" not in msg
    assert "มากเกินไป" in msg


def test_format_exception_message_anthropic_unknown_message() -> None:
    raw = (
        'litellm.BadRequestError: AnthropicException - {"type":"error",'
        '"error":{"type":"invalid_request_error","message":"some weird internal detail"}}'
    )
    msg = format_exception_message(Exception(raw))
    assert "weird" not in msg
    assert "litellm" not in msg
    assert "ลองใหม่" in msg
