"""Phone → web transfer: the whole courier contract.

The server is a relay, not a store — a ticket is single-owner, expires, caps
what it accepts, and DELETE leaves nothing behind. Unit-style like the rest of
the web-store tests: the endpoint coroutines are called directly.
"""

import asyncio
import io
import json
import time
from dataclasses import dataclass

import pytest
from fastapi import HTTPException
from starlette.datastructures import Headers
from starlette.datastructures import UploadFile as StarletteUploadFile
from starlette.requests import Request

from services.api.routers import transfer


@dataclass
class _Auth:
    user_id: int
    tenant_id: int = 1
    tenant_slug: str = "default"


def _upload_file(name: str, data: bytes) -> StarletteUploadFile:
    return StarletteUploadFile(
        file=io.BytesIO(data),
        filename=name,
        headers=Headers({"content-type": "video/mp4"}),
    )


def _req(ip: str = "203.0.113.9") -> Request:
    return Request({"type": "http", "client": (ip, 1234), "headers": []})


@pytest.fixture()
def scratch(tmp_path, monkeypatch):
    monkeypatch.setattr(transfer, "data_root", lambda: tmp_path)
    monkeypatch.setattr(transfer, "_store", transfer.MemoryTransferStore())
    monkeypatch.setattr(transfer, "MIN_FREE_DISK_BYTES", 0)
    return tmp_path


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def test_full_lifecycle_leaves_nothing_behind(scratch):
    owner = _Auth(user_id=7)
    ticket = _run(transfer.create_ticket(owner))
    token = ticket.token

    payload = b"\x00\x01" * 1000
    out = _run(transfer.upload_from_phone(token, _req(), _upload_file("IMG_0001.MOV", payload)))
    assert out["count"] == 1

    status = _run(transfer.transfer_status(token, owner))
    assert [f.name for f in status.files] == ["IMG_0001.MOV"]
    assert status.files[0].bytes == len(payload)

    resp = _run(transfer.download_transfer_file(token, 0, owner))
    assert resp.path.endswith("file_000.mov")

    _run(transfer.close_ticket(token, owner))
    assert not (scratch / "video_transfer" / token).exists()


def test_the_token_is_the_phone_credential_but_not_the_readers(scratch):
    owner = _Auth(user_id=7)
    stranger = _Auth(user_id=8)
    token = _run(transfer.create_ticket(owner)).token
    _run(transfer.upload_from_phone(token, _req(), _upload_file("a.mp4", b"x" * 10)))

    # Reading, downloading and closing all require the CREATING account —
    # a second logged-in user with the token gets nothing.
    for call in (
        transfer.transfer_status(token, stranger),
        transfer.download_transfer_file(token, 0, stranger),
        transfer.close_ticket(token, stranger),
    ):
        with pytest.raises(HTTPException) as err:
            _run(call)
        assert err.value.status_code == 403


def test_an_expired_ticket_refuses_everything(scratch):
    owner = _Auth(user_id=7)
    token = _run(transfer.create_ticket(owner)).token
    ticket_path = scratch / "video_transfer" / token / "ticket.json"
    stale = json.loads(ticket_path.read_text())
    stale["created"] = time.time() - transfer.TICKET_TTL_SEC - 5
    ticket_path.write_text(json.dumps(stale))

    with pytest.raises(HTTPException) as err:
        _run(transfer.upload_from_phone(token, _req(), _upload_file("a.mp4", b"x")))
    assert err.value.status_code == 410


def test_only_video_files_and_never_empty_ones(scratch):
    owner = _Auth(user_id=7)
    token = _run(transfer.create_ticket(owner)).token

    with pytest.raises(HTTPException) as err:
        _run(transfer.upload_from_phone(token, _req(), _upload_file("evil.exe", b"MZ")))
    assert err.value.status_code == 422

    with pytest.raises(HTTPException) as err:
        _run(transfer.upload_from_phone(token, _req(), _upload_file("a.mp4", b"")))
    assert err.value.status_code == 422

    # Neither refusal may leave a partial file for the manifest to trip on.
    files = list((scratch / "video_transfer" / token).glob("file_*"))
    assert files == []


def test_the_file_cap_holds(scratch, monkeypatch):
    monkeypatch.setattr(transfer, "MAX_FILES", 2)
    owner = _Auth(user_id=7)
    token = _run(transfer.create_ticket(owner)).token
    _run(transfer.upload_from_phone(token, _req(), _upload_file("a.mp4", b"x")))
    _run(transfer.upload_from_phone(token, _req(), _upload_file("b.mp4", b"x")))
    with pytest.raises(HTTPException) as err:
        _run(transfer.upload_from_phone(token, _req(), _upload_file("c.mp4", b"x")))
    assert err.value.status_code == 429


def test_a_garbage_token_never_touches_the_disk(scratch):
    with pytest.raises(HTTPException) as err:
        _run(transfer.transfer_status("../../etc", _Auth(user_id=7)))
    assert err.value.status_code == 400


# ── abuse bounds (security review 2026-09-30) ────────────────────────────────


def test_ticket_creation_is_rate_limited_per_account(scratch):
    owner = _Auth(user_id=70)
    for _ in range(transfer.ratelimit.TRANSFER_TICKET_ACCOUNT.max_hits):
        _run(transfer.create_ticket(owner))
    with pytest.raises(HTTPException) as err:
        _run(transfer.create_ticket(owner))
    assert err.value.status_code == 429


def test_a_ticket_relays_no_more_than_its_byte_budget(scratch, monkeypatch):
    monkeypatch.setattr(transfer, "MAX_TICKET_BYTES", 25)
    owner = _Auth(user_id=71)
    token = _run(transfer.create_ticket(owner)).token
    _run(transfer.upload_from_phone(token, _req(), _upload_file("a.mp4", b"x" * 20)))
    with pytest.raises(HTTPException) as err:
        _run(transfer.upload_from_phone(token, _req(), _upload_file("b.mp4", b"x" * 20)))
    assert err.value.status_code == 413
    assert len(_run(transfer.transfer_status(token, owner)).files) == 1
    assert sorted(p.name for p in (scratch / "video_transfer" / token).glob("file_*")) == ["file_000.mp4"]


def test_a_free_ticket_budget_is_the_plans_storage_allowance(scratch):
    from types import SimpleNamespace

    from packages.core.settings import get_settings

    free = SimpleNamespace(user_id=72, user=SimpleNamespace(plan="free", is_admin=False))
    token = _run(transfer.create_ticket(free)).token
    ticket = json.loads((scratch / "video_transfer" / token / "ticket.json").read_text())
    assert ticket["budget_bytes"] == min(transfer.MAX_TICKET_BYTES, get_settings().plan_storage_limit("free"))


def test_parallel_uploads_neither_share_a_file_nor_lose_a_manifest_row(scratch):
    owner = _Auth(user_id=73)
    token = _run(transfer.create_ticket(owner)).token

    async def burst():
        await asyncio.gather(*(
            transfer.upload_from_phone(token, _req(), _upload_file(f"c{i}.mp4", b"y" * (i + 1)))
            for i in range(6)
        ))

    _run(burst())
    status = _run(transfer.transfer_status(token, owner))
    assert sorted(f.name for f in status.files) == [f"c{i}.mp4" for i in range(6)]
    assert len(list((scratch / "video_transfer" / token).glob("file_*"))) == 6


def test_phone_uploads_are_rate_limited_per_ip(scratch):
    owner = _Auth(user_id=74)
    token = _run(transfer.create_ticket(owner)).token
    ip = "198.51.100.77"
    for _ in range(transfer.ratelimit.TRANSFER_UPLOAD_IP.max_hits):
        with pytest.raises(HTTPException):
            _run(transfer.upload_from_phone(token, _req(ip), _upload_file("x.exe", b"x")))
    with pytest.raises(HTTPException) as err:
        _run(transfer.upload_from_phone(token, _req(ip), _upload_file("a.mp4", b"x")))
    assert err.value.status_code == 429


def test_uploads_are_refused_when_the_volume_is_nearly_full(scratch, monkeypatch):
    monkeypatch.setattr(transfer, "MIN_FREE_DISK_BYTES", 1 << 62)
    token = _run(transfer.create_ticket(_Auth(user_id=75))).token
    with pytest.raises(HTTPException) as err:
        _run(transfer.upload_from_phone(token, _req(), _upload_file("a.mp4", b"x")))
    assert err.value.status_code == 507


def test_with_a_bucket_the_volume_keeps_no_copy_of_the_video(scratch, monkeypatch):
    pushed: list[str] = []

    async def fake_push(token, path):
        pushed.append(path.name)

    monkeypatch.setattr(transfer, "s3_enabled", lambda: True)
    monkeypatch.setattr(transfer, "push_transfer_file", fake_push)
    token = _run(transfer.create_ticket(_Auth(user_id=76))).token
    _run(transfer.upload_from_phone(token, _req(), _upload_file("a.mp4", b"x" * 5)))
    assert "file_000.mp4" in pushed
    assert not (scratch / "video_transfer" / token / "file_000.mp4").exists()
