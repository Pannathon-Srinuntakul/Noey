"""Tests for the Gemini Files API upload helpers (desktop dub_first video path).

Regression coverage for a real production bug: Gemini processes uploaded video
files asynchronously (state PROCESSING -> ACTIVE/FAILED); referencing a file
before it reaches ACTIVE fails generateContent with a 400 FAILED_PRECONDITION.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from packages.llm import files as llm_files


@pytest.mark.asyncio
async def test_upload_gemini_file_waits_until_active(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    clip = tmp_path / "clip0.mp4"
    clip.write_bytes(b"fake-mp4")

    async def fake_create_file(**_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(id="files/abc123")

    statuses = iter(["uploaded", "uploaded", "processed"])

    async def fake_retrieve(file_id: str, **_kwargs: object) -> SimpleNamespace:
        assert file_id == "files/abc123"
        return SimpleNamespace(status=next(statuses))

    sleeps: list[float] = []

    async def fake_sleep(sec: float) -> None:
        sleeps.append(sec)

    monkeypatch.setattr(llm_files.litellm, "acreate_file", fake_create_file)
    monkeypatch.setattr(llm_files.litellm, "afile_retrieve", fake_retrieve)
    monkeypatch.setattr(llm_files.asyncio, "sleep", fake_sleep)

    file_id = await llm_files.upload_gemini_file(clip)

    assert file_id == "files/abc123"
    assert len(sleeps) == 2  # polled twice ("uploaded") before "processed"


@pytest.mark.asyncio
async def test_upload_gemini_file_raises_on_failed_processing(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    clip = tmp_path / "clip0.mp4"
    clip.write_bytes(b"fake-mp4")

    async def fake_create_file(**_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(id="files/bad")

    async def fake_retrieve(file_id: str, **_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(status="error", status_details="corrupt video")

    monkeypatch.setattr(llm_files.litellm, "acreate_file", fake_create_file)
    monkeypatch.setattr(llm_files.litellm, "afile_retrieve", fake_retrieve)

    with pytest.raises(RuntimeError, match="corrupt video"):
        await llm_files.upload_gemini_file(clip)


@pytest.mark.asyncio
async def test_upload_gemini_file_times_out(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_retrieve(file_id: str, **_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(status="uploaded")  # never becomes active

    async def fake_sleep(sec: float) -> None:
        return None

    monkeypatch.setattr(llm_files.litellm, "afile_retrieve", fake_retrieve)
    monkeypatch.setattr(llm_files.asyncio, "sleep", fake_sleep)

    with pytest.raises(TimeoutError):
        await llm_files._wait_for_gemini_file_active("files/slow", timeout_sec=0.01)
