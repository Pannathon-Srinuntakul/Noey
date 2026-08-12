"""Probe ElevenLabs Scribe on a real Thai clip — NOT a pytest.

Answers the four questions that decide whether the tuning constants in
``elevenlabs_stt.py`` / ``timeline.py`` are right for your footage:

1. Are Thai tokens real WORDS, or split into grapheme clusters the way Whisper
   split them? (Whisper's failure mode: "ป" and "ั" arriving as separate tokens
   0.88 s apart, inside one word.)
2. Do gaps BETWEEN words look like real pauses — i.e. is the p95 intra-phrase
   gap comfortably below SEGMENT_SPLIT_GAP?
3. Does ``no_verbatim`` actually remove Thai fillers ("เอ่อ", "แบบว่า")?
4. What does one clip cost in wall-clock, and what is the logprob distribution
   (so ELEVENLABS_MIN_WORD_LOGPROB can be set from data, not a guess)?

Usage, from ``backend/``::

    python scripts/probe_elevenlabs.py path/to/clip.mp4
    python scripts/probe_elevenlabs.py path/to/audio_000.wav --keyterms "เซรั่ม,วิตซี"
    python scripts/probe_elevenlabs.py clip.mp4 --verbatim   # compare no_verbatim off

Video input is converted with the same ``extract_speech_wav`` the pipeline uses,
so what you measure here is exactly what production sends.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from packages.core.settings import get_settings  # noqa: E402
from packages.video.elevenlabs_stt import (  # noqa: E402
    SEGMENT_SPLIT_GAP,
    build_segments,
    build_silence_gaps,
    extract_pieces,
    extract_tokens,
    transcribe_clip,
)

# Thai fillers no_verbatim is expected to strip.
FILLERS = ("เอ่อ", "อ่า", "เอิ่ม", "แบบว่า", "คือว่า", "อืม")
AUDIO_SUFFIXES = {".wav", ".mp3", ".m4a", ".flac", ".ogg"}


def _as_wav(src: Path, tmpdir: Path) -> Path:
    if src.suffix.lower() in AUDIO_SUFFIXES and src.suffix.lower() == ".wav":
        return src
    from packages.video.audio_extract import extract_speech_wav

    out = tmpdir / "probe.wav"
    print(f"→ extracting speech WAV from {src.name} …")
    extract_speech_wav(src, out)
    return out


def _pct(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, int(round(p / 100 * (len(ordered) - 1))))
    return ordered[idx]


def _report(response: dict, elapsed: float, min_logprob: float) -> None:
    raw = response.get("words") or []
    pieces, events = extract_pieces(response)
    words, _ = extract_tokens(response, min_logprob=min_logprob)
    unfiltered, _ = extract_tokens(response, min_logprob=float("-inf"))
    segments = build_segments(words, raw)
    gaps = build_silence_gaps(segments, events)

    types: dict[str, int] = {}
    for tok in raw:
        types[str(tok.get("type"))] = types.get(str(tok.get("type")), 0) + 1

    durations = [w["end"] - w["start"] for w in words]
    inner_gaps = [
        round(b["start"] - a["end"], 3)
        for a, b in zip(words, words[1:], strict=False)
        if b["start"] - a["end"] < SEGMENT_SPLIT_GAP
    ]
    logprobs = [
        float(t["logprob"]) for t in raw
        if t.get("type") == "word" and t.get("logprob") is not None
    ]
    audio_sec = float(response.get("audio_duration_secs") or 0.0)
    speech_sec = sum(s["end"] - s["start"] for s in segments)

    print("\n══ 1. tokens ═══════════════════════════════════════════════")
    print(f"  language      : {response.get('language_code')} "
          f"(p={response.get('language_probability')})")
    print(f"  token types   : {types}")
    print(f"  raw pieces    : {len(pieces)} → merged into {len(unfiltered)} words "
          f"({len(pieces) / max(len(unfiltered), 1):.1f} pieces/word"
          + ("  ⚠ grapheme-split, merge is load-bearing)" if len(pieces) > len(unfiltered) * 1.5
             else "  ✓ already word-shaped)"))
    print(f"  words kept    : {len(words)} / {len(unfiltered)} "
          f"(dropped {len(unfiltered) - len(words)} below logprob {min_logprob})")
    event_sec = sum(e["end"] - e["start"] for e in events)
    print(f"  audio events  : {len(events)} spanning {event_sec:.1f}s — all cut as noise"
          + (f" → {sorted({e['text'] for e in events})[:5]}" if events else ""))
    if durations:
        print(f"  word duration : median {statistics.median(durations):.3f}s  "
              f"min {min(durations):.3f}s  max {max(durations):.3f}s")
    print("  first 12      : " + " | ".join(
        f"{w['word']}[{w['start']:.2f}-{w['end']:.2f}]" for w in words[:12]))

    print("\n══ 2. gaps ═════════════════════════════════════════════════")
    if inner_gaps:
        print(f"  intra-phrase  : median {statistics.median(inner_gaps):.3f}s  "
              f"p95 {_pct(inner_gaps, 95):.3f}s  max {max(inner_gaps):.3f}s")
        print(f"  SEGMENT_SPLIT_GAP is {SEGMENT_SPLIT_GAP:.2f}s — "
              + ("✓ p95 sits well under it"
                 if _pct(inner_gaps, 95) < SEGMENT_SPLIT_GAP * 0.6
                 else "⚠ p95 is close to it; real pauses may be merged into speech"))
    print(f"  segments      : {len(segments)}")
    print(f"  silence kept  : {len(gaps)} span(s)"
          + (f" → {[(g['in'], g['out'], g['reason']) for g in gaps]}" if gaps else ""))
    if audio_sec:
        print(f"  speech / clip : {speech_sec:.1f}s of {audio_sec:.1f}s "
              f"({speech_sec / audio_sec * 100:.0f}% kept before padding)")

    print("\n══ 3. no_verbatim ══════════════════════════════════════════")
    text = str(response.get("text", ""))
    found = {f: text.count(f) for f in FILLERS if f in text}
    print(f"  fillers left  : {found or 'none'}"
          + ("" if found else "   ✓"))
    print(f"  script chars  : {len(text)}")

    print("\n══ 4. cost signals ═════════════════════════════════════════")
    print(f"  wall clock    : {elapsed:.1f}s"
          + (f"  ({elapsed / audio_sec:.2f}x realtime)" if audio_sec else ""))
    if logprobs:
        print(f"  logprob       : p05 {_pct(logprobs, 5):.2f}  "
              f"median {statistics.median(logprobs):.2f}  min {min(logprobs):.2f}")
        print("  → set ELEVENLABS_MIN_WORD_LOGPROB just below p05 "
              f"(≈{_pct(logprobs, 5) - 0.3:.1f}) unless p05 already looks like noise")
    else:
        print("  logprob       : not returned by this model/params")


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("media", type=Path, help="video or audio file")
    ap.add_argument("--keyterms", default="", help="comma-separated product/brand names")
    ap.add_argument("--verbatim", action="store_true",
                    help="disable no_verbatim for this run (compare filler removal)")
    ap.add_argument("--dump", type=Path, help="write the raw Scribe response here")
    args = ap.parse_args()

    if not args.media.exists():
        print(f"no such file: {args.media}", file=sys.stderr)
        return 2

    s = get_settings()
    if not s.elevenlabs_api_key:
        print("ELEVENLABS_API_KEY is not set in .env", file=sys.stderr)
        return 2
    if args.verbatim:
        s.elevenlabs_no_verbatim = False

    keyterms = [t.strip() for t in args.keyterms.split(",") if t.strip()]
    print(f"model={s.elevenlabs_stt_model}  language={s.elevenlabs_language or 'auto'}  "
          f"granularity={s.elevenlabs_timestamps_granularity}  "
          f"no_verbatim={s.elevenlabs_no_verbatim}  keyterms={len(keyterms)}")

    with tempfile.TemporaryDirectory() as td:
        wav = _as_wav(args.media, Path(td))
        size_mb = wav.stat().st_size / 1024 / 1024
        print(f"→ uploading {wav.name} ({size_mb:.1f} MB) …")
        started = time.monotonic()
        response = await transcribe_clip(wav, keyterms or None)
        elapsed = time.monotonic() - started

    if args.dump:
        args.dump.write_text(json.dumps(response, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"→ raw response written to {args.dump}")

    _report(response, elapsed, s.elevenlabs_min_word_logprob)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
