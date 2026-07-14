"""Burned-in caption wiring in the sidecar's render-timeline command."""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from sidecar.ingest import IngestJob, run_ingest
from sidecar.timeline_render import RenderTimelineJob, run_render_timeline


@pytest.fixture()
def project_dir(sample_clip: Path, tmp_path: Path) -> Path:
    pdir = tmp_path / "proj"
    pdir.mkdir()
    run_ingest(IngestJob(projectDir=pdir, sources=[sample_clip]), lambda e: None)
    return pdir


TIMELINE_WITH_CAPTIONS = {
    "mode": "talking_head",
    "editMode": "full",
    "sources": [{"id": "clip0", "file": "normalized/norm_000.mp4"}],
    "timeline": [
        {"type": "cut", "source": "clip0", "in": 0.0, "out": 1.0, "label": "opening"},
        {"type": "cut", "source": "clip0", "in": 2.0, "out": 3.0, "label": "conclusion"},
    ],
    "captions": [],
    "words": [
        {"word": "หนึ่ง", "start": 0.1, "end": 0.5},
        {"word": "สอง", "start": 0.6, "end": 0.9},
        {"word": "สาม", "start": 2.1, "end": 2.5},
    ],
    "captionStyle": {"font": "kanit", "mode": "static", "color": "#FFFFFF"},
    "output": {"width": 320, "height": 240, "fps": 30},
}


def test_render_timeline_burns_captions(project_dir: Path) -> None:
    from packages.video.ffmpeg_bin import has_audio_stream, media_duration

    events: list[dict] = []
    done = run_render_timeline(
        RenderTimelineJob(projectDir=project_dir, timeline=TIMELINE_WITH_CAPTIONS), events.append
    )

    ass_path = project_dir / "captions" / "subtitles.ass"
    assert ass_path.is_file()
    ass_text = ass_path.read_text(encoding="utf-8")
    assert "[V4+ Styles]" in ass_text
    assert "Kanit" in ass_text
    assert "Dialogue:" in ass_text
    assert "หนึ่งสอง" in ass_text  # Thai words join without a space
    assert "สาม" in ass_text
    assert "\\k" not in ass_text  # static mode — no karaoke fill tags

    final = Path(done["final"])
    assert final.is_file()
    assert has_audio_stream(final)
    assert 1.5 < media_duration(final) < 2.6

    manifest = json.loads(zipfile.ZipFile(done["bundle"]).read("manifest.json"))
    assert manifest["captions_ass"] == "captions/subtitles.ass"

    names = set(zipfile.ZipFile(done["bundle"]).namelist())
    assert "captions/subtitles.ass" in names


def test_render_timeline_without_caption_style_skips_burn(project_dir: Path) -> None:
    timeline = {**TIMELINE_WITH_CAPTIONS, "captionStyle": None}
    done = run_render_timeline(RenderTimelineJob(projectDir=project_dir, timeline=timeline), lambda e: None)

    assert not (project_dir / "captions" / "subtitles.ass").exists()
    manifest = json.loads(zipfile.ZipFile(done["bundle"]).read("manifest.json"))
    assert manifest["captions_ass"] is None
