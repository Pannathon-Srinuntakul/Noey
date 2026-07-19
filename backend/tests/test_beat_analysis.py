"""beat_analysis — real librosa over a synthesized click track."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from packages.video.beat_analysis import detect_beats, extract_audio_for_analysis
from packages.video.ffmpeg_bin import ffmpeg_cmd


@pytest.fixture(scope="module")
def click_track(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """A 4s, 120bpm click track (beat every 0.5s) — deterministic ground truth."""
    sr = 22050
    duration = 4.0
    y = np.zeros(int(sr * duration), dtype=np.float32)
    for beat_t in np.arange(0, duration, 0.5):
        idx = int(beat_t * sr)
        y[idx:idx + 200] += 0.8
    out = tmp_path_factory.mktemp("media") / "click.wav"
    sf.write(str(out), y, sr)
    return out


def test_detect_beats_finds_regular_tempo(click_track: Path) -> None:
    result = detect_beats(click_track)
    assert result["tempo"] > 0
    assert len(result["beats"]) >= 5
    assert abs(result["durationSec"] - 4.0) < 0.1
    # Beats should be roughly evenly spaced ~0.5s apart (120bpm click track).
    gaps = [b - a for a, b in zip(result["beats"], result["beats"][1:])]
    assert all(abs(g - 0.5) < 0.15 for g in gaps)


def test_extract_audio_for_analysis_from_video(tmp_path: Path) -> None:
    import subprocess

    video = tmp_path / "src.mp4"
    subprocess.run(
        [
            ffmpeg_cmd(), "-y",
            "-f", "lavfi", "-i", "testsrc=duration=2:size=160x120:rate=15",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-shortest", str(video),
        ],
        check=True, capture_output=True,
    )
    audio_out = tmp_path / "extracted.wav"
    extract_audio_for_analysis(video, audio_out)
    assert audio_out.is_file()
    result = detect_beats(audio_out)
    assert abs(result["durationSec"] - 2.0) < 0.2
