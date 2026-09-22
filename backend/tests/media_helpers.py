"""Real (tiny) media files for tests that go through the server's ffprobe.

Billing prices every start on footage the server MEASURED
(``ffmpeg_bin.measure_media``), so a route test needs bytes ffprobe can read:
a 1 fps test pattern keeps even a 10-minute "proxy" to a few hundred KB and a
fraction of a second to encode. Cached per process.
"""

from __future__ import annotations

import functools
import subprocess
import tempfile
from pathlib import Path

from packages.video.ffmpeg_bin import ffmpeg_cmd


def _encode(args: list[str], suffix: str) -> bytes:
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / f"out{suffix}"
        subprocess.run([ffmpeg_cmd(), "-v", "error", "-y", *args, str(out)], check=True)
        return out.read_bytes()


@functools.cache
def video_bytes(seconds: float, width: int = 270, height: int = 480) -> bytes:
    """An MP4 of ``seconds`` at ``width``×``height`` (a client proxy is 480 tall)."""
    return _encode(
        ["-f", "lavfi", "-i", f"testsrc=size={width}x{height}:rate=1", "-t", str(seconds),
         "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"],
        ".mp4",
    )


@functools.cache
def wav_bytes(seconds: float) -> bytes:
    """16 kHz mono s16 WAV (what the clients send for speech modes)."""
    return _encode(
        ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000", "-t", str(seconds),
         "-ac", "1", "-c:a", "pcm_s16le"],
        ".wav",
    )
