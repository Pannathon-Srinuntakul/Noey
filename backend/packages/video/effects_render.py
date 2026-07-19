"""Effects-layer render engine — compose an `effects.json` onto a cut video.

Consumes the normalized EffectsDoc (packages/video/effects.py) plus the already-
rendered overlay clips (produced upstream by the Remotion node-sidecar, one
transparent .mov per overlay instance) and bakes everything onto the base cut
video:

  base ─▶ [punch-zoom: baked per-clip pre-concat, see below] ─▶
  [remaining transforms: whip-pan/scene-drift applied to real footage] ─▶
  [overlays composited on top, each gated to its time window] ─▶ final.mp4

The overlay/whip-pan/scene-drift stage is still a SINGLE ffmpeg pass (one
filter_complex) rather than a re-encode per effect: chaining composite_overlay/
apply_zoom sequentially would decode+encode the whole video once per instance,
multiplying render time and stacking generation loss.

``punch-zoom`` instances are the one exception (2026-07-19): they are baked
onto each INDIVIDUAL per-scene clip file (``clips/clip_NNN.mp4``, produced
pre-concat by the cut stage), at that clip's own LOCAL 0-based timeline, then
the clips are re-concatenated BEFORE the rest of this pipeline runs — see
``_bake_zoom_punches_per_clip``. This removes any possibility of a punch-zoom's
absolute-timeline window drifting relative to the real cut boundaries in the
final concatenated video (whip-pan/scene-drift stay on the post-concat global
timeline: they deliberately straddle a cut or span a whole scene, so they
inherently need more than one clip's worth of footage).

Split of responsibilities (architecture, REMOTION_EFFECTS_REQUIREMENTS.md §8):
- ``kind="transform"`` instances → an ffmpeg filter on the base footage
  (transforms.py builders), applied in start-time order before compositing.
- ``kind="overlay"`` instances → a pre-rendered transparent clip supplied via
  ``overlay_paths[instance_id]``; time-shifted so its frame 0 lands at the
  instance ``startSec`` and gated with ``enable=between(t,start,end)``.

The engine does NOT invoke Remotion — the Node render is a separate upstream
step (Electron main spawns the node-sidecar); this function only needs the
resulting .mov paths. Overlay clips are full-frame WxH (each component positions
itself internally via its props), so they composite at (0,0).
"""

from __future__ import annotations

import bisect
import shutil
import subprocess
from pathlib import Path

from packages.core.logging import get_logger
from packages.video.dub_render import concat_stream_copy
from packages.video.effects import EffectInstance, EffectsDoc
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


def _bake_zoom_punches_per_clip(
    clips_dir: Path,
    clip_durations_sec: list[float],
    zoom_instances: list[EffectInstance],
    *,
    work_dir: Path,
) -> tuple[Path, set[str]]:
    """Bake ``punch-zoom`` instances onto their containing clip's LOCAL
    timeline, then re-concatenate into a fresh base video.

    Reads ``clip_NNN.mp4`` fresh from ``clips_dir`` every call and never
    mutates them — a clip untouched by any zoom is stream-copied into the
    new concat unmodified, and re-running after a prop tweak always re-bakes
    from the original clip, never chains onto a previous bake. Returns the
    new base video path plus the set of instance ids actually baked (an
    instance whose global window falls outside all known clip boundaries —
    stale ``clip_durations_sec`` vs. a re-cut project — is left out of that
    set so the caller can fall back to applying it on the post-concat pass
    instead of silently dropping it).
    """
    if not clip_durations_sec:
        return clips_dir, set()
    boundaries = [0.0]
    for d in clip_durations_sec:
        boundaries.append(boundaries[-1] + max(0.0, float(d)))
    n_clips = len(clip_durations_sec)

    by_clip: dict[int, list[tuple[float, float, EffectInstance]]] = {}
    baked_ids: set[str] = set()
    for inst in zoom_instances:
        idx, b_start, b_end = _clip_index_for(inst.startSec, boundaries)
        local_start = max(0.0, inst.startSec - b_start)
        local_end = min(inst.endSec, b_end) - b_start
        if local_end - local_start < _MIN_BAKED_ZOOM_SEC:
            log.warning(
                "effects_zoom_clip_clamp_too_short",
                instanceId=inst.id, clipIndex=idx,
                localStart=round(local_start, 3), localEnd=round(local_end, 3),
            )
            continue
        by_clip.setdefault(idx, []).append((local_start, local_end, inst))
        baked_ids.add(inst.id)

    if not by_clip:
        return clips_dir, set()

    tmp_dir = work_dir / "_effects_zoom_tmp"
    if tmp_dir.exists():
        shutil.rmtree(tmp_dir, ignore_errors=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)

    clip_paths: list[Path] = []
    for i in range(1, n_clips + 1):
        original = clips_dir / f"clip_{i:03d}.mp4"
        windows = by_clip.get(i)
        if not windows or not original.is_file():
            if windows and not original.is_file():
                log.warning("effects_zoom_clip_missing", clipIndex=i, path=str(original))
            clip_paths.append(original)
            continue

        info = video_stream_info(original)
        synthetic = EffectsDoc(instances=[
            inst.model_copy(update={"startSec": ls, "durationSec": le - ls})
            for ls, le, inst in sorted(windows, key=lambda w: w[0])
        ])
        filtergraph, final_label = build_effects_filtergraph(
            synthetic, [], width=info["width"], height=info["height"], fps=info["fps"],
        )
        baked = tmp_dir / f"clip_{i:03d}.mp4"
        enc = video_encode_kwargs()
        vcodec = enc.pop("vcodec")
        args = [
            ffmpeg_cmd(), "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(original),
            "-filter_complex", filtergraph, "-map", f"[{final_label}]",
            "-an", "-c:v", str(vcodec),
        ]
        for k, v in enc.items():
            args += [f"-{k}", str(v)]
        args += [str(baked)]
        result = subprocess.run(args, capture_output=True, timeout=600)
        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", errors="replace").strip()
            log.error("effects_zoom_clip_bake_failed", clipIndex=i, stderr=stderr[-2000:])
            raise RuntimeError(f"ffmpeg (effects_zoom_clip_bake clip {i}): {stderr[-500:]}")
        clip_paths.append(baked)

    zoomed_base = work_dir / "_effects_zoomed_base.mp4"
    list_path = work_dir / "_effects_zoom_concat.txt"
    concat_stream_copy(clip_paths, zoomed_base, list_path)
    log.info("effects_zoom_preclip_bake_done", clipsBaked=len(by_clip), instancesBaked=len(baked_ids))
    return zoomed_base, baked_ids


def build_effects_filtergraph(
    doc: EffectsDoc,
    overlay_inputs: list[tuple[str, int]],
    *,
    width: int,
    height: int,
    fps: float,
) -> tuple[str, str]:
    """Build the filter_complex string + the label of its final video pad.

    ``overlay_inputs`` maps each overlay instance id to its ffmpeg input index
    (base video is input 0, overlays are 1..N in the same order they are passed
    to ffmpeg as ``-i``). Returns ``("", "0:v")`` when the doc has no applicable
    instances so the caller can fall back to a plain copy.
    """
    chains: list[str] = []
    cur = "0:v"

    # 1) transforms act on the real footage, in start-time order.
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

    # 2) overlays composite on top, each shifted to its start + gated to its window.
    overlays_by_id = {i.id: i for i in doc.overlays()}
    for inst_id, in_idx in overlay_inputs:
        ov = overlays_by_id.get(inst_id)
        if ov is None:
            continue
        shifted = f"ov{in_idx}"
        # Shift overlay PTS so its frame 0 plays at startSec; eof_action=pass
        # lets the base continue unchanged after the overlay ends.
        chains.append(f"[{in_idx}:v]setpts=PTS-STARTPTS+{ov.startSec}/TB[{shifted}]")
        out = f"c{in_idx}"
        chains.append(
            f"[{cur}][{shifted}]overlay=x=0:y=0:eof_action=pass:"
            f"enable='between(t,{ov.startSec},{ov.endSec})'[{out}]"
        )
        cur = out

    if not chains:
        return "", "0:v"
    return ";".join(chains), cur


def render_effects(
    base_path: str | Path,
    out_path: str | Path,
    doc: EffectsDoc,
    overlay_paths: dict[str, str | Path],
    *,
    width: int | None = None,
    height: int | None = None,
    fps: float | None = None,
    clips_dir: str | Path | None = None,
    clip_durations_sec: list[float] | None = None,
) -> None:
    """Render ``base_path`` with all effects in ``doc`` baked in, to ``out_path``.

    ``overlay_paths`` maps overlay instance id → its pre-rendered transparent
    clip path. Instances in ``doc.overlays()`` without an entry are skipped
    (nothing to composite). Base dims/fps default to the base video's own.

    ``clips_dir``/``clip_durations_sec`` (both optional): when supplied and
    ``doc`` has ``punch-zoom`` instances, those are pre-baked per-clip and the
    clips re-concatenated into a new base BEFORE the rest of this function
    runs (see module docstring + ``_bake_zoom_punches_per_clip``). Instances
    that fail to map onto a clip (or either param is omitted) fall back to
    the normal post-concat filtergraph pass unchanged — this is a pure
    quality improvement, never a hard requirement.
    """
    base_path = Path(base_path)
    zoom_instances = [
        i for i in doc.transforms() if i.componentId == "punch-zoom"
    ]
    if zoom_instances and clips_dir and clip_durations_sec:
        try:
            zoomed_base, baked_ids = _bake_zoom_punches_per_clip(
                Path(clips_dir), clip_durations_sec, zoom_instances,
                work_dir=base_path.parent,
            )
        except Exception:
            log.exception("effects_zoom_preclip_bake_failed")
            baked_ids = set()
        else:
            if baked_ids:
                base_path = zoomed_base
                doc = doc.model_copy(update={
                    "instances": [i for i in doc.instances if i.id not in baked_ids]
                })

    info = video_stream_info(base_path)
    w = width or info["width"]
    h = height or info["height"]
    r = fps or float(info["fps"])

    # Overlay inputs in doc order, only those we actually have a clip for.
    overlay_inputs: list[tuple[str, int]] = []
    input_args: list[str] = ["-i", str(base_path)]
    next_idx = 1
    for inst in doc.overlays():
        clip = overlay_paths.get(inst.id)
        if not clip or not Path(clip).is_file():
            log.warning("effects_overlay_clip_missing", instanceId=inst.id)
            continue
        input_args += ["-i", str(clip)]
        overlay_inputs.append((inst.id, next_idx))
        next_idx += 1

    filtergraph, final_label = build_effects_filtergraph(
        doc, overlay_inputs, width=w, height=h, fps=r
    )

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
        overlays=len(overlay_inputs),
        transforms=len(doc.transforms()),
        has_filtergraph=bool(filtergraph),
    )
    result = subprocess.run(args, capture_output=True, timeout=1800)
    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", errors="replace").strip()
        tail = stderr[-2000:]
        last = next((ln.strip() for ln in reversed(tail.splitlines()) if ln.strip()), "unknown")
        log.error("effects_render_failed", stderr=tail)
        raise RuntimeError(f"ffmpeg (effects_render): {last}")
    log.info("effects_render_done", out=str(out_path))
