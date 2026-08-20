"""Re-cut one highlight under different silence-cut constants and render them.

Why this exists: the resnap padding constants in ``packages/video/timeline.py``
were sized for the Whisper era — their own comments say so ("phonemes Whisper
placed just before segment.start", "Whisper timing glitches"). With ElevenLabs
Scribe the timestamps are character-accurate, so the padding may be paying for a
problem that no longer exists. On the first real long-form run every highlight
came out the same length as its raw window (661.2 s in -> 661.8 s out): the
silence cut fired 26 times and removed nothing, because the pad per join
(0.50 + 1.00 s) is larger than the gap that triggers a cut (1.0 s).

This script does not argue about that — it renders the versions so the
difference can be heard.

Usage (from backend/):

    python scripts/recut_experiment.py <project_uid_prefix> [highlight_id]
    RECUT_RENDER="new+gap0.5" python scripts/recut_experiment.py b99 h01

The window's transcript is cached next to the project after the first run, so
sweeping constants afterwards costs no Scribe credits. Writes
``highlights/<id>_recut_<variant>.mp4``; nothing the app reads is touched.
"""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
import sys
import tempfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from packages.video import timeline as T  # noqa: E402
from packages.video.dub_render import concat_stream_copy  # noqa: E402
from packages.video.elevenlabs_stt import run_transcription  # noqa: E402
from packages.video.ffmpeg_bin import media_duration, run_ffmpeg, trim_media  # noqa: E402

# The tight set. Each value is what the acoustics need, not what a sloppy
# recognizer needed: a Thai onset/tone tail is ~0.1 s, not ~1 s.
TIGHT = {
    "JOIN_LEAD_IN": 0.10,
    "JOIN_TAIL": 0.15,
    "WORD_LEAD_IN": 0.08,
    "WORD_TAIL": 0.15,
    "OPENING_LEAD_IN": 0.15,
    "CONCLUSION_TAIL": 0.30,
    "HEAD_LOOKBACK_SEC": 0.0,   # existed only to catch phonemes Whisper misplaced
    "SEGMENT_MERGE_GAP": 1.2,   # was 2.5 to undo Whisper's grapheme-gap inflation
}


def find_project(prefix: str) -> pathlib.Path:
    root = pathlib.Path(os.environ["APPDATA"]) / "noey-video-edit" / "projects"
    for d in root.iterdir():
        if d.name.startswith(prefix):
            return d
    raise SystemExit(f"no project starting with {prefix}")


def build_cuts(segments: list[dict], *, source_duration: float) -> list[dict]:
    """The exact chain gate_highlights runs inside a highlight window."""
    cuts = T.build_speech_cuts(
        segments,
        gap_threshold=T.EDITORIAL_BLOCK_GAP,
        source_duration=source_duration,
    )
    cuts = T.resnap_selected_cuts(cuts, segments, source_duration=source_duration)
    cuts = T.filter_short_cuts(cuts)
    cuts = T.remove_overlapping_cuts(cuts)
    return cuts


def render(video: pathlib.Path, cuts: list[dict], out: pathlib.Path, offset: float) -> None:
    """Trim each cut out of the source and concat — the sidecar's own path."""
    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = pathlib.Path(tmp)
        parts: list[pathlib.Path] = []
        for i, c in enumerate(cuts, start=1):
            part = tmpdir / f"part_{i:03d}.mp4"
            trim_media(video, part, float(c["in"]) + offset, float(c["out"]) - float(c["in"]))
            parts.append(part)
        concat_stream_copy(parts, out, tmpdir / "list.txt")


async def load_segments(pdir: pathlib.Path, hid: str, src_in: float, window: float) -> list[dict]:
    """Transcript for just this window, cached — Scribe is charged per second."""
    cache = pdir / "audio" / f"_recut_{hid}_transcript.json"
    if cache.exists():
        segments: list[dict] = json.loads(cache.read_text(encoding="utf-8"))
        print(f"transcript from cache: {len(segments)} segments (no Scribe call)")
        return segments

    import ffmpeg as ffmpeg_lib

    slice_wav = pdir / "audio" / f"_recut_{hid}.wav"
    run_ffmpeg(
        ffmpeg_lib
        .input(str(pdir / "audio" / "audio_000.wav"), ss=src_in, t=window)
        .output(str(slice_wav), ac=1, ar=16000, acodec="pcm_s16le", f="wav")
        .overwrite_output(),
        label="recut_slice",
    )
    print(f"transcribing {media_duration(slice_wav):.1f}s of audio…")
    transcript = await run_transcription([slice_wav], diarize=False)
    slice_wav.unlink(missing_ok=True)
    if transcript is None:
        raise SystemExit("transcription returned nothing")
    segments = transcript["segments"]
    cache.write_text(json.dumps(segments, ensure_ascii=False), encoding="utf-8")
    print(f"segments: {len(segments)} (cached at {cache.name})")
    return segments


async def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    pdir = find_project(sys.argv[1])
    hid = sys.argv[2] if len(sys.argv) > 2 else "h01"

    project = json.loads((pdir / "project.json").read_text(encoding="utf-8"))
    items = (project.get("highlightIndex") or {}).get("items") or []
    item = next((i for i in items if i["id"] == hid), None)
    if item is None:
        raise SystemExit(f"{hid} not in highlightIndex ({[i['id'] for i in items]})")

    src_in, src_out = float(item["srcIn"]), float(item["srcOut"])
    window = src_out - src_in
    print(f"{hid}: {item['title']}")
    print(f"window {src_in:.1f}s -> {src_out:.1f}s  ({window:.1f}s)")

    segments = await load_segments(pdir, hid, src_in, window)

    # What is actually there to remove: the raw gaps between speech segments.
    gaps = [
        float(b["start"]) - float(a["end"])
        for a, b in zip(segments, segments[1:], strict=False)
        if float(b["start"]) > float(a["end"])
    ]
    buckets = [(0.0, 0.3), (0.3, 0.5), (0.5, 0.7), (0.7, 1.0), (1.0, 2.0), (2.0, 99.0)]
    print("\nsilence between segments:")
    for lo, hi in buckets:
        sel = [g for g in gaps if lo <= g < hi]
        if sel:
            print(f"  {lo:.2f}-{hi:.2f}s: {len(sel):>3} gaps, {sum(sel):>5.1f}s total")
    print(f"  ALL: {len(gaps)} gaps, {sum(gaps):.1f}s total "
          f"({sum(gaps) / window * 100:.1f}% of the window)")

    # Padding is only half the story: a gap is never cut at all unless it
    # exceeds EDITORIAL_BLOCK_GAP, so the sweep varies that too.
    variants: list[tuple[str, dict[str, float], float]] = [
        ("old", {}, 1.0),
        ("new", TIGHT, 1.0),
        ("new+gap0.7", TIGHT, 0.7),
        ("new+gap0.5", TIGHT, 0.5),
        ("new+gap0.35", TIGHT, 0.35),
        ("oldpad+gap0.5", {}, 0.5),
        # SEGMENT_MERGE_GAP is resnap's re-absorb window: a neighbouring segment
        # within it gets pulled back into the cut, which undoes the split that
        # EDITORIAL_BLOCK_GAP just made. Sweeping it separates the two effects.
        ("tight+merge0.3", {**TIGHT, "SEGMENT_MERGE_GAP": 0.3}, 0.5),
        ("tight+merge0.3+g035", {**TIGHT, "SEGMENT_MERGE_GAP": 0.3}, 0.35),
        # The end state: one threshold decides a merge, not two. resnap stops
        # having a second opinion about what build_speech_cuts already split.
        ("one-threshold@0.5", {**TIGHT, "SEGMENT_MERGE_GAP": 0.26}, 0.5),
        ("one-threshold@0.35", {**TIGHT, "SEGMENT_MERGE_GAP": 0.26}, 0.35),
        ("no-reabsorb@0.5", {**TIGHT, "SEGMENT_MERGE_GAP": 0.0}, 0.5),
    ]
    results: dict[str, list[dict]] = {}
    for label, overrides, gap in variants:
        saved = {k: getattr(T, k) for k in TIGHT}
        saved_gap = T.EDITORIAL_BLOCK_GAP
        for k, v in overrides.items():
            setattr(T, k, v)
        T.EDITORIAL_BLOCK_GAP = gap
        try:
            results[label] = build_cuts(segments, source_duration=window)
        finally:
            for k, v in saved.items():
                setattr(T, k, v)
            T.EDITORIAL_BLOCK_GAP = saved_gap

    print(f"\n{'variant':<14} {'cuts':>5} {'kept':>9} {'removed':>16}")
    for label, cuts in results.items():
        kept = sum(float(c["out"]) - float(c["in"]) for c in cuts)
        gone = window - kept
        print(f"{label:<14} {len(cuts):>5} {kept:>8.1f}s {gone:>8.1f}s ({gone / window * 100:>4.1f}%)")

    to_render = ["old", os.environ.get("RECUT_RENDER", "new+gap0.5")]
    video = pdir / "normalized" / "norm_000.mp4"
    for label in to_render:
        cuts = results[label]
        name = label.replace("+", "_").replace(".", "")
        out = pdir / "highlights" / f"{hid}_recut_{name}.mp4"
        render(video, cuts, out, offset=src_in)
        print(f"{out.name}: {media_duration(out):.1f}s  ({len(cuts)} cuts)")


if __name__ == "__main__":
    asyncio.run(main())
