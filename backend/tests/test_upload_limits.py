"""Every upload route has a per-file ceiling, streams to disk, and refuses
what cannot fit BEFORE writing it.

`PUT /videos/{uid}/files/{rel}` used to stream the whole body to disk and
only then ask the quota; `POST /videos/{uid}/music`, `POST /videos` and the
voiceover route read the whole file into RAM; nothing had a ceiling. The caps
are `settings.max_upload_bytes` / `max_audio_upload_bytes` /
`max_media_upload_bytes` (packages/core/settings.py) and apply to every plan,
admins included: they are about what one request may do to a host.
"""

from __future__ import annotations

import io
import json
import shutil
from pathlib import Path

import pytest
from fastapi import HTTPException
from starlette.datastructures import Headers, UploadFile

from packages.core.settings import get_settings
from packages.video.storage import data_root
from services.api.routers import videos, videos_local
from tests.admin_helpers import (  # noqa: F401  (fixtures)
    _admin_env,
    bearer,
    client,
    email,
    make_user,
    user_token,
)
from tests.media_helpers import video_bytes

# ── the helper (no DB) ───────────────────────────────────────────────────────

class _Req:
    def __init__(self, content_length: str | None) -> None:
        self.headers = Headers({"content-length": content_length} if content_length else {})


def test_a_content_length_over_the_cap_is_refused_before_anything_else():
    videos.refuse_oversized_body(_Req("1000"), 1000, "x")  # fits
    videos.refuse_oversized_body(_Req(None), 1, "x")  # unknown length: the loop decides
    videos.refuse_oversized_body(_Req("garbage"), 1, "x")
    with pytest.raises(HTTPException) as e:
        videos.refuse_oversized_body(_Req(str(2_000_000 + 1)), 1_000_000, "คลิป")
    assert e.value.status_code == 413
    # The message names the limit, in a unit a person reads.
    assert "976.6 KB" in e.value.detail and "คลิป" in e.value.detail


def test_a_multi_file_body_is_allowed_one_cap_per_file():
    # Forty frames of 1 MB each in one body: not one oversized file.
    videos.refuse_oversized_body(_Req(str(40 * 1_000_000)), 1_000_000, "เฟรม", files=40)
    with pytest.raises(HTTPException):
        videos.refuse_oversized_body(_Req(str(40 * 1_000_000)), 1_000_000, "เฟรม", files=1)


async def test_streaming_past_the_cap_deletes_the_partial_file(tmp_path: Path):
    upload = UploadFile(io.BytesIO(b"x" * (3 * 1024 * 1024)), filename="big.bin")
    dest = tmp_path / "big.bin"
    with pytest.raises(HTTPException) as e:
        await videos.receive_upload(upload, dest, limit=2 * 1024 * 1024, label="")
    assert e.value.status_code == 413
    assert not dest.exists()  # nothing half-written left behind

    upload = UploadFile(io.BytesIO(b"y" * 100), filename="small.bin")
    assert await videos.receive_upload(upload, dest, limit=1024, label="") == 100
    assert dest.read_bytes() == b"y" * 100


async def test_a_declared_size_over_the_cap_costs_no_write(tmp_path: Path):
    # The multipart parser reports each part's size; that alone refuses it.
    upload = UploadFile(io.BytesIO(b"z" * 10), filename="f.bin", size=10)
    dest = tmp_path / "f.bin"
    with pytest.raises(HTTPException):
        await videos.receive_upload(upload, dest, limit=5, label="")
    assert not dest.exists()
    assert videos.declared_upload_size(upload) == 10
    assert videos.declared_upload_size(UploadFile(io.BytesIO(b""), filename="f")) == 0


def test_the_defaults_are_the_documented_ones():
    s = get_settings()
    assert s.max_upload_bytes == 4 * 1024**3
    assert s.max_audio_upload_bytes == 200 * 1024**2
    assert s.max_media_upload_bytes == 512 * 1024**2


# ── through the API ──────────────────────────────────────────────────────────

@pytest.fixture
def small_caps(monkeypatch):
    """Caps a test can exceed with a few KB, and no Redis behind the quota walk."""
    monkeypatch.setenv("MAX_UPLOAD_BYTES", str(4096))
    monkeypatch.setenv("MAX_AUDIO_UPLOAD_BYTES", str(2048))
    monkeypatch.setenv("MAX_MEDIA_UPLOAD_BYTES", str(2048))
    monkeypatch.setenv("REQUIRE_VERIFIED_EMAIL_FOR_AI", "false")
    get_settings.cache_clear()
    monkeypatch.setattr(videos_local, "_USED_LAST", {})
    monkeypatch.setattr(videos_local, "_USED_CACHE", {})
    calls: list[dict] = []

    async def fake_enqueue(job_id, fn, **kwargs):
        calls.append({"job_id": job_id, "fn": fn, **kwargs})

    monkeypatch.setattr(videos_local, "_enqueue", fake_enqueue)
    yield calls
    get_settings.cache_clear()


async def _project(c, token: str, mode: str = "dub_first") -> str:
    r = await c.post(
        "/videos/local",
        json={"mode": mode, "clips": [{"id": "c1", "durationSec": 30}], "engine": "lite"},
        headers=bearer(token),
    )
    assert r.status_code == 201, r.text
    return r.json()["uid"]


def _cleanup(uid: str) -> None:
    shutil.rmtree(data_root() / "video_outputs" / uid, ignore_errors=True)


async def test_a_web_project_file_over_the_cap_is_refused_and_leaves_nothing(small_caps):
    user = await make_user(email("cap"), plan="pro")
    token = await user_token(user)
    async with client() as c:
        uid = await _project(c, token)
        try:
            r = await c.put(
                f"/videos/{uid}/files/project.json",
                files={"file": ("project.json", b"{" * 8192, "application/json")},
                headers=bearer(token),
            )
            folder = data_root() / "video_outputs" / uid
            leftovers = sorted(p.name for p in folder.iterdir()) if folder.is_dir() else []
            ok = await c.put(
                f"/videos/{uid}/files/project.json",
                files={"file": ("project.json", b"{}", "application/json")},
                headers=bearer(token),
            )
        finally:
            _cleanup(uid)
    assert r.status_code == 413, r.text
    assert "4.0 KB" in r.json()["detail"]
    assert leftovers == []  # no `.part`, no file
    assert ok.status_code == 200 and ok.json()["bytes"] == 2


async def test_an_admin_is_unlimited_on_storage_but_still_capped_per_file(small_caps):
    admin = await make_user(email("cap"), admin=True, plan="free")
    token = await user_token(admin)
    async with client() as c:
        uid = await _project(c, token)
        try:
            r = await c.put(
                f"/videos/{uid}/files/project.json",
                files={"file": ("project.json", b"{" * 8192, "application/json")},
                headers=bearer(token),
            )
        finally:
            _cleanup(uid)
    assert r.status_code == 413, r.text


async def test_the_storage_quota_is_asked_before_the_bytes_land(small_caps, monkeypatch):
    """A free account with 1 KB of storage sends a 3 KB file: 507, and the
    file was never written — before, it was streamed to disk, measured, and
    then deleted."""
    monkeypatch.setenv("PLAN_FREE_STORAGE_BYTES", "1024")
    get_settings.cache_clear()
    written: list[str] = []
    real = videos.receive_upload

    async def spy(file, dest, **kw):
        written.append(dest.name)
        return await real(file, dest, **kw)

    monkeypatch.setattr(videos_local, "receive_upload", spy)
    user = await make_user(email("cap"), plan="free")
    token = await user_token(user)
    async with client() as c:
        uid = await _project(c, token)
        try:
            r = await c.put(
                f"/videos/{uid}/files/project.json",
                files={"file": ("project.json", b"{" * 3000, "application/json")},
                headers=bearer(token),
            )
        finally:
            _cleanup(uid)
    assert r.status_code == 507, r.text
    assert written == []


async def test_music_has_the_audio_cap(small_caps):
    user = await make_user(email("cap"), plan="pro")
    token = await user_token(user)
    async with client() as c:
        uid = await _project(c, token)
        try:
            r = await c.post(
                f"/videos/{uid}/music",
                files={"file": ("track.mp3", b"\xff" * 4096, "audio/mpeg")},
                headers=bearer(token),
            )
            music_dir = data_root() / "video_outputs" / uid / "music"
            left = sorted(p.name for p in music_dir.iterdir()) if music_dir.is_dir() else []
        finally:
            _cleanup(uid)
    assert r.status_code == 413, r.text
    assert "เพลง" in r.json()["detail"] and "2.0 KB" in r.json()["detail"]
    assert left == []


async def test_a_transcode_source_has_the_clip_cap_and_keeps_no_scratch(small_caps):
    user = await make_user(email("cap"), plan="pro")
    token = await user_token(user)
    async with client() as c:
        r = await c.post(
            "/videos/transcode",
            files={"file": ("clip.mov", b"\x00" * 8192, "video/quicktime")},
            headers=bearer(token),
        )
    assert r.status_code == 413, r.text
    scratch = data_root() / "video_transcode" / str(user)
    assert not scratch.is_dir() or not any(scratch.iterdir())


async def test_a_cut_proxy_over_the_media_cap_never_reaches_ffprobe_or_billing(small_caps, monkeypatch):
    probed: list[Path] = []

    async def no_probe(path, **kw):
        probed.append(path)
        return 1.0

    monkeypatch.setattr(videos_local, "_measure_upload", no_probe)
    user = await make_user(email("cap"), plan="pro")
    token = await user_token(user)
    manifest = json.dumps([{"clip_id": "c1", "file": "p.mp4", "durationSec": 10}])
    async with client() as c:
        uid = await _project(c, token)
        try:
            r = await c.post(
                f"/videos/{uid}/analyze-video",
                data={"manifest": manifest},
                files=[("files", ("p.mp4", video_bytes(10) + b"\x00" * 4096, "video/mp4"))],
                headers=bearer(token),
            )
            staging = [p for p in (data_root() / "video_outputs" / uid).glob(".incoming-*")]
        finally:
            _cleanup(uid)
    assert r.status_code == 413, r.text
    assert probed == [] and staging == [] and small_caps == []


async def test_a_server_pipeline_clip_over_the_cap_is_refused_before_the_project_exists(small_caps):
    user = await make_user(email("cap"), plan="pro")
    token = await user_token(user)
    async with client() as c:
        r = await c.post(
            "/videos",
            data={"mode": "talking_head"},
            files=[("files", ("clip.mp4", b"\x00" * 8192, "video/mp4"))],
            headers=bearer(token),
        )
        listed = await c.get("/videos", headers=bearer(token))
    assert r.status_code == 413, r.text
    assert listed.json() == []


async def test_the_phone_transfer_uses_the_same_cap(small_caps):
    user = await make_user(email("cap"), plan="pro")
    token = await user_token(user)
    async with client() as c:
        ticket = await c.post("/videos/transfer", headers=bearer(token))
        assert ticket.status_code == 201, ticket.text
        t = ticket.json()["token"]
        try:
            r = await c.post(
                f"/videos/transfer/{t}/upload",
                files={"file": ("clip.mp4", b"\x00" * 8192, "video/mp4")},
            )
            status = await c.get(f"/videos/transfer/{t}", headers=bearer(token))
        finally:
            await c.delete(f"/videos/transfer/{t}", headers=bearer(token))
    assert r.status_code == 413, r.text
    assert status.json()["files"] == []


def test_the_server_upload_form_refuses_a_mode_it_does_not_run():
    """Literal on the form fields: a legacy "auto" duration_mode or an
    unknown mode is a 422 naming the field, from the framework, before any
    file is looked at."""
    from typing import get_args, get_type_hints

    hints = get_type_hints(videos.upload_video)
    for name, allowed in (
        ("mode", {"talking_head", "dub_first"}),
        ("upload_mode", {"merge", "separate"}),
        ("duration_mode", {"full"}),
    ):
        assert set(get_args(hints[name])) == allowed, name
