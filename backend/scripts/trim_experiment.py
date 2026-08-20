"""Dry-run the content-trim pass (layer 2) on one already-rendered highlight.

Layers: 1 = the selector picks the topic's span, 2 = THIS pass drops the
padding and repetition inside it, 3 = the arithmetic silence cut tightens what
survives. Layer 2 is the one that lets layer 1 stop being stingy: while every
second of a chosen span shipped, choosing widely meant shipping the filler too.

Run from backend/ against a finished speech_highlights project:

    python scripts/trim_experiment.py <project_uid_prefix> [highlight_id]

Prints every segment with KEEP/DROP and the model's reason, then renders the
trimmed clip next to the original so the two can be compared by ear. Uses the
transcript cached by ``recut_experiment.py`` — no Scribe credits are spent, only
one small Gemini call.
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

from packages.video.dub_render import concat_stream_copy  # noqa: E402
from packages.video.ffmpeg_bin import media_duration, trim_media  # noqa: E402
from packages.video.audio_edges import snap_cuts_to_silence  # noqa: E402
from packages.video.speech_select import tighten_window_cuts, trim_span_content  # noqa: E402


def find_project(prefix: str) -> pathlib.Path:
    root = pathlib.Path(os.environ["APPDATA"]) / "noey-video-edit" / "projects"
    for d in root.iterdir():
        if d.name.startswith(prefix):
            return d
    raise SystemExit(f"no project starting with {prefix}")


def cuts_for(
    segments: list[dict],
    ranges: list[tuple[int, int]],
    window: float,
    *,
    wav: pathlib.Path | None = None,
    offset: float = 0.0,
) -> list[dict]:
    """Layer 3 over each surviving piece, then the waveform edge check."""
    out: list[dict] = []
    for a, b in ranges:
        out.extend(
            tighten_window_cuts({"segFrom": a, "segTo": b}, segments, source_duration=window)
        )
    if wav is not None:
        out = snap_cuts_to_silence(out, wav, offset=offset)
    return out


def render(video: pathlib.Path, cuts: list[dict], out: pathlib.Path, offset: float) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmpd = pathlib.Path(tmp)
        parts: list[pathlib.Path] = []
        for i, c in enumerate(cuts, start=1):
            part = tmpd / f"p{i:03d}.mp4"
            trim_media(video, part, float(c["in"]) + offset, float(c["out"]) - float(c["in"]))
            parts.append(part)
        concat_stream_copy(parts, out, tmpd / "list.txt")


async def transcribe_window(pdir: pathlib.Path, tag: str, start: float, dur: float) -> list[dict]:
    """Scribe over one window of the project audio, cached by tag."""
    cache = pdir / "audio" / f"_recut_{tag}_transcript.json"
    if cache.exists():
        print(f"transcript from cache ({cache.name})")
        return list(json.loads(cache.read_text(encoding="utf-8")))

    import ffmpeg as ffmpeg_lib

    from packages.video.elevenlabs_stt import run_transcription
    from packages.video.ffmpeg_bin import run_ffmpeg

    wav = pdir / "audio" / f"_recut_{tag}.wav"
    run_ffmpeg(
        ffmpeg_lib
        .input(str(pdir / "audio" / "audio_000.wav"), ss=start, t=dur)
        .output(str(wav), ac=1, ar=16000, acodec="pcm_s16le", f="wav")
        .overwrite_output(),
        label="trim_slice",
    )
    print(f"transcribing {dur:.0f}s…")
    transcript = await run_transcription([wav], diarize=False)
    wav.unlink(missing_ok=True)
    if transcript is None:
        raise SystemExit("transcription returned nothing")
    segments: list[dict] = transcript["segments"]
    cache.write_text(json.dumps(segments, ensure_ascii=False), encoding="utf-8")
    return segments


async def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    pdir = find_project(sys.argv[1])
    mode = sys.argv[2] if len(sys.argv) > 2 else "h01"

    if mode == "wide":
        # The form that actually tests layer 2: a span far wider than the
        # selector would dare pick while every second of it shipped.
        src_in, window = float(sys.argv[3]), float(sys.argv[4])
        hid = f"wide{int(src_in)}_{int(window)}"
        segments = await transcribe_window(pdir, hid, src_in, window)
        title = why = ""
        print(f"WIDE span: from {src_in:.0f}s, {window:.0f}s long")
    else:
        hid = mode
        project = json.loads((pdir / "project.json").read_text(encoding="utf-8"))
        items = (project.get("highlightIndex") or {}).get("items") or []
        item = next((i for i in items if i["id"] == hid), None)
        if item is None:
            raise SystemExit(f"{hid} not in highlightIndex")
        cache = pdir / "audio" / f"_recut_{hid}_transcript.json"
        if not cache.exists():
            raise SystemExit(f"no cached transcript — run recut_experiment.py {sys.argv[1]} {hid}")
        segments = json.loads(cache.read_text(encoding="utf-8"))
        src_in = float(item["srcIn"])
        window = float(item["srcOut"]) - src_in
        title, why = str(item.get("title") or ""), str(item.get("why") or "")
        print(f"{hid}: {title}")

    last = len(segments) - 1
    print(f"span: {len(segments)} segments, window {window:.1f}s\n")

    target = int(os.environ["TRIM_TARGET"]) if os.environ.get("TRIM_TARGET") else None
    if target:
        print(f"target: {target}s")
    ranges = await trim_span_content(
        segments, seg_from=0, seg_to=last, title=title, why=why, target_sec=target,
    )

    keep_idx = {i for a, b in ranges for i in range(a, b + 1)}
    reason_at = {a: "" for a, _ in ranges}
    for i, seg in enumerate(segments):
        mark = "KEEP" if i in keep_idx else "DROP"
        text = str(seg.get("text") or "").strip()
        head = "  >>> " if i in reason_at and i > 0 else "      "
        print(f"{head}#{i:<3} {mark}  {float(seg['start']):6.1f}s  {text[:78]}")

    wav = pdir / "audio" / "audio_000.wav"
    before = cuts_for(segments, [(0, last)], window, wav=wav, offset=src_in)
    after = cuts_for(segments, ranges, window, wav=wav, offset=src_in)
    kb = sum(c["out"] - c["in"] for c in before)
    ka = sum(c["out"] - c["in"] for c in after)
    print(f"\npieces kept: {len(ranges)}   segments dropped: {len(segments) - len(keep_idx)}"
          f" of {len(segments)}")
    print(f"layer 3 only : {kb:6.1f}s  ({len(before)} cuts)")
    print(f"layer 2 + 3  : {ka:6.1f}s  ({len(after)} cuts)   "
          f"-{kb - ka:.1f}s more removed ({(kb - ka) / kb * 100:.1f}%)")

    out = pdir / "highlights" / f"{hid}_trimmed.mp4"
    render(pdir / "normalized" / "norm_000.mp4", after, out, offset=src_in)
    print(f"{out.name}: {media_duration(out):.1f}s")


if __name__ == "__main__":
    asyncio.run(main())
