"""Dub-first sidecar commands over lavfi-generated clips."""

from __future__ import annotations

import json
import subprocess
import zipfile
from pathlib import Path

import pytest

from sidecar.cli import main
from sidecar.dub import RenderFinalJob, RenderSilentJob, run_render_final, run_render_silent
from sidecar.frames import ExtractFramesJob, run_extract_frames
from sidecar.ingest import IngestJob, run_ingest


def run_cli(capsys: pytest.CaptureFixture, *argv: str) -> tuple[int, list[dict]]:
    code = main(list(argv))
    lines = [json.loads(line) for line in capsys.readouterr().out.strip().splitlines()]
    return code, lines


@pytest.fixture()
def project_dir(sample_clip: Path, tmp_path: Path) -> Path:
    """Project dir with one ingested clip."""
    pdir = tmp_path / "proj"
    pdir.mkdir()
    events: list[dict] = []
    done = run_ingest(IngestJob(projectDir=pdir, sources=[sample_clip]), events.append)
    assert done["event"] == "done"
    return pdir


def test_ingest_copies_and_reports_meta(sample_clip: Path, tmp_path: Path) -> None:
    pdir = tmp_path / "p"
    pdir.mkdir()
    events: list[dict] = []
    done = run_ingest(IngestJob(projectDir=pdir, sources=[sample_clip]), events.append)

    clip = done["clips"][0]
    assert clip["id"] == "clip0"
    assert clip["width"] == 320 and clip["height"] == 240
    assert clip["hasAudio"] is True
    assert 2.5 < clip["durationSec"] < 3.5
    assert (pdir / "normalized" / "norm_000.mp4").is_file()
    sources = json.loads((pdir / "upload_sources.json").read_text(encoding="utf-8"))
    assert sources[0]["file"] == "normalized/norm_000.mp4"
    assert any(e["stage"] == "ingest" for e in events)


def test_ingest_rejects_overlong_clip(sample_clip: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("sidecar.ingest.dub_clip_exceeds_upload_limit", lambda d: True)
    pdir = tmp_path / "p"
    pdir.mkdir()
    with pytest.raises(ValueError, match="เกินลิมิต"):
        run_ingest(IngestJob(projectDir=pdir, sources=[sample_clip]), lambda e: None)


@pytest.fixture()
def long_project_dir(tmp_path: Path) -> Path:
    """Project dir with one 8s clip — long enough for both edge frames."""
    from packages.video.ffmpeg_bin import ffmpeg_cmd

    src = tmp_path / "long.mp4"
    subprocess.run(
        [ffmpeg_cmd(), "-y",
         "-f", "lavfi", "-i", "testsrc=duration=8:size=320x240:rate=30",
         "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(src)],
        check=True, capture_output=True,
    )
    pdir = tmp_path / "proj_long"
    pdir.mkdir()
    run_ingest(IngestJob(projectDir=pdir, sources=[src]), lambda e: None)
    return pdir


def test_extract_frames_manifest_schema(long_project_dir: Path) -> None:
    project_dir = long_project_dir
    events: list[dict] = []
    done = run_extract_frames(ExtractFramesJob(projectDir=project_dir), events.append)

    assert done["frameCount"] > 0
    manifest = json.loads(Path(done["manifest"]).read_text(encoding="utf-8"))
    assert len(manifest) == done["frameCount"]
    for entry in manifest:
        assert set(entry) >= {"name", "clip_id", "time", "scene_idx", "scene_start", "scene_end", "file"}
        assert (project_dir / entry["file"]).is_file()
        assert entry["name"] == Path(entry["file"]).name
    edges = {e.get("edge") for e in manifest if e.get("edge")}
    assert "opening" in edges and "closing" in edges
    # opening first, closing last — server pipeline ordering
    assert manifest[0].get("edge") == "opening"
    assert manifest[-1].get("edge") == "closing"


EDIT_SCRIPT = {
    "mode": "dub_first",
    "segments": [
        {"order": 1, "voiceoverLineId": 1, "sourceClip": "clip0",
         "sourceIn": 0.0, "sourceOut": 1.0, "durationSec": 1.0,
         "voiceoverScript": "เปิดคลิป"},
        {"order": 2, "voiceoverLineId": 2, "sourceClip": "clip0",
         "sourceIn": 1.5, "sourceOut": 2.5, "durationSec": 1.0,
         "voiceoverScript": "ปิดท้าย"},
    ],
}


def test_render_silent(project_dir: Path) -> None:
    events: list[dict] = []
    done = run_render_silent(
        RenderSilentJob(projectDir=project_dir, editScript=EDIT_SCRIPT, brief="ทดสอบ"),
        events.append,
    )
    assert 1.5 < done["durationSec"] < 2.5
    assert Path(done["finalSilent"]).is_file()
    script_text = Path(done["script"]).read_text(encoding="utf-8")
    assert "เปิดคลิป" in script_text and "Brief: ทดสอบ" in script_text
    names = set(zipfile.ZipFile(done["zip"]).namelist())
    assert {"final_silent.mp4", "script.txt"} <= names
    stages = [e["stage"] for e in events]
    assert stages.count("cut") == 2 and "concat" in stages and "bundle" in stages


def test_render_final_muxes_voiceover(project_dir: Path, tmp_path: Path) -> None:
    from packages.video.ffmpeg_bin import ffmpeg_cmd, has_audio_stream, media_duration

    vo = tmp_path / "vo.m4a"
    subprocess.run(
        [ffmpeg_cmd(), "-y", "-f", "lavfi", "-i", "sine=frequency=880:duration=2",
         "-c:a", "aac", str(vo)],
        check=True, capture_output=True,
    )
    timeline = {
        "mode": "dub_first",
        "timeline": [
            {"type": "cut", "source": "clip0", "in": 0.0, "out": 1.5, "label": "opening"},
            {"type": "cut", "source": "clip0", "in": 2.0, "out": 3.0, "label": "conclusion"},
        ],
    }
    done = run_render_final(
        RenderFinalJob(projectDir=project_dir, timeline=timeline, voiceoverPath=vo),
        lambda e: None,
    )
    final = Path(done["final"])
    assert final.is_file()
    assert has_audio_stream(final)
    # 2.5s video + 2s VO with -shortest → ~2s
    assert abs(media_duration(final) - 2.0) < 0.4
    assert Path(done["bundle"]).is_file()


def test_probe_audio_only_file(capsys: pytest.CaptureFixture, tmp_path: Path) -> None:
    from packages.video.ffmpeg_bin import ffmpeg_cmd

    audio = tmp_path / "only.m4a"
    subprocess.run(
        [ffmpeg_cmd(), "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
         "-c:a", "aac", str(audio)],
        check=True, capture_output=True,
    )
    code, events = run_cli(capsys, "probe", str(audio))
    assert code == 0
    probe = events[-1]
    assert probe["has_audio"] is True
    assert probe["width"] is None and probe["fps"] is None
    assert 0.8 < probe["duration"] < 1.4


def test_cli_ingest_roundtrip(capsys: pytest.CaptureFixture, sample_clip: Path, tmp_path: Path) -> None:
    pdir = tmp_path / "p"
    pdir.mkdir()
    job_file = tmp_path / "job.json"
    job_file.write_text(
        json.dumps({"projectDir": str(pdir), "sources": [str(sample_clip)]}), encoding="utf-8"
    )
    code, events = run_cli(capsys, "ingest", "--job", str(job_file))
    assert code == 0
    assert events[-1]["event"] == "done"
    assert events[-1]["clips"][0]["id"] == "clip0"
