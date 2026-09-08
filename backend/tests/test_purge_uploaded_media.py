"""Uploaded media must not survive the job that needed it.

The product's promise is that source video stays on the user's machine. The AI
still has to SEE it, so proxies, speech WAVs and a music track are uploaded —
and before this existed they were kept forever: 2.93 GB across 234 files, the
oldest two months old, measured 2026-09-08.
"""

from __future__ import annotations

import pytest

from packages.video.storage import PURGEABLE_MEDIA_DIRS, output_dir, purge_uploaded_media


@pytest.fixture
def project(tmp_path, monkeypatch):
    """A project dir under a temporary data root."""
    monkeypatch.setattr("packages.video.storage.data_root", lambda: tmp_path)
    uid = "proj-under-test"
    d = tmp_path / "video_outputs" / uid
    d.mkdir(parents=True)
    return uid, d


def test_purges_a_media_dir_and_reports_the_count(project):
    uid, d = project
    (d / "proxy").mkdir()
    (d / "proxy" / "clip0.mp4").write_bytes(b"x" * 100)
    (d / "proxy" / "clip1.mp4").write_bytes(b"x" * 100)
    (d / "proxy" / "proxy_manifest.json").write_text("[]")

    assert purge_uploaded_media(uid, ("proxy",)) == 3
    assert not (d / "proxy").exists()


def test_leaves_everything_else_alone(project):
    """The edit script, the transcript and the renders are not uploads."""
    uid, d = project
    (d / "proxy").mkdir()
    (d / "proxy" / "clip0.mp4").write_bytes(b"x")
    (d / "edit_script.json").write_text("{}")
    (d / "transcript.json").write_text("{}")
    (d / "final.mp4").write_bytes(b"video")

    purge_uploaded_media(uid, ("proxy",))

    assert (d / "edit_script.json").is_file()
    assert (d / "transcript.json").is_file()
    assert (d / "final.mp4").is_file()


def test_is_a_no_op_when_the_dir_was_never_created(project):
    uid, _ = project
    assert purge_uploaded_media(uid, ("proxy", "audio", "music")) == 0


def test_refuses_a_directory_that_is_not_uploaded_media(project):
    """A typo must not delete a render. The allow-list is the whole guard."""
    uid, d = project
    (d / "clips").mkdir()
    (d / "clips" / "clip_001.mp4").write_bytes(b"render")

    with pytest.raises(ValueError, match="not a purgeable media dir"):
        purge_uploaded_media(uid, ("clips",))
    assert (d / "clips" / "clip_001.mp4").is_file()

    for name in ("final.mp4", "..", "", "normalized"):
        with pytest.raises(ValueError):
            purge_uploaded_media(uid, (name,))


def test_the_allow_list_is_only_uploaded_media(project):
    """Nothing a render produces may appear here."""
    assert set(PURGEABLE_MEDIA_DIRS) == {"proxy", "audio", "music", "effects", "ai_reedit", "frames"}
    for produced in ("clips", "normalized", "highlights", "captions", "previous"):
        assert produced not in PURGEABLE_MEDIA_DIRS


def test_purges_several_dirs_in_one_call(project):
    uid, d = project
    for sub in ("ai_reedit", "proxy"):
        (d / sub).mkdir()
        (d / sub / "f.mp4").write_bytes(b"x")

    assert purge_uploaded_media(uid, ("ai_reedit", "proxy")) == 2
    assert not (d / "ai_reedit").exists()
    assert not (d / "proxy").exists()


def test_output_dir_is_where_uploads_actually_land(project, tmp_path):
    """Pins the path the routes write to — an earlier draft of this work
    checked `video_uploads/`, which is a different directory that the upload
    routes never touch, so the assertion passed while the files stayed."""
    uid, _ = project
    assert output_dir(uid) == tmp_path / "video_outputs" / uid
