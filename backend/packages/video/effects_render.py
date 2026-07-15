"""Effects-layer render engine — compose an `effects.json` onto a cut video.

Consumes the normalized EffectsDoc (packages/video/effects.py) plus the already-
rendered overlay clips (produced upstream by the Remotion node-sidecar, one
transparent .mov per overlay instance) and bakes everything onto the base cut
video in a SINGLE ffmpeg pass:

  base ─▶ [transforms: punch-zoom/… applied to real footage] ─▶ [overlays
          composited on top, each gated to its time window] ─▶ final.mp4

One pass (one filter_complex) rather than a re-encode per effect: chaining
composite_overlay/apply_zoom sequentially would decode+encode the whole video
once per instance, multiplying render time and stacking generation loss. The
graph here transforms then overlays in a single decode/encode.

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
) -> None:
    """Render ``base_path`` with all effects in ``doc`` baked in, to ``out_path``.

    ``overlay_paths`` maps overlay instance id → its pre-rendered transparent
    clip path. Instances in ``doc.overlays()`` without an entry are skipped
    (nothing to composite). Base dims/fps default to the base video's own.
    """
    base_path = Path(base_path)
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
