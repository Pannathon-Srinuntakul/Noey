"""Path safety for the web project file store."""
import pytest
from fastapi import HTTPException
from services.api.routers.videos_local import _web_file_path, _WEB_FILE_ROOTS


@pytest.mark.parametrize("rel", [
    "project.json", "normalized/norm_000.mp4", "clips/clip_001.mp4",
    "highlights/h01.mp4", "captions/subtitles.srt", "final_silent.mp4",
])
def test_allowed_paths_resolve(rel):
    assert _web_file_path("proj", rel).name


@pytest.mark.parametrize("rel", [
    "../../etc/passwd",            # escapes the project
    "normalized/../../other/x.mp4",
    "/absolute/path.mp4",
    "secrets.env",                 # not a known name
    "random/thing.mp4",            # not a known root
    "",
])
def test_refused_paths(rel):
    with pytest.raises(HTTPException):
        _web_file_path("proj", rel)


def test_roots_do_not_include_a_render_scratch():
    # `transcode` is the converter's scratch and is NOT part of a project.
    assert "transcode" not in _WEB_FILE_ROOTS
