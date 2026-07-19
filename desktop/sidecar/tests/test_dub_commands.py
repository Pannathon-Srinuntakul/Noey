"""Dub-first sidecar commands over lavfi-generated clips."""

from __future__ import annotations

import json
import subprocess
import zipfile
from pathlib import Path

import pytest

from sidecar.cli import main
from sidecar.dub import (
    MixMusicJob,
    RenderFinalJob,
    RenderSilentJob,
    run_mix_music,
    run_render_final,
    run_render_silent,
)
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
        run_ingest(
            IngestJob(projectDir=pdir, sources=[sample_clip], mode="dub_first"),
            lambda e: None,
        )


def test_highlight_mode_uses_dub_first_per_clip_limit(
    sample_clip: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """highlight shares dub_first's Gemini-video upload pipeline, so it must
    get the same per-clip cap — not silently fall through uncapped."""
    monkeypatch.setattr("sidecar.ingest.dub_clip_exceeds_upload_limit", lambda d: True)
    pdir = tmp_path / "p"
    pdir.mkdir()
    with pytest.raises(ValueError, match="เกินลิมิต"):
        run_ingest(
            IngestJob(projectDir=pdir, sources=[sample_clip], mode="highlight"),
            lambda e: None,
        )


def test_talking_head_ignores_per_clip_dub_limit(
    sample_clip: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """talking_head must not use dub_first's 20-min per-file cap."""
    monkeypatch.setattr("sidecar.ingest.dub_clip_exceeds_upload_limit", lambda d: True)
    pdir = tmp_path / "p"
    pdir.mkdir()
    done = run_ingest(
        IngestJob(projectDir=pdir, sources=[sample_clip], mode="talking_head"),
        lambda e: None,
    )
    assert done["event"] == "done"


def test_talking_head_rejects_single_three_hour_clip(
    sample_clip: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("sidecar.ingest.media_duration", lambda _p: 3 * 3600.0)
    pdir = tmp_path / "p"
    pdir.mkdir()
    with pytest.raises(ValueError, match="2 ชั่วโมง"):
        run_ingest(
            IngestJob(projectDir=pdir, sources=[sample_clip], mode="talking_head"),
            lambda e: None,
        )


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


@pytest.fixture()
def sample_music(tmp_path_factory: pytest.TempPathFactory) -> Path:
    from packages.video.ffmpeg_bin import ffmpeg_cmd

    out = tmp_path_factory.mktemp("media") / "music.wav"
    subprocess.run(
        [ffmpeg_cmd(), "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=5", str(out)],
        check=True, capture_output=True,
    )
    return out


def test_render_silent_with_music_no_vo(project_dir: Path, sample_music: Path) -> None:
    """dub_first's VO is optional — music attached before analyze must produce
    audible output (final_silent_music.mp4) from the silent render alone."""
    from packages.video.ffmpeg_bin import has_audio_stream

    done = run_render_silent(
        RenderSilentJob(
            projectDir=project_dir, editScript=EDIT_SCRIPT, brief="ทดสอบ",
            musicPath=sample_music, musicVolume=0.3,
        ),
        lambda e: None,
    )
    music_path = Path(done["finalSilentMusic"])
    assert music_path.is_file()
    assert has_audio_stream(music_path)
    names = set(zipfile.ZipFile(done["zip"]).namelist())
    assert {"final_silent.mp4", "final_with_music.mp4", "script.txt"} <= names


def test_mix_music_onto_existing_silent_render(project_dir: Path, sample_music: Path) -> None:
    """Music attached/edited AFTER the silent cut already exists (no re-analyze needed)."""
    from packages.video.ffmpeg_bin import has_audio_stream

    silent_done = run_render_silent(
        RenderSilentJob(projectDir=project_dir, editScript=EDIT_SCRIPT), lambda e: None
    )
    assert silent_done["finalSilentMusic"] is None

    mix_done = run_mix_music(
        MixMusicJob(projectDir=project_dir, musicPath=sample_music, musicVolume=0.4),
        lambda e: None,
    )
    music_path = Path(mix_done["finalSilentMusic"])
    assert music_path.is_file()
    assert has_audio_stream(music_path)
    names = set(zipfile.ZipFile(mix_done["zip"]).namelist())
    assert {"final_silent.mp4", "final_with_music.mp4"} <= names

    # Removing the track (musicPath=None) clears the mixed file + drops it from the zip.
    clear_done = run_mix_music(MixMusicJob(projectDir=project_dir, musicPath=None), lambda e: None)
    assert clear_done["finalSilentMusic"] is None
    assert not music_path.exists()
    names_after = set(zipfile.ZipFile(clear_done["zip"]).namelist())
    assert "final_with_music.mp4" not in names_after


def test_mix_music_requires_existing_silent_render(project_dir: Path, sample_music: Path) -> None:
    with pytest.raises(FileNotFoundError):
        run_mix_music(MixMusicJob(projectDir=project_dir, musicPath=sample_music), lambda e: None)


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


def test_render_final_mixes_music_when_attached(project_dir: Path, tmp_path: Path) -> None:
    from packages.video.ffmpeg_bin import ffmpeg_cmd, has_audio_stream, media_duration

    vo = tmp_path / "vo.m4a"
    subprocess.run(
        [ffmpeg_cmd(), "-y", "-f", "lavfi", "-i", "sine=frequency=880:duration=2",
         "-c:a", "aac", str(vo)],
        check=True, capture_output=True,
    )
    music = tmp_path / "music.wav"
    subprocess.run(
        [ffmpeg_cmd(), "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=5", str(music)],
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
        RenderFinalJob(
            projectDir=project_dir, timeline=timeline, voiceoverPath=vo,
            musicPath=music, musicVolume=0.3,
        ),
        lambda e: None,
    )
    final = Path(done["final"])
    assert final.is_file()
    assert has_audio_stream(final)
    # Same -shortest bound as the VO-only case: music must not stretch the output.
    assert abs(media_duration(final) - 2.0) < 0.4


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
