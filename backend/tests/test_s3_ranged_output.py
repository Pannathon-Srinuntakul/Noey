"""A web preview probe must not pull a whole video from S3 (2026-09-22)."""

from __future__ import annotations

import io

import pytest

from packages.video import s3


class _Body:
    def __init__(self, data: bytes) -> None:
        self._io = io.BytesIO(data)
        self.closed = False

    def iter_chunks(self, size: int):
        while chunk := self._io.read(size):
            yield chunk

    def close(self) -> None:
        self.closed = True


class _Client:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def get_object(self, **kwargs):
        self.calls.append(kwargs)
        if kwargs["Key"].endswith("missing.mp4"):
            from botocore.exceptions import ClientError

            raise ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")
        if "Range" in kwargs:
            return {"ContentLength": 1, "ContentRange": "bytes 0-0/1000", "Body": _Body(b"x")}
        return {"ContentLength": 1000, "Body": _Body(b"y" * 1000)}

    def download_file(self, *_a, **_k):  # a full download must never happen here
        raise AssertionError("open_output_range must not download the whole object")


@pytest.fixture
def client(monkeypatch):
    c = _Client()
    monkeypatch.setattr(s3, "_s3_enabled", lambda: True)
    monkeypatch.setattr(s3, "_bucket", lambda: "b")
    monkeypatch.setattr(s3, "_client", lambda: c)
    return c


async def test_a_one_byte_probe_reads_one_byte(client):
    got = await s3.open_output_range("p1", "final_fx.mp4", "bytes=0-0")
    assert got is not None and got.status == 206
    assert got.headers["Content-Range"] == "bytes 0-0/1000"
    assert b"".join(got.iter_chunks()) == b"x"
    assert client.calls[0]["Range"] == "bytes=0-0"


async def test_no_range_streams_the_object(client):
    got = await s3.open_output_range("p1", "final.mp4", None)
    assert got is not None and got.status == 200
    assert "Range" not in client.calls[0]
    assert len(b"".join(got.iter_chunks())) == 1000


async def test_a_missing_object_is_none(client):
    assert await s3.open_output_range("p1", "missing.mp4", "bytes=0-0") is None


async def test_s3_off_is_none(monkeypatch):
    monkeypatch.setattr(s3, "_s3_enabled", lambda: False)
    assert await s3.open_output_range("p1", "final.mp4", "bytes=0-0") is None
