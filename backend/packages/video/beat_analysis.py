"""Music beat/tempo detection for the dub_first "cut to the beat" feature.

extract_audio_for_analysis mirrors audio_extract.extract_speech_wav's shape but
skips the speech-tuned loudnorm — this is for beat tracking, not ASR. detect_beats
is the only librosa entry point in the codebase; keep it that way (librosa is a
heavy, single-purpose dependency).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from packages.video.ffmpeg_bin import run_ffmpeg


def extract_audio_for_analysis(src: str | Path, audio_out: str | Path) -> None:
    """Mono 22.05 kHz PCM WAV — plenty for beat tracking, small + fast to load."""
    import ffmpeg as ffmpeg_lib

    run_ffmpeg(
        ffmpeg_lib
        .input(str(src))
        .output(str(audio_out), ac=1, ar=22050, acodec="pcm_s16le", f="wav")
        .overwrite_output(),
        label="beat_extract_audio",
    )


def detect_beats(audio_path: str | Path) -> dict[str, Any]:
    """librosa beat-track a music file → {"tempo": bpm, "beats": [sec, ...], "durationSec": float}."""
    import librosa
    import numpy as np

    y, sr = librosa.load(str(audio_path), sr=None, mono=True)
    duration_sec = float(librosa.get_duration(y=y, sr=sr))
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
    beat_times = librosa.frames_to_time(beat_frames, sr=sr)
    # librosa >=0.10 returns tempo as a 1-element ndarray, not a scalar.
    tempo_scalar = float(np.asarray(tempo).reshape(-1)[0])
    return {
        "tempo": round(tempo_scalar, 2),
        "beats": [round(float(t), 3) for t in beat_times],
        "durationSec": round(duration_sec, 2),
    }
