"""extract-proxy sidecar command — downscaled no-audio proxy MP4 for Gemini video analysis."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from sidecar.cli import main
from sidecar.ingest import IngestJob, run_ingest
from sidecar.proxy import ExtractProxyJob, run_extract_proxy


def run_cli(capsys: pytest.CaptureFixture, *argv: str) -> tuple[int, list[dict]]:
    code = main(list(argv))
    lines = [json.loads(line) for line in capsys.readouterr().out.strip().splitlines()]
    return code, lines


@pytest.fixture()
def project_dir(sample_clip: Path, tmp_path: Path) -> Path:
    """Project dir with one ingested clip."""
    pdir = tmp_path / "proj"
    pdir.mkdir()
    done = run_ingest(IngestJob(projectDir=pdir, sources=[sample_clip]), lambda e: None)
    assert done["event"] == "done"
    return pdir


def test_extract_proxy_manifest_schema(project_dir: Path) -> None:
    events: list[dict] = []
    done = run_extract_proxy(ExtractProxyJob(projectDir=project_dir), events.append)

    assert done["count"] == 1
    manifest = json.loads((project_dir / "proxy" / "proxy_manifest.json").read_text(encoding="utf-8"))
    assert len(manifest) == 1
    entry = manifest[0]
    assert set(entry) >= {"clip_id", "file", "durationSec", "order"}
    assert entry["clip_id"] == "clip0"
    assert entry["order"] == 0
    assert 2.5 < entry["durationSec"] < 3.5
    assert any(e["stage"] == "proxy" for e in events)


def test_extract_proxy_media_is_downscaled_and_silent(project_dir: Path) -> None:
    from packages.video.ffmpeg_bin import has_audio_stream, video_stream_info

    done = run_extract_proxy(ExtractProxyJob(projectDir=project_dir), lambda e: None)
    entry = done["proxies"][0]
    proxy_path = project_dir / "proxy" / entry["file"]
    assert proxy_path.is_file()

    info = video_stream_info(proxy_path)
    assert info["height"] <= 480
    assert info["codec_name"].lower() == "h264"
    assert has_audio_stream(proxy_path) is False


def test_cli_extract_proxy_roundtrip(capsys: pytest.CaptureFixture, project_dir: Path, tmp_path: Path) -> None:
    job_file = tmp_path / "job.json"
    job_file.write_text(json.dumps({"projectDir": str(project_dir)}), encoding="utf-8")
    code, events = run_cli(capsys, "extract-proxy", "--job", str(job_file))
    assert code == 0
    assert events[-1]["event"] == "done"
    assert events[-1]["count"] == 1
