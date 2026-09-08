"""No user-facing error may name the stack behind it.

`sanitize_technical_error` maps the upstream messages it RECOGNISES to Thai
text, and used to `return text` for everything else — correct for the app's own
Thai errors, and a business-secret leak for any provider message it had not met
before. These pin the backstop.
"""
import pytest

import re

from packages.core.errors import format_exception_message, sanitize_technical_error

GENERIC = "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง"
VENDOR = re.compile(
    r"anthropic|claude|openai|gpt-|gemini|google|vertex|eleven ?labs|scribe|"
    r"whisper|twelve ?labs|pegasus|litellm|sk-ant",
    re.IGNORECASE,
)


@pytest.mark.parametrize(
    "raw",
    [
        "AnthropicException - unexpected shutdown",
        "google.genai.errors.ServerError: gemini-3.1-pro-preview is unavailable",
        "ElevenLabs returned an unknown status for scribe_v2",
        "openai.BadRequestError: gpt-4o-mini refused",
        "VertexAI quota exhausted for project noey",
        "litellm.APIError: model claude-haiku-4-5 not routable",
        "Invalid x-api-key header",
        "auth failed for sk-ant-api03-abcdef123456",
        "twelve labs pegasus index missing",
    ],
)
def test_a_message_that_names_the_stack_never_reaches_the_user(raw):
    out = sanitize_technical_error(raw)
    # Either mapped to a known Thai message or replaced wholesale — what must
    # never survive is a name from the stack.
    assert not VENDOR.search(out), out


@pytest.mark.parametrize(
    "raw",
    [
        "คลิปยาวเกิน 2 ชั่วโมง",
        "ไม่พบไฟล์ที่อัปโหลด: source.mov",
        "พื้นที่เก็บเต็มแล้ว (11.0 GB จาก 10.0 GB) — ลบโปรเจกต์เก่าออกก่อน",
    ],
)
def test_the_apps_own_thai_errors_still_pass_through(raw):
    assert sanitize_technical_error(raw) == raw


def test_the_mapped_messages_do_not_name_a_vendor_either():
    """The 520 branch used to read "เซิร์ฟเวอร์ AI (Anthropic) มีปัญหา"."""
    for raw in ("Error 520 from upstream", '{"status": 520}'):
        assert "Anthropic" not in sanitize_technical_error(raw)


def test_http_exception_details_are_scrubbed_too():
    from fastapi import HTTPException

    exc = HTTPException(status_code=502, detail="gemini-3.7-flash overloaded")
    assert format_exception_message(exc) == GENERIC
