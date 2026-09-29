"""Render the cuts an `effort_ab.py` run planned, so they can be watched.

Token counts settle what a thinking level COSTS. They say nothing about
whether it cuts well, and that is the half the owner has to judge by eye — so
this turns each run in `effort-ab.json` into a real MP4 from the
full-quality source.

No model is called and nothing is billed: the cut list already exists, this
is ffmpeg only. Each segment is trimmed from the source and the pieces are
concatenated in the order the edit script gave them, which is the order the
voiceover lines run in — not the order they appear in the source.

A label is burned into the top-left ("HIGH 1", "MEDIUM 2") because the whole
point is watching them back to back, and four near-identical 14-second clips
are impossible to keep straight otherwise.

    python scripts/effort_ab_render.py                       # every run in the report
    python scripts/effort_ab_render.py --only high-1,medium-1
    python scripts/effort_ab_render.py --source path/to/original.mp4
"""

from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

DEFAULT_REPORT = "data/ab/20260925-184300/effort-ab.json"
#: The proxy the model watched is 270x480; render from the real footage beside
#: it so what is judged is the cut, not the proxy's quality.
DEFAULT_SOURCE = "data/ab/20260925-184300/norm_000.mp4"


def _run(cmd: list[str]) -> None:
    done = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if done.returncode != 0:
        tail = (done.stderr or "").strip().splitlines()[-4:]
        raise RuntimeError("ffmpeg failed:\n  " + "\n  ".join(tail))


def _label_filter(text: str, font: pathlib.Path | None) -> str:
    """A readable burned-in tag. Falls back to no label if no font is found —
    an unlabelled render is still worth watching, a crash is not."""
    if font is None:
        return ""
    esc = text.replace(":", r"\:").replace("'", r"\'")
    return (
        f"drawtext=fontfile='{font}':text='{esc}':x=40:y=60:fontsize=54:"
        "fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=18"
    )


def _find_font() -> pathlib.Path | None:
    """A bundled font, but only if this ffmpeg can actually draw text.

    A Homebrew ffmpeg built without libfreetype has no ``drawtext`` filter at
    all, and asking for one fails the whole render rather than the label — so
    the capability is checked, not assumed."""
    from packages.video.ffmpeg_bin import ffmpeg_cmd

    have = subprocess.run(
        [ffmpeg_cmd(), "-hide_banner", "-filters"],
        capture_output=True, text=True, check=False,
    )
    if " drawtext " not in (have.stdout or ""):
        return None
    for pat in ("*.ttf", "*.otf"):
        for f in sorted(pathlib.Path("data/fonts").glob(pat)):
            return f
    return None


def render_run(
    run: dict[str, Any], source: pathlib.Path, out_dir: pathlib.Path, font: pathlib.Path | None
) -> pathlib.Path | None:
    from packages.video.ffmpeg_bin import ffmpeg_cmd

    cuts = run.get("cuts") or []
    if not cuts:
        return None
    tag = str(run["tag"])
    work = out_dir / f".{tag}-parts"
    work.mkdir(parents=True, exist_ok=True)
    label = _label_filter(tag.upper().replace("-", " "), font)

    parts: list[pathlib.Path] = []
    for i, c in enumerate(cuts):
        start, end = float(c["start"]), float(c["end"])
        if end <= start:
            continue
        part = work / f"{i:03d}.mp4"
        # -ss before -i seeks fast; -ss again after would be frame-exact but
        # these boundaries came from a 5 fps read, so keyframe-level is enough.
        cmd = [
            ffmpeg_cmd(), "-y", "-hide_banner", "-loglevel", "error",
            "-ss", f"{start:.3f}", "-to", f"{end:.3f}", "-i", str(source),
        ]
        if label:
            cmd += ["-vf", label]
        cmd += [
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(part),
        ]
        _run(cmd)
        parts.append(part)

    if not parts:
        return None
    listing = work / "parts.txt"
    listing.write_text("".join(f"file '{p.name}'\n" for p in parts))
    out = out_dir / f"cut-{tag}.mp4"
    _run([
        ffmpeg_cmd(), "-y", "-hide_banner", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", str(listing),
        "-c", "copy", "-movflags", "+faststart", str(out),
    ])
    for p in parts:
        p.unlink(missing_ok=True)
    listing.unlink(missing_ok=True)
    work.rmdir()
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("report", nargs="?", default=DEFAULT_REPORT)
    ap.add_argument("--source", default=DEFAULT_SOURCE, help="full-quality footage to cut")
    ap.add_argument("--only", default="", help="comma-separated run tags")
    args = ap.parse_args()

    report_path = pathlib.Path(args.report).resolve()
    if not report_path.exists():
        print(f"no such report: {report_path}", file=sys.stderr)
        return 2
    source = pathlib.Path(args.source).resolve()
    if not source.exists():
        print(f"no such source: {source}", file=sys.stderr)
        return 2

    report = json.loads(report_path.read_text())
    wanted = {t.strip() for t in args.only.split(",") if t.strip()}
    runs = [r for r in report.get("runs", []) if "error" not in r]
    if wanted:
        runs = [r for r in runs if r["tag"] in wanted]
    if not runs:
        print("nothing to render", file=sys.stderr)
        return 1

    out_dir = report_path.parent / "renders"
    out_dir.mkdir(exist_ok=True)
    font = _find_font()
    if font is None:
        print("this ffmpeg cannot draw text — rendering without labels")

    made: list[pathlib.Path] = []
    for run in runs:
        print(f"  {run['tag']} ({run['segments']} cuts, {run['out_sec']}s) … ", end="", flush=True)
        try:
            out = render_run(run, source, out_dir, font)
        except Exception as exc:  # noqa: BLE001 — one bad render must not lose the rest
            print(f"FAILED: {exc}")
            continue
        if out is None:
            print("no cuts")
            continue
        made.append(out)
        print(f"{out.name}  {out.stat().st_size / 1e6:.1f} MB")

    print(f"\n{len(made)} file(s) → {out_dir}")
    return 0 if made else 1


if __name__ == "__main__":
    raise SystemExit(main())
