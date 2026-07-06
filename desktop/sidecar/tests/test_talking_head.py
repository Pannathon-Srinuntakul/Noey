"""talking_head sidecar commands: extract-audio + render-timeline."""

from __future__ import annotations

import json
import subprocess
import zipfile
from pathlib import Path

import pytest

from sidecar.audio import ExtractAudioJob, run_extract_audio
from sidecar.ingest import IngestJob, run_ingest
from sidecar.timeline_render import RenderTimelineJob, run_render_timeline


@pytest.fixture()
def project_dir(sample_clip: Path, tmp_path: Path) -> Path:
    pdir = tmp_path / "proj"
    pdir.mkdir()
    run_ingest(IngestJob(projectDir=pdir, sources=[sample_clip]), lambda e: None)
    return pdir


def test_extract_audio_produces_whisper_wav(project_dir: Path) -> None:
    events: list[dict] = []
    done = run_extract_audio(ExtractAudioJob(projectDir=project_dir), events.append)

    assert len(done["wavs"]) == 1
    wav = project_dir / done["wavs"][0]["file"]
    assert wav.name == "audio_000.wav"
    assert wav.is_file() and done["wavs"][0]["bytes"] > 0

    from packages.video.ffmpeg_bin import probe_media

    meta = probe_media(wav)
    stream = next(s for s in meta["streams"] if s["codec_type"] == "audio")
    assert int(stream["sample_rate"]) == 16000
    assert int(stream["channels"]) == 1
    assert stream["codec_name"] == "pcm_s16le"


def test_extract_audio_rejects_silent_clip(tmp_path: Path) -> None:
    from packages.video.ffmpeg_bin import ffmpeg_cmd

    silent = tmp_path / "silent.mp4"
    subprocess.run(
        [ffmpeg_cmd(), "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=30",
         "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(silent)],
        check=True, capture_output=True,
    )
    pdir = tmp_path / "p"
    pdir.mkdir()
    run_ingest(IngestJob(projectDir=pdir, sources=[silent]), lambda e: None)
    with pytest.raises(ValueError, match="ไม่มีเสียง"):
        run_extract_audio(ExtractAudioJob(projectDir=pdir), lambda e: None)


TIMELINE = {
    "mode": "talking_head",
    "editMode": "full",
    "sources": [{"id": "clip0", "file": "normalized/norm_000.mp4"}],
    "timeline": [
        {"type": "cut", "source": "clip0", "in": 0.0, "out": 1.0, "label": "opening"},
        {"type": "cut", "source": "clip0", "in": 2.0, "out": 3.0, "label": "conclusion"},
    ],
    "captions": [
        {"start": 0.2, "end": 0.9, "text": "สวัสดีค่ะ"},
        {"start": 1.1, "end": 1.9, "text": "สั่งเลย"},
    ],
    "output": {"width": 320, "height": 240, "fps": 30},
}


def test_render_timeline(project_dir: Path) -> None:
    from packages.video.ffmpeg_bin import has_audio_stream, media_duration

    events: list[dict] = []
    done = run_render_timeline(
        RenderTimelineJob(projectDir=project_dir, timeline=TIMELINE), events.append
    )

    final = Path(done["final"])
    assert final.is_file()
    assert has_audio_stream(final)  # talking_head keeps original audio
    assert 1.5 < media_duration(final) < 2.6

    srt = Path(done["srt"]).read_text(encoding="utf-8")
    assert "สวัสดีค่ะ" in srt and "00:00:00,200 --> 00:00:00,900" in srt

    names = set(zipfile.ZipFile(done["bundle"]).namelist())
    assert {"final.mp4", "clips/clip_000.mp4", "clips/clip_001.mp4",
            "captions/subtitles.srt", "manifest.json", "README.txt"} <= names

    manifest = json.loads(zipfile.ZipFile(done["bundle"]).read("manifest.json"))
    assert manifest["mode"] == "talking_head"
    assert manifest["clips"][0]["label"] == "opening"

    stages = [e["stage"] for e in events]
    assert stages.count("cut") == 2 and "concat" in stages and "bundle" in stages


def test_render_timeline_rejects_empty() -> None:
    with pytest.raises(ValueError, match="no cuts"):
        run_render_timeline(
            RenderTimelineJob(projectDir=Path("."), timeline={"timeline": []}), lambda e: None
        )
