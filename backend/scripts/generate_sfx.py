"""Generate CC0 SFX WAV files using Python stdlib only (no extra deps).

Run once from the repo root:
    python backend/scripts/generate_sfx.py

Writes 5 files to backend/data/sfx/:
  pop.wav    0.12s  exponential-decay sine 200 Hz
  whoosh.wav 0.45s  noise burst with attack/decay envelope
  ding.wav   0.60s  bell-like two-partial tone
  click.wav  0.05s  short transient click
  punch.wav  0.20s  pitch-drop thud (150→60 Hz)
"""

from __future__ import annotations

import math
import pathlib
import random
import struct
import wave

RATE = 44100
SFX_DIR = pathlib.Path(__file__).resolve().parent.parent / "data" / "sfx"


def _write_wav(path: pathlib.Path, samples: list[float]) -> None:
    """Write mono 16-bit 44100 Hz WAV. samples in [-1.0, 1.0]."""
    data = b"".join(struct.pack("<h", max(-32767, min(32767, int(s * 32767)))) for s in samples)
    with wave.open(str(path), "w") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(RATE)
        f.writeframes(data)


def _pop(path: pathlib.Path) -> None:
    """Short punchy pop: 200 Hz sine with fast exponential decay (τ = 18 ms)."""
    n = int(RATE * 0.12)
    tau = 0.018 * RATE
    samples = [math.sin(2 * math.pi * 200 * i / RATE) * math.exp(-i / tau) for i in range(n)]
    _write_wav(path, samples)


def _whoosh(path: pathlib.Path) -> None:
    """Whoosh: band-limited noise (400–2000 Hz harmonics) with ramp-up/down envelope."""
    n = int(RATE * 0.45)
    peak_idx = int(n * 0.22)
    rng = random.Random(42)
    freqs = [400, 620, 950, 1450, 2000]
    phases = [rng.uniform(0, 2 * math.pi) for _ in freqs]
    samples: list[float] = []
    for i in range(n):
        t = i / RATE
        env = (i / peak_idx) if i < peak_idx else ((n - i) / (n - peak_idx))
        env = max(0.0, min(1.0, env))
        v = sum(math.sin(2 * math.pi * f * t + p) for f, p in zip(freqs, phases))
        samples.append(v / len(freqs) * env * 0.85)
    _write_wav(path, samples)


def _ding(path: pathlib.Path) -> None:
    """Bell-like: 800 Hz fundamental + 1600 Hz overtone, long decay (τ = 140 ms)."""
    n = int(RATE * 0.60)
    tau = 0.14 * RATE
    samples = [
        (math.sin(2 * math.pi * 800 * i / RATE) + 0.4 * math.sin(2 * math.pi * 1600 * i / RATE))
        * math.exp(-i / tau)
        * 0.7
        for i in range(n)
    ]
    _write_wav(path, samples)


def _click(path: pathlib.Path) -> None:
    """Very short click transient: 1000 Hz sine, τ = 4 ms."""
    n = int(RATE * 0.05)
    tau = 0.004 * RATE
    samples = [math.sin(2 * math.pi * 1000 * i / RATE) * math.exp(-i / tau) for i in range(n)]
    _write_wav(path, samples)


def _punch(path: pathlib.Path) -> None:
    """Low thud: pitch-drop sine 150→60 Hz over 200 ms with exponential decay (τ = 50 ms)."""
    n = int(RATE * 0.20)
    tau = 0.05 * RATE
    samples: list[float] = []
    phase = 0.0
    for i in range(n):
        freq = 150 - 90 * (i / n)  # linearly sweep 150→60 Hz
        phase += 2 * math.pi * freq / RATE
        env = math.exp(-i / tau)
        samples.append(math.sin(phase) * env * 0.9)
    _write_wav(path, samples)


def main() -> None:
    SFX_DIR.mkdir(parents=True, exist_ok=True)
    tasks = [
        ("pop.wav", _pop),
        ("whoosh.wav", _whoosh),
        ("ding.wav", _ding),
        ("click.wav", _click),
        ("punch.wav", _punch),
    ]
    for name, fn in tasks:
        out = SFX_DIR / name
        fn(out)
        print(f"  {name:12s}  {out.stat().st_size:>6d} bytes")
    print(f"\nSFX generated in {SFX_DIR}")


if __name__ == "__main__":
    main()
