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


@pytest.fixture()
def scratch(tmp_path, monkeypatch):
    monkeypatch.setattr(transfer, "data_root", lambda: tmp_path)
    return tmp_path


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def test_full_lifecycle_leaves_nothing_behind(scratch):
    owner = _Auth(user_id=7)
    ticket = _run(transfer.create_ticket(owner))
    token = ticket.token

    payload = b"\x00\x01" * 1000
    out = _run(transfer.upload_from_phone(token, _upload_file("IMG_0001.MOV", payload)))
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
    _run(transfer.upload_from_phone(token, _upload_file("a.mp4", b"x" * 10)))

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
        _run(transfer.upload_from_phone(token, _upload_file("a.mp4", b"x")))
    assert err.value.status_code == 410


def test_only_video_files_and_never_empty_ones(scratch):
    owner = _Auth(user_id=7)
    token = _run(transfer.create_ticket(owner)).token

    with pytest.raises(HTTPException) as err:
        _run(transfer.upload_from_phone(token, _upload_file("evil.exe", b"MZ")))
    assert err.value.status_code == 422

    with pytest.raises(HTTPException) as err:
        _run(transfer.upload_from_phone(token, _upload_file("a.mp4", b"")))
    assert err.value.status_code == 422

    # Neither refusal may leave a partial file for the manifest to trip on.
    files = list((scratch / "video_transfer" / token).glob("file_*"))
    assert files == []


def test_the_file_cap_holds(scratch, monkeypatch):
    monkeypatch.setattr(transfer, "MAX_FILES", 2)
    owner = _Auth(user_id=7)
    token = _run(transfer.create_ticket(owner)).token
    _run(transfer.upload_from_phone(token, _upload_file("a.mp4", b"x")))
    _run(transfer.upload_from_phone(token, _upload_file("b.mp4", b"x")))
    with pytest.raises(HTTPException) as err:
        _run(transfer.upload_from_phone(token, _upload_file("c.mp4", b"x")))
    assert err.value.status_code == 429


def test_a_garbage_token_never_touches_the_disk(scratch):
    with pytest.raises(HTTPException) as err:
        _run(transfer.transfer_status("../../etc", _Auth(user_id=7)))
    assert err.value.status_code == 400
