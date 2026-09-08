"""The web file store's guards: what it refuses, and what it must delete.

Each of these was a real hole found on 2026-09-08.
"""
import pytest
from fastapi import HTTPException

from services.api.routers import videos_local
from services.api.routers.videos_local import _web_file_path


@pytest.mark.parametrize(
    "rel",
    [
        ".hidden.json",
        "clips/.clip_001.mp4.part",
        "normalized/.part",
        ".server_manifest.json",
    ],
)
def test_dot_prefixed_names_are_refused(rel):
    # `.name.part` is the atomic-write staging convention on every side of this
    # system. One that reached the store was invisible to the manifest, to the
    # quota walk and to the stale sweep — storable, hidden and undeletable.
    with pytest.raises(HTTPException):
        _web_file_path("proj", rel)


def test_the_ordinary_names_still_resolve():
    assert _web_file_path("proj", "clips/clip_001.mp4").name == "clip_001.mp4"
    assert _web_file_path("proj", "upload_sources.json").name == "upload_sources.json"


def test_upload_sources_is_storable():
    # extract-proxy reads it, so a project restored in another browser cannot
    # run "ให้ AI ตัดใหม่" unless this file can be synced at all.
    assert "upload_sources.json" in videos_local._WEB_FILE_NAMES


def test_the_delete_route_does_not_gate_s3_on_a_local_copy():
    """Read the source: the S3 delete must not sit inside `if dest.is_file()`.

    On an ephemeral or multi-host deploy the file often exists ONLY in the
    bucket, and gating the S3 delete on the local unlink turned DELETE into a
    silent 204 no-op — the object stayed in the bucket, in the manifest and in
    the user's quota for good.
    """
    import inspect

    src = inspect.getsource(videos_local.delete_web_file)
    body = src[src.index("dest.is_file()") :]
    unlink_at = body.index("dest.unlink()")
    s3_at = body.index("delete_output_file")
    assert s3_at > unlink_at
    # and the S3 call must be OUTSIDE the if-block (column 4, not 8)
    line = [ln for ln in src.splitlines() if "await delete_output_file" in ln][0]
    assert len(line) - len(line.lstrip()) == 4, line
