"""Compare cut-extraction strategies on a finished project: speed AND accuracy.

Rendering a highlight currently costs ~27-52 s PER CUT regardless of how long
that cut is, because ``trim_media`` opens the source at 0 and filters the wanted
range out of the decoded stream — every cut re-decodes the file from the start,
383 times for one podcast (175 minutes of ffmpeg for a 160 MB source).

The alternative is to SEEK before decoding. Fast seeking alone lands on a
keyframe and can miss by a second, which this pipeline cannot accept, so the
candidate here is the hybrid every ffmpeg guide recommends: jump to shortly
before the cut (fast, keyframe-accurate), then trim precisely from there.

Speed is the easy half. The half that decides it is whether the output is
IDENTICAL — same duration, same content — which is checkable because the plan
already exists: the same in/out values that produced the shipped clips.

Usage (from backend/):

    python scripts/seek_bench.py <project_uid_prefix> [highlight_id...]
"""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from packages.video.dub_render import concat_stream_copy  # noqa: E402
from packages.video.ffmpeg_bin import (  # noqa: E402
    ffmpeg_cmd,
    hwaccel_input_kwargs,
    media_duration,
    run_ffmpeg,
    trim_media,
)

#: How far before the cut the fast seek lands. Long enough to cover the gap to
#: the previous keyframe on ordinary footage, short enough that the decode that
#: follows is trivial.
PREROLL_SEC = 3.0


def trim_media_seek(
    src: pathlib.Path, out: pathlib.Path, start: float, duration: float
) -> None:
    """Fast-seek to just before ``start``, then trim exactly from there.

    ``-ss`` BEFORE ``-i`` is the fast form: ffmpeg jumps in the container
    instead of decoding its way there. It lands on a keyframe, which is why the
    remaining offset is handed to the trim filters rather than trusted as-is.
    """
    import ffmpeg

    pre = max(0.0, start - PREROLL_SEC)
    offset = start - pre  # what is left to trim after the jump
    inp = ffmpeg.input(str(src), ss=pre, **hwaccel_input_kwargs())
    v = (
        inp.video.filter("trim", start=offset, duration=duration)
        .filter("setpts", "PTS-STARTPTS")
    )
    a = (
        inp.audio.filter("atrim", start=offset, duration=duration)
        .filter("asetpts", "PTS-STARTPTS")
    )
    run_ffmpeg(
        ffmpeg.output(
            v, a, str(out),
            vcodec="libx264", preset="veryfast", crf=20,
            acodec="aac", audio_bitrate="192k",
        ).overwrite_output(),
        label="render_cut_seek",
    )


def audio_fingerprint(path: pathlib.Path, buckets: int = 40) -> list[int]:
    """Coarse loudness shape of a clip — enough to tell two renders apart.

    Comparing durations alone would pass a clip that is the right LENGTH but cut
    from the wrong place; comparing frames pixel-by-pixel would fail on
    re-encode noise. Loudness over time survives re-encoding and moves the
    moment the content does.
    """
    ff = ffmpeg_cmd()
    proc = subprocess.run(
        [ff, "-v", "error", "-i", str(path), "-ac", "1", "-ar", "8000",
         "-f", "s16le", "-"],
        capture_output=True, check=False,
    )
    raw = proc.stdout
    if not raw:
        return []
    import array

    a = array.array("h")
    a.frombytes(raw[: len(raw) - (len(raw) % 2)])
    if not a:
        return []
    step = max(1, len(a) // buckets)
    out: list[int] = []
    for i in range(0, len(a) - step + 1, step):
        chunk = a[i: i + step]
        rms = (sum(int(x) * int(x) for x in chunk) / len(chunk)) ** 0.5
        out.append(int(rms // 50))  # quantised: re-encode noise must not matter
    return out[:buckets]


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    root = pathlib.Path(os.environ["APPDATA"]) / "noey-video-edit" / "projects"
    pdir = next(d for d in root.iterdir() if d.name.startswith(sys.argv[1]))
    proj = json.loads((pdir / "project.json").read_text(encoding="utf-8"))
    items = (proj.get("highlightIndex") or {}).get("items") or []
    wanted = sys.argv[2:] or [items[0]["id"]]
    src = pdir / "normalized" / "norm_000.mp4"

    print(f"{pdir.name[:8]} — {proj.get('name', '')[:52]}")
    print(f"source: {media_duration(src) / 60:.0f} min\n")

    for hid in wanted:
        item = next(x for x in items if x["id"] == hid)
        cuts = (item.get("timeline") or {}).get("timeline") or []
        if not cuts:                      # index kept in the app strips timelines
            # The app strips timelines out of its copy; the worker's own copy
            # keeps them, under the SERVER project id (proj["remoteUid"] when
            # the local and server ids differ).
            uid = proj.get("remoteUid") or proj.get("serverUid") or proj["uid"]
            server = pathlib.Path(f"data/video_outputs/{uid}/highlights/index.json")
            if not server.exists():
                cands = sorted(pathlib.Path("data/video_outputs").glob("*/highlights/index.json"),
                               key=lambda p: -p.stat().st_mtime)
                server = cands[0]
            src_items = json.loads(server.read_text(encoding="utf-8"))["items"]
            cuts = next(x for x in src_items if x["id"] == hid)["timeline"]["timeline"]
        old_clip = pdir / "highlights" / f"{hid}.mp4"
        print(f"=== {hid}: {len(cuts)} cuts, shipped {media_duration(old_clip):.1f}s")

        results: dict[str, tuple[float, pathlib.Path]] = {}
        for label, fn in (
            ("current (decode from 0)", None),
            ("seek-then-trim", trim_media_seek),
        ):
            with tempfile.TemporaryDirectory() as tmp:
                work = pathlib.Path(tmp)
                t0 = time.time()
                parts: list[pathlib.Path] = []
                for i, c in enumerate(cuts, start=1):
                    p = work / f"p{i:03d}.mp4"
                    dur = float(c["out"]) - float(c["in"])
                    if fn is None:
                        trim_media(src, p, float(c["in"]), dur)
                    else:
                        fn(src, p, float(c["in"]), dur)
                    parts.append(p)
                out = pdir / "highlights" / f"{hid}_bench_{'a' if fn is None else 'b'}.mp4"
                concat_stream_copy(parts, out, work / "list.txt")
                elapsed = time.time() - t0
            results[label] = (elapsed, out)
            print(f"  {label:<24} {elapsed / 60:6.1f} min  ->  {media_duration(out):6.1f}s")

        (t_old, f_old), (t_new, f_new) = results.values()
        same_len = abs(media_duration(f_old) - media_duration(f_new)) < 0.1
        fp_old, fp_new = audio_fingerprint(f_old), audio_fingerprint(f_new)
        matched = sum(1 for x, y in zip(fp_old, fp_new, strict=False) if abs(x - y) <= 1)
        print(f"  same duration: {same_len} | audio shape match {matched}/{len(fp_old)}")
        print(f"  SPEEDUP: {t_old / t_new:.1f}x\n")


if __name__ == "__main__":
    main()
