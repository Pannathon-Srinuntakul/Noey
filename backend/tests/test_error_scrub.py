"""No user-facing error may name the stack behind it.

`sanitize_technical_error` maps the upstream messages it RECOGNISES to Thai
text, and used to `return text` for everything else — correct for the app's own
Thai errors, and a business-secret leak for any provider message it had not met
before. These pin the backstop.
"""
import re

import pytest

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


# ── raw exception text in HTTP details ───────────────────────────────────────
#
# A router used to write `f"manifest ไม่ถูกต้อง: {exc}"` and the like. For a
# pydantic error that is the offending INPUT quoted back; for a Redis error
# it is the host, the port and sometimes the URL with its password; for
# librosa a file path and a stack frame. The detail is fixed text now, and a
# validation error attaches only which field and what kind of problem.

def test_validation_errors_are_reduced_to_field_and_type():
    from pydantic import BaseModel, Field

    from packages.core.errors import validation_error_fields

    class M(BaseModel):
        durationSec: float = Field(gt=0)
        file: str

    from pydantic import ValidationError

    with pytest.raises(ValidationError) as e:
        M.model_validate({"durationSec": -3, "extra": "SECRET-INPUT"})
    out = validation_error_fields(e.value)
    text = str(out)
    assert {"field": "durationSec", "type": "greater_than"} in out
    assert {"field": "file", "type": "missing"} in out
    assert "SECRET-INPUT" not in text and "-3" not in text
    assert set().union(*(set(e) for e in out)) == {"field", "type"}


def test_a_json_error_says_json_and_not_the_document():
    import json

    from packages.core.errors import validation_error_fields

    try:
        json.loads('{"api_key": "sk-ant-abc"')
    except json.JSONDecodeError as exc:
        out = validation_error_fields(exc)
    assert out == [{"field": "", "type": "json_invalid"}]


async def test_a_bad_manifest_never_echoes_the_request_back(monkeypatch):
    """Through the route: the 422 carries a message and the field/type list,
    and nothing the request contained."""
    import json
    import shutil

    from packages.core.settings import get_settings
    from packages.video.storage import data_root
    from services.api.routers import videos_local
    from tests.admin_helpers import bearer, client, email, make_user, purge, user_token
    from tests.media_helpers import video_bytes

    monkeypatch.setenv("REQUIRE_VERIFIED_EMAIL_FOR_AI", "false")
    get_settings.cache_clear()

    async def fake_enqueue(job_id, fn, **kwargs):
        pass

    monkeypatch.setattr(videos_local, "_enqueue", fake_enqueue)
    user = await make_user(email("scrub"), plan="pro")
    token = await user_token(user)
    try:
        async with client() as c:
            r = await c.post(
                "/videos/local",
                json={"mode": "dub_first", "clips": [{"id": "c1", "durationSec": 30}], "engine": "lite"},
                headers=bearer(token),
            )
            uid = r.json()["uid"]
            try:
                bad = await c.post(
                    f"/videos/{uid}/analyze-video",
                    data={"manifest": json.dumps([{"clip_id": "c1", "file": "p.mp4", "durationSec": -7}])},
                    files=[("files", ("p.mp4", video_bytes(2), "video/mp4"))],
                    headers=bearer(token),
                )
                not_json = await c.post(
                    f"/videos/{uid}/analyze-video",
                    data={"manifest": '{"token": "sk-ant-LEAK"'},
                    files=[("files", ("p.mp4", video_bytes(2), "video/mp4"))],
                    headers=bearer(token),
                )
            finally:
                shutil.rmtree(data_root() / "video_outputs" / uid, ignore_errors=True)
    finally:
        await purge()
        get_settings.cache_clear()
    assert bad.status_code == 422, bad.text
    detail = bad.json()["detail"]
    assert detail["message"] == "manifest ไม่ถูกต้อง"
    assert detail["errors"] == [{"field": "0.durationSec", "type": "greater_than"}]
    assert "-7" not in bad.text
    assert not_json.status_code == 422
    assert "LEAK" not in not_json.text and "sk-ant" not in not_json.text


async def test_an_enqueue_failure_never_names_the_queue(monkeypatch):
    from fastapi import HTTPException

    from services.api.routers import videos

    async def broken_pool(*a, **k):
        raise RuntimeError("Error 111 connecting to redis://:hunter2@10.0.0.9:6379")

    # The shared pool (services/api/arq_pool.py) is what _enqueue asks for now.
    monkeypatch.setattr("services.api.arq_pool.get_arq_pool", broken_pool)

    async def no_drop(job_id: str) -> None:
        pass

    monkeypatch.setattr("packages.db.job_cache.drop", no_drop)
    with pytest.raises(HTTPException) as e:
        await videos._enqueue("job_x", "ingest_video")
    assert e.value.status_code == 503
    assert "hunter2" not in str(e.value.detail) and "10.0.0.9" not in str(e.value.detail)
    assert e.value.detail == videos.ENQUEUE_FAILED_MESSAGE


def test_a_source_id_is_matched_whole(tmp_path):
    """`clip{N}` exactly: "clipclip1" used to pass the prefix test and
    `replace` turned it into "1"; "clip-1" indexed from the end."""
    from services.api.routers.videos import _normalized_clip_path

    (tmp_path / "normalized").mkdir()
    for i in range(2):
        (tmp_path / "normalized" / f"norm_{i:03d}.mp4").write_bytes(b"")
    assert _normalized_clip_path(tmp_path, "clip1").name == "norm_001.mp4"
    for bad in ("clipclip1", "clip-1", "clip", "clip1x", "1", "clip 1"):
        with pytest.raises(ValueError):
            _normalized_clip_path(tmp_path, bad)
    with pytest.raises(ValueError):
        _normalized_clip_path(tmp_path, "clip2")  # out of range
