"""Speech-audio extraction for Whisper — shared by the worker and the sidecar.

Extracted verbatim from ``services/worker/tasks.py`` ingest_video so the
desktop app can produce identical WAVs locally before uploading them for
server-side transcription.
"""

from __future__ import annotations

from pathlib import Path

from packages.video.ffmpeg_bin import run_ffmpeg


def extract_speech_wav(src: str | Path, audio_out: str | Path) -> None:
    """Mono 16 kHz PCM WAV + single-pass loudnorm (boosts quiet speech so
    Whisper VAD can detect it under BGM)."""
    import ffmpeg as ffmpeg_lib

    run_ffmpeg(
        ffmpeg_lib
        .input(str(src))
        .output(
            str(audio_out),
            ac=1, ar=16000, acodec="pcm_s16le", f="wav",
            af="loudnorm=I=-16:TP=-1.5:LRA=11",
        )
        .overwrite_output(),
        label="ingest_extract_audio",
    )
