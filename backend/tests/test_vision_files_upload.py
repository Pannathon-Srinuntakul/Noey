"""Tests for Anthropic Files API vision upload helpers."""

from __future__ import annotations

import pathlib
from types import SimpleNamespace

import pytest

from packages.llm import files as llm_files
from packages.video import scene


@pytest.mark.asyncio
async def test_upload_message_file_returns_id(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_acreate_file(**_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(id="file_test123")

    monkeypatch.setattr(llm_files.litellm, "acreate_file", fake_acreate_file)
    fid = await llm_files.upload_message_file(
        content=b"\xff\xd8\xff",
        filename="a.jpg",
    )
    assert fid == "file_test123"


@pytest.mark.asyncio
async def test_build_vision_content_uploaded_parallel(
    tmp_path: pathlib.Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    async def fake_upload(path: pathlib.Path) -> str:
        calls.append(path.name)
        return f"file_{path.name}"

    monkeypatch.setattr(llm_files, "upload_message_file_path", fake_upload)

    frames = []
    for i in range(3):
        p = tmp_path / f"f{i}.jpg"
        p.write_bytes(b"jpeg")
        frames.append({"frame_path": str(p), "time": float(i), "clip_id": "clip0", "scene_idx": i})

    content, stats, file_ids = await scene.build_vision_content_uploaded(frames, max_parallel=2)

    assert len(content) == 3
    assert all(block["type"] == "file" for block in content)
    assert content[0]["file"]["file_id"] == "file_f0.jpg"
    assert stats["transport"] == "anthropic_files_api"
    assert stats["base64_kb"] == 0
    assert file_ids == ["file_f0.jpg", "file_f1.jpg", "file_f2.jpg"]
    assert len(calls) == 3


@pytest.mark.asyncio
async def test_delete_message_files_swallows_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_delete(file_id: str) -> None:
        if file_id == "bad":
            raise RuntimeError("nope")

    monkeypatch.setattr(llm_files, "delete_message_file", fake_delete)
    await llm_files.delete_message_files(["ok", "bad"])
