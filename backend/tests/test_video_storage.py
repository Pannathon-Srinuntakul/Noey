"""Tests for video file storage helpers."""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

from packages.video import storage


def test_collect_project_dirs_includes_upload_and_output(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(storage, "data_root", lambda: tmp_path)
    uid = "proj-1"
    upload_root = tmp_path / "video_uploads" / "legacy-upload-id"
    upload_root.mkdir(parents=True)
    output_root = tmp_path / "video_outputs" / uid
    output_root.mkdir(parents=True)
    (output_root / "upload_sources.json").write_text(
        json.dumps([f"video_uploads/legacy-upload-id/clip_000.mp4"]),
        encoding="utf-8",
    )

    dirs = storage._collect_project_dirs(
        uid,
        [f"video_outputs/{uid}/normalized/norm_000.mp4"],
    )

    assert tmp_path / "video_uploads" / uid in dirs
    assert output_root in dirs
    assert upload_root in dirs


def test_rmtree_resilient_clears_readonly(tmp_path: Path) -> None:
    target = tmp_path / "locked"
    target.mkdir()
    locked_file = target / "clip.mp4"
    locked_file.write_bytes(b"x")
    os.chmod(locked_file, stat.S_IREAD)

    storage._rmtree_resilient(target)

    assert not target.exists()
