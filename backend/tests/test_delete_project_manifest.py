"""DELETE /videos/{uid} must survive every shape of upload_sources.json.

The web build writes `{id, file, original}` objects; the server-render chain
writes plain strings. `pathlib.Path(dict)` raised TypeError, which aborted the
delete route BEFORE the S3 prefix and the DB row were removed — so a "deleted"
web project came back on the next restore, in every browser, for good.
"""
import json

import pytest

from packages.core.settings import get_settings
from packages.video.storage import _collect_project_dirs, output_dir


@pytest.fixture
def project(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    uid = "probe-uid"
    output_dir(uid).mkdir(parents=True, exist_ok=True)
    yield uid
    get_settings.cache_clear()


def _write_manifest(uid: str, payload) -> None:
    (output_dir(uid) / "upload_sources.json").write_text(
        json.dumps(payload), encoding="utf-8"
    )


def test_the_web_builds_object_manifest_does_not_raise(project):
    _write_manifest(
        project,
        [{"id": "clip0", "file": "normalized/norm_000.mp4", "original": "IMG_1234.MOV"}],
    )
    dirs = _collect_project_dirs(project, None)
    assert dirs  # upload + output dirs, and no exception


def test_the_manifest_is_client_writable_so_its_cross_references_are_ignored(project):
    # upload_sources.json is storable via PUT /videos/{uid}/files/..., so a
    # cross-reference in it is attacker input. Cross-references come from the
    # DB's source_files only (see test_video_storage).
    _write_manifest(project, ["video_outputs/other-uid/x.mp4"])
    dirs = _collect_project_dirs(project, None)
    assert not any("other-uid" in str(d) for d in dirs)


def test_a_hostile_manifest_cannot_delete_data_dir_or_another_project(project, tmp_path):
    from packages.video.storage import delete_project_files, upload_dir

    victim = upload_dir("victim-uid")
    victim.mkdir(parents=True)
    (victim / "a.mp4").write_bytes(b"v")
    other = output_dir("other-uid")
    other.mkdir(parents=True)
    (other / "b").write_bytes(b"o")
    _write_manifest(project, ["video_outputs/..", "video_uploads/victim-uid", "video_uploads/../x"])

    delete_project_files(project)

    assert (victim / "a.mp4").is_file()
    assert (other / "b").is_file()
    assert not output_dir(project).exists()


@pytest.mark.parametrize("rel", ["video_outputs/..", "video_uploads/.", "video_outputs/../../etc", "video_uploads/a\\..\\.."])
def test_source_files_cannot_escape_the_project_parents(project, tmp_path, rel):
    dirs = _collect_project_dirs(project, [rel])
    for d in dirs:
        assert d.resolve().parent in {(tmp_path / "video_uploads").resolve(), (tmp_path / "video_outputs").resolve()}


@pytest.mark.parametrize(
    "payload",
    [
        [None, 42, {"no_file_key": 1}, "video_uploads/z"],
        [{"file": ""}],
        "not-a-list-at-all",
    ],
)
def test_junk_is_skipped_rather_than_raised(project, payload):
    # A delete that cannot proceed is far worse than one that ignores a bad
    # entry: it leaves the row, the files AND the S3 objects behind.
    _write_manifest(project, payload)
    assert _collect_project_dirs(project, None)


def test_an_unreadable_manifest_does_not_stop_the_delete(project, monkeypatch):
    path = output_dir(project) / "upload_sources.json"
    path.write_text("{ not json", encoding="utf-8")
    assert _collect_project_dirs(project, None)
