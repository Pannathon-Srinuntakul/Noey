"""The waveform edge check — the only thing that can promise a cut never lands
mid-speech.

Why it exists at all: on a real 10-minute span every cut edge sat exactly where
the transcript said it should and 30 of 70 edges still had speech across them.
The transcript does not know about words dropped for low confidence, filler
tokens excluded from the word list, or the sound that runs past a stamped word
end. These tests build synthetic audio where "speech" and "silence" are known
exactly, so a regression shows up as a moved boundary rather than as a
complaint about a rendered clip.
"""

from __future__ import annotations

import array
import math
import wave
from pathlib import Path

from packages.video.audio_edges import snap_cuts_to_silence

RATE = 16000


def write_wav(path: Path, spans: list[tuple[float, float]], *, total: float) -> None:
    """A WAV that is silent except for a tone inside each (start, end) span."""
    n = int(total * RATE)
    samples = array.array("h", [0] * n)
    for start, end in spans:
        for i in range(int(start * RATE), min(n, int(end * RATE))):
            samples[i] = int(8000 * math.sin(2 * math.pi * 220 * i / RATE))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(samples.tobytes())


def test_edge_inside_speech_moves_out_to_the_silence(tmp_path: Path) -> None:
    # speech 1.0-3.0 and 4.0-6.0; a cut that ends at 2.5 stops mid-word.
    wav = tmp_path / "a.wav"
    write_wav(wav, [(1.0, 3.0), (4.0, 6.0)], total=8.0)

    out = snap_cuts_to_silence([{"source": "clip0", "in": 1.5, "out": 2.5}], wav)
    assert len(out) == 1
    # the out edge moved forward, past the end of the speech it was inside
    assert out[0]["out"] >= 3.0
    # the in edge moved backward, out of the speech it was inside
    assert out[0]["in"] <= 1.0


def test_edges_already_in_silence_are_left_alone(tmp_path: Path) -> None:
    wav = tmp_path / "b.wav"
    write_wav(wav, [(1.0, 3.0), (4.0, 6.0)], total=8.0)

    cuts = [{"source": "clip0", "in": 0.9, "out": 3.2}]
    out = snap_cuts_to_silence(cuts, wav)
    assert out[0]["in"] == 0.9 and out[0]["out"] == 3.2


def test_unreachable_silence_cancels_the_removal(tmp_path: Path) -> None:
    """Continuous speech with a removal in the middle of it: rather than cut
    into the sound, the two cuts merge back into one and the material plays."""
    wav = tmp_path / "c.wav"
    write_wav(wav, [(0.5, 9.5)], total=10.0)  # no pause anywhere

    cuts = [
        {"source": "clip0", "in": 1.0, "out": 3.0},
        {"source": "clip0", "in": 4.0, "out": 6.0},
    ]
    out = snap_cuts_to_silence(cuts, wav)
    assert len(out) == 1
    assert out[0]["in"] <= 1.0 and out[0]["out"] >= 6.0


def test_far_apart_cuts_are_not_merged(tmp_path: Path) -> None:
    """The rescue only joins neighbours. A removal spanning half a minute is a
    real editorial decision, not an edge artefact, and must survive."""
    wav = tmp_path / "d.wav"
    write_wav(wav, [(0.5, 29.5)], total=30.0)

    cuts = [
        {"source": "clip0", "in": 1.0, "out": 3.0},
        {"source": "clip0", "in": 25.0, "out": 27.0},
    ]
    out = snap_cuts_to_silence(cuts, wav)
    assert len(out) == 2


def test_missing_wav_is_a_no_op(tmp_path: Path) -> None:
    cuts = [{"source": "clip0", "in": 1.0, "out": 2.0}]
    assert snap_cuts_to_silence(cuts, tmp_path / "nope.wav") == cuts


def test_noisy_room_uses_a_local_floor_not_an_absolute_level(tmp_path: Path) -> None:
    """Room tone must not read as speech. The floor is learned per edge, so a
    recording with a constant hiss still finds its pauses."""
    wav = tmp_path / "e.wav"
    n = int(8.0 * RATE)
    samples = array.array("h", [0] * n)
    for i in range(n):  # constant hiss everywhere
        samples[i] = 300 if i % 2 else -300
    for i in range(int(1.0 * RATE), int(3.0 * RATE)):  # speech on top
        samples[i] = int(8000 * math.sin(2 * math.pi * 220 * i / RATE))
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(samples.tobytes())

    out = snap_cuts_to_silence([{"source": "clip0", "in": 1.5, "out": 2.5}], wav)
    assert out[0]["out"] >= 3.0  # found the pause after the speech, hiss and all
