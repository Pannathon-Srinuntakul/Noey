"""Effects-layer render engine — bake an `effects.json` onto a cut video.

Consumes the normalized EffectsDoc (packages/video/effects.py) and applies
every instance as an ffmpeg filter over the real footage:

  base ─▶ [all transforms in one filter_complex] ─▶ final_fx.mp4

The overlay compositing stage (transparent Remotion clips overlaid on top) was
removed 2026-08-12 together with the node-sidecar — every effect is now a
transform on the footage itself. Captions are still burned separately by
packages/video/caption.py (ASS), a different stage.

The post-concat stage is a SINGLE ffmpeg pass (one filter_complex) rather than
a re-encode per effect: chaining apply_zoom sequentially would decode+encode
the whole video once per instance, multiplying render time and stacking
generation loss.

``punch-zoom`` used to be baked onto each per-scene clip and the clips
re-concatenated into a new base, to stop a zoom drifting across a real cut
boundary. That was removed 2026-08-14: the clips are intermediates with no
burned captions and no audio, so the rebuilt base silently dropped both from
final_fx.mp4. The anti-drift property is kept by clamping each transform's
window to the cut it starts in (``_clamp_transforms_to_cuts``) and applying
everything in the normal single pass over the REAL base.
"""

from __future__ import annotations

import bisect
import shutil
import subprocess
from pathlib import Path

from packages.core.logging import get_logger
from packages.video.effects import EffectsDoc
from packages.video.ffmpeg_bin import (
    ffmpeg_cmd,
    has_audio_stream,
    video_encode_kwargs,
    video_stream_info,
)
from packages.video.transforms import transform_entry

log = get_logger(__name__)

# Below this clip-local duration, a clamped punch-zoom window is degenerate
# (a near-zero-length ffmpeg `enable` window) — skip baking it rather than
# emit a filter that does effectively nothing. Deliberately smaller than
# effects_ai.py's `_MIN_ZOOM_HOLD_SEC` (0.7s, a quality floor at authoring
# time) — this is only a last-resort sanity guard against a genuinely
# degenerate render-time clamp.
_MIN_BAKED_ZOOM_SEC = 0.05


def _clip_index_for(global_time: float, boundaries: list[float]) -> tuple[int, float, float]:
    """Map an absolute output-timeline second to its containing clip.

    ``boundaries`` is the cumulative-duration list ``[0, d1, d1+d2, ...,
    total]`` for clips 1..N (``len(boundaries) == N + 1``). Returns
    ``(clip_index, boundary_start, boundary_end)`` — ``clip_index`` is
    1-based, matching ``clip_{index:03d}.mp4``. Half-open buckets
    ``[boundaries[k-1], boundaries[k])``, same convention as
    ``transforms.py _in_window`` — a zoom starting exactly on a cut boundary
    belongs to the clip that starts there, not the one that just ended.
    Always returns a valid clip index (clamped to ``[1, N]``) — float drift
    or a window ending exactly at the video's total duration must not be
    treated as "out of range".
    """
    n = len(boundaries) - 1
    pos = bisect.bisect_right(boundaries, global_time)
    pos = max(1, min(pos, n))
    return pos, boundaries[pos - 1], boundaries[pos]


def _clamp_transforms_to_cuts(doc: EffectsDoc, clip_durations_sec: list[float]) -> EffectsDoc:
    """Keep every transform inside the cut it starts in.

    A zoom that runs past a cut plays as a mistake: the shot changes mid-move.
    The window is clamped rather than dropped, and an instance that would be
    left shorter than a few frames is passed through untouched (better a small
    overshoot than a zoom that silently disappears).
    """
    if not clip_durations_sec:
        return doc
    boundaries = [0.0]
    for d in clip_durations_sec:
        boundaries.append(boundaries[-1] + max(0.0, float(d)))

    instances = []
    for inst in doc.instances:
        if inst.kind != "transform":
            instances.append(inst)
            continue
        _, _, b_end = _clip_index_for(inst.startSec, boundaries)
        if inst.endSec <= b_end + 1e-3:
            instances.append(inst)
            continue
        clamped = b_end - inst.startSec
        if clamped < _MIN_BAKED_ZOOM_SEC:
            instances.append(inst)
            continue
        log.info(
            "effects_transform_clamped_to_cut",
            instanceId=inst.id,
            fromSec=round(inst.durationSec, 3),
            toSec=round(clamped, 3),
        )
        instances.append(inst.model_copy(update={"durationSec": clamped}))
    return doc.model_copy(update={"instances": instances})


def build_effects_filtergraph(
    doc: EffectsDoc,
    *,
    width: int,
    height: int,
    fps: float,
) -> tuple[str, str]:
    """Build the filter_complex string + the label of its final video pad.

    Returns ``("", "0:v")`` when the doc has no applicable instances so the
    caller can fall back to a plain copy.
    """
    chains: list[str] = []
    cur = "0:v"

    for idx, inst in enumerate(doc.transforms()):
        entry = transform_entry(inst.componentId)
        if entry is None:
            log.warning("effects_unknown_transform", componentId=inst.componentId)
            continue
        vf = entry["builder"](
            inst.props,
            width=width,
            height=height,
            start_sec=inst.startSec,
            end_sec=inst.endSec,
            fps=fps,
        )
        label = f"t{idx}"
        chains.append(f"[{cur}]{vf}[{label}]")
        cur = label

    if not chains:
        return "", "0:v"
    return ";".join(chains), cur


def render_effects(
    base_path: str | Path,
    out_path: str | Path,
    doc: EffectsDoc,
    *,
    width: int | None = None,
    height: int | None = None,
    fps: float | None = None,
    clip_durations_sec: list[float] | None = None,
) -> None:
    """Render ``base_path`` with all effects in ``doc`` baked in, to ``out_path``.

    Base dims/fps default to the base video's own.

    ``clip_durations_sec`` (optional): the measured per-cut durations, used to
    clamp each transform to its own cut so a zoom cannot bleed across a scene
    change. Omitted → windows are applied exactly as authored.
    """
    base_path = Path(base_path)
    if clip_durations_sec:
        # Clamp each punch-zoom to the cut it starts in, then apply everything
        # in the single pass below.
        #
        # This used to REBUILD the base by re-baking each clip_NNN.mp4 and
        # re-concatenating them. The clips are intermediates: they carry no
        # burned captions (those are burned onto the concat afterwards) and no
        # audio at all — so whenever a punch-zoom existed, final_fx.mp4 came out
        # with the subtitles gone and silent, and final_fx is the top candidate
        # for preview, export and the phone hand-off (2026-08-14). It also
        # trusted clip durations recorded by a DIFFERENT render: the voiceover
        # pass rewrites clips/ from its own cut list and never refreshes them.
        # Clamping keeps the only property the rebuild was for — a zoom must not
        # bleed across a cut — without discarding the real base.
        doc = _clamp_transforms_to_cuts(doc, clip_durations_sec)

    info = video_stream_info(base_path)
    w = width or info["width"]
    h = height or info["height"]
    r = fps or float(info["fps"])

    input_args: list[str] = ["-i", str(base_path)]
    filtergraph, final_label = build_effects_filtergraph(doc, width=w, height=h, fps=r)

    has_audio = has_audio_stream(base_path)
    enc = video_encode_kwargs()
    args: list[str] = [ffmpeg_cmd(), "-hide_banner", "-loglevel", "error", "-y", *input_args]

    if filtergraph:
        args += ["-filter_complex", filtergraph, "-map", f"[{final_label}]"]
    else:
        # No applicable effects — straight copy of the video stream.
        args += ["-map", "0:v"]
    if has_audio:
        args += ["-map", "0:a"]

    # Encoder kwargs (from video_encode_kwargs) → ffmpeg CLI flags.
    vcodec = enc.pop("vcodec")
    args += ["-c:v", str(vcodec)]
    for k, v in enc.items():
        args += [f"-{k}", str(v)]
    if has_audio:
        args += ["-c:a", "aac", "-b:a", "192k"]
    args += ["-movflags", "+faststart", str(out_path)]

    log.info(
        "effects_render_start",
        base=str(base_path),
        transforms=len(doc.transforms()),
        has_filtergraph=bool(filtergraph),
    )
    try:
        result = subprocess.run(args, capture_output=True, timeout=1800)
        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", errors="replace").strip()
            tail = stderr[-2000:]
            last = next((ln.strip() for ln in reversed(tail.splitlines()) if ln.strip()), "unknown")
            log.error("effects_render_failed", stderr=tail)
            raise RuntimeError(f"ffmpeg (effects_render): {last}")
    finally:
        # Scratch left by the removed pre-clip bake — projects rendered before
        # 2026-08-14 still carry it, and it is the size of the whole render.
        _clean_zoom_workdir(Path(out_path).parent)
    log.info("effects_render_done", out=str(out_path))


def _clean_zoom_workdir(work_dir: Path) -> None:
    """Remove leftovers of the old pre-clip zoom bake (best effort)."""
    shutil.rmtree(work_dir / "_effects_zoom_tmp", ignore_errors=True)
    for name in ("_effects_zoomed_base.mp4", "_effects_zoom_concat.txt"):
        try:
            (work_dir / name).unlink(missing_ok=True)
        except OSError:
            pass
