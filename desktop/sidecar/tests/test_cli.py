"""Sidecar CLI + job runner tests (needs ffmpeg on the machine, like backend tests)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from sidecar.cli import main
from sidecar.jobs import Cut, RenderJob, load_job, run_render


def run_cli(capsys: pytest.CaptureFixture, *argv: str) -> tuple[int, list[dict]]:
    code = main(list(argv))
    lines = [json.loads(line) for line in capsys.readouterr().out.strip().splitlines()]
    return code, lines


def test_ping(capsys: pytest.CaptureFixture) -> None:
    code, events = run_cli(capsys, "ping")
    assert code == 0
    assert events[-1]["event"] == "pong"
    assert Path(events[-1]["ffmpeg"]).is_file()
    assert Path(events[-1]["ffprobe"]).is_file()


def test_probe(capsys: pytest.CaptureFixture, sample_clip: Path) -> None:
    code, events = run_cli(capsys, "probe", str(sample_clip))
    assert code == 0
    probe = events[-1]
    assert probe["event"] == "probe"
    assert probe["width"] == 320
    assert probe["height"] == 240
    assert probe["has_audio"] is True
    assert 2.5 < probe["duration"] < 3.5


def test_probe_missing_file(capsys: pytest.CaptureFixture) -> None:
    code, events = run_cli(capsys, "probe", "no_such_file.mp4")
    assert code == 1
    assert events[-1]["event"] == "error"


def test_cut_validation() -> None:
    with pytest.raises(ValueError):
        Cut(start=2.0, end=1.0)
    with pytest.raises(ValueError):
        Cut(start=1.0, end=1.0)
    assert Cut(start=1.0, end=2.5).duration == 1.5


def test_render_job_rejects_missing_source(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        RenderJob(
            source=tmp_path / "missing.mp4",
            output=tmp_path / "out.mp4",
            cuts=[Cut(start=0, end=1)],
        )


def test_render_two_cuts(sample_clip: Path, tmp_path: Path) -> None:
    job = RenderJob(
        source=sample_clip,
        output=tmp_path / "out" / "final.mp4",
        cuts=[Cut(start=0.0, end=1.0), Cut(start=2.0, end=3.0)],
    )
    events: list[dict] = []
    done = run_render(job, on_progress=events.append)

    assert done["event"] == "done"
    assert Path(done["output"]).is_file()
    # two 1s cuts joined → ~2s output
    assert 1.5 < done["duration"] < 2.6
    stages = [e for e in events if e["event"] == "progress"]
    assert [e["stage"] for e in stages] == ["cut", "cut", "concat"]


def test_render_via_cli(capsys: pytest.CaptureFixture, sample_clip: Path, tmp_path: Path) -> None:
    job_file = tmp_path / "job.json"
    job_file.write_text(
        json.dumps(
            {
                "source": str(sample_clip),
                "output": str(tmp_path / "cli_out.mp4"),
                "cuts": [{"start": 0.5, "end": 1.5}],
            }
        ),
        encoding="utf-8",
    )
    code, events = run_cli(capsys, "render", "--job", str(job_file))
    assert code == 0
    assert events[-1]["event"] == "done"
    assert Path(events[-1]["output"]).is_file()


def test_load_job_roundtrip(sample_clip: Path, tmp_path: Path) -> None:
    job_file = tmp_path / "job.json"
    job_file.write_text(
        json.dumps(
            {
                "source": str(sample_clip),
                "output": str(tmp_path / "o.mp4"),
                "cuts": [{"start": 0, "end": 2}],
            }
        ),
        encoding="utf-8",
    )
    job = load_job(job_file)
    assert job.cuts[0].duration == 2.0
