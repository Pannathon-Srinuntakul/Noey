"""Object keys must never walk out of the project folder (security, 2026-09-30).

A web file stored as ``clips/a\\..\\..\\..\\..\\X`` passed the '..' check (it
splits on '/' only). The S3 layer then translated '\\' to '/', so the object
key became ``.../outputs/clips/a/../../../../X``, and every worker task's
``pull_project_files`` wrote that object to ``local_dir / rel`` — outside the
project, anywhere on the worker.
"""
from __future__ import annotations

import pathlib

import pytest
from fastapi import HTTPException

from packages.video import s3 as s3_mod
from services.api.routers.videos_local import _web_file_path

EVIL = "clips/a\\..\\..\\..\\..\\PWNED.txt"


class _Paginator:
    def __init__(self, keys: list[str]) -> None:
        self._keys = keys

    def paginate(self, **_kw):
        yield {"Contents": [{"Key": k, "Size": 1} for k in self._keys]}


class _FakeClient:
    def __init__(self, keys: list[str]) -> None:
        self.keys = keys
        self.downloads: list[tuple[str, str]] = []

    def get_paginator(self, _name: str) -> _Paginator:
        return _Paginator(self.keys)

    def download_file(self, _bucket: str, key: str, dest: str) -> None:
        self.downloads.append((key, dest))
        pathlib.Path(dest).write_text("x", encoding="utf-8")


def test_the_web_store_refuses_backslash_and_control_characters():
    for rel in (EVIL, "clips/a\\b.mp4", "clips/a\x00.mp4", "music/a\nb.mp3"):
        with pytest.raises(HTTPException):
            _web_file_path("proj", rel)


def test_unicode_music_names_are_still_storable():
    # The web keeps the user's own music file name (Thai, spaces, brackets).
    assert _web_file_path("proj", "music/เพลง (1).mp3").name == "เพลง (1).mp3"


@pytest.mark.parametrize("rel", [EVIL, "clips/../../x", "clips//x", "./x", "a\x00b"])
def test_object_keys_refuse_traversal_instead_of_normalising_it(rel):
    with pytest.raises(ValueError):
        s3_mod._output_object_key("uid1", rel)


def test_ordinary_keys_are_unchanged():
    assert s3_mod._output_object_key("uid1", "clips/clip_001.mp4") == "videos/uid1/outputs/clips/clip_001.mp4"
    assert s3_mod._output_object_key("uid1", "/final.mp4") == "videos/uid1/outputs/final.mp4"


def test_a_dotdot_key_already_in_the_bucket_is_never_written_outside(tmp_path, monkeypatch):
    local = tmp_path / "video_outputs" / "uid1"
    local.mkdir(parents=True)
    prefix = "videos/uid1/outputs/"
    client = _FakeClient([
        prefix + "clips/a/../../../../PWNED.txt",
        prefix + "../escape.txt",
        prefix + "clips/ok.mp4",
    ])
    monkeypatch.setattr(s3_mod, "_client", lambda: client)
    monkeypatch.setattr(s3_mod, "_bucket", lambda: "b")

    count = s3_mod._sync_download_prefix(prefix, local)

    assert count == 1
    assert not (tmp_path / "PWNED.txt").exists()
    assert not (tmp_path / "video_outputs" / "escape.txt").exists()
    assert (local / "clips" / "ok.mp4").is_file()
    assert [k for k, _ in client.downloads] == [prefix + "clips/ok.mp4"]


def test_a_local_file_with_a_backslash_name_is_not_uploaded_as_a_dotdot_key(tmp_path, monkeypatch):
    local = tmp_path / "out"
    (local / "clips").mkdir(parents=True)
    (local / "clips" / "a\\..\\..\\X").write_text("x", encoding="utf-8")
    (local / "clips" / "ok.mp4").write_text("x", encoding="utf-8")
    uploaded: list[str] = []

    class _C:
        def upload_file(self, _src, _bucket, key, Config=None):
            uploaded.append(key)

    monkeypatch.setattr(s3_mod, "_client", lambda: _C())
    monkeypatch.setattr(s3_mod, "_bucket", lambda: "b")
    monkeypatch.setattr(s3_mod, "_transfer_config", lambda: None)

    s3_mod._sync_upload_dir(local, "p/")

    assert uploaded == ["p/clips/ok.mp4"]
