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


def test_the_server_chains_string_manifest_still_resolves_cross_references(project):
    _write_manifest(project, ["video_outputs/other-uid/x.mp4"])
    dirs = _collect_project_dirs(project, None)
    assert any("other-uid" in str(d) for d in dirs)


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
