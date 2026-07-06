"""Test fixtures: make the sidecar package importable and provide a tiny clip."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

SIDECAR_DIR = Path(__file__).resolve().parents[1]
if str(SIDECAR_DIR) not in sys.path:
    sys.path.insert(0, str(SIDECAR_DIR))

from sidecar.bootstrap import ensure_backend_on_path  # noqa: E402

ensure_backend_on_path()


@pytest.fixture(scope="session")
def sample_clip(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Generate a 3-second 320x240 test clip with a sine audio track."""
    from packages.video.ffmpeg_bin import ffmpeg_cmd

    out = tmp_path_factory.mktemp("media") / "sample.mp4"
    cmd = [
        ffmpeg_cmd(),
        "-y",
        "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-shortest",
        str(out),
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    return out
