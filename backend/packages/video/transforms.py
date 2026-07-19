"""Effect transforms — the ffmpeg-only (kind="transform") half of the registry.

Unlike overlay effects (Remotion → transparent clip → composite), a transform
acts on the REAL footage pixels: there is no component to composite, just an
ffmpeg filter applied to the base video over a time window. Punch-zoom, pan,
crop-reframe live here. The overlay half lives in the desktop node-sidecar
(compositions/registry.ts).

Each builder returns an ffmpeg filter-chain string (a filtergraph fragment) that
the render engine splices into its graph for the instance's [start, end] window.
`TRANSFORM_REGISTRY` also declares each transform's prop surface so the AI
placement pass and the manual editor know the valid params (mirrors the overlay
registry's propSchema).
"""

from __future__ import annotations

from typing import Any

# ── prop schema (mirrors node-sidecar registry.ts PropSpec) ─────────────────
PropSpec = dict[str, Any]


def _num(label: str, lo: float, hi: float) -> PropSpec:
    return {"type": "number", "min": lo, "max": hi, "label": label}


def _clampf(value: Any, lo: float, hi: float, default: float) -> float:
    try:
        return max(lo, min(hi, float(value)))
    except (TypeError, ValueError):
        return default


def _as_bool(value: Any, default: bool) -> bool:
    """Coerce a prop to bool. AI/editor emit enum booleans as the STRINGS
    'true'/'false' (JSON schema enums must be strings), and ``bool('false')`` is
    True — so parse the string form explicitly instead of truthiness."""
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() not in ("false", "0", "no", "")


# zoompan crops against the INPUT frame's native pixel grid (`iw`/`ih` in its
# own expressions), rounding the crop box to whole pixels every output frame.
# For a SLOW, continuous zoom (scene-drift's whole-scene ambient push, or any
# multi-second push) the per-frame zoom delta is tiny, so that rounding shows
# up as visible micro-jitter/shake — a well-documented zoompan artifact
# (2026-07-18, confirmed live: "มัน zoom ได้ห่วยมาก มันสั่นๆไปหมด"). Fix:
# pre-upscale the frame before zoompan so its crop math has more pixels of
# headroom to round against; zoompan's own `s=` then downsamples to the real
# target size same as before — the z/x/y formulas are resolution-independent
# (all fractions of `iw`/`ih`) so they need no change, only this prefix.
#
# Do NOT append `tmix=...:enable=between(t,...)` after zoompan. Confirmed
# 2026-07-18: ffmpeg's `tmix` with an `enable` expression corrupts chroma on
# yuv420p into solid neon green (pixel samples go ~magenta → (0,88,0)); without
# `enable` the blend is color-safe but softens the *entire* clip, so it cannot
# gate to the transform window. Punch-zoom / whip-pan are short enough that the
# 4x prescale alone is enough; scene-drift may still show mild residual step at
# very slow zooms — better mild jitter than a green frame.
_ZOOM_PRECISION = 4


def _in_window(ot_expr: str, start_sec: float, end_sec: float) -> str:
    """Half-open time gate ``[start, end)`` for zoompan ``z``/``x``/``y`` exprs.

    ffmpeg's ``between(ot,start,end)`` is inclusive on BOTH ends, so a punch-zoom
    that ends exactly on a scene cut (the common AI pattern: hold until the next
    cut) still paints zoom onto the FIRST frame of the next scene — a visible
    flash of the new shot still zoomed before it snaps to 1.0 (confirmed
    2026-07-18: patterned red→blue splice, inclusive keeps zoom at t=cut,
    exclusive clears it). Half-open aligns the zoom-off with the cut frame.
    """
    return f"gte({ot_expr},{start_sec})*lt({ot_expr},{end_sec})"


def _zoompan(
    z: str, x: str, y: str, *, width: int, height: int, fps: float,
) -> str:
    return (
        f"scale=w=iw*{_ZOOM_PRECISION}:h=ih*{_ZOOM_PRECISION},"
        f"zoompan=z='{z}':x='{x}':y='{y}':d=1:fps={fps:g}:s={width}x{height}"
    )


def punch_zoom_filter(
    props: dict[str, Any],
    *,
    width: int,
    height: int,
    start_sec: float,
    end_sec: float,
    fps: float = 30.0,
) -> str:
    """Build a punch-zoom filtergraph for one [start,end] window.

    Zooms from ``zoomFrom`` to ``zoomTo`` over ``rampSec`` at the window start,
    holds until the window end, then (if ``hold`` is false) eases back to 1.0
    over ``rampSec`` before the end. Outside the window the frame is untouched
    (zoom == 1.0). Focus point ``focusX/focusY`` (0..1) is kept fixed on screen
    as the zoom pushes in, so it drives toward a product/face, not the center.

    Optional ``driftX``/``driftY`` (2026-07-18): when the hold spans long
    enough to notice, a dead-static hold can read as flat — real reference
    footage sometimes keeps the camera drifting slowly (a slow pan) WHILE
    holding the zoomed framing, not just push-then-freeze. When either is
    given (and ``hold`` is true), the focus point eases from ``focusX/focusY``
    toward ``driftX/driftY`` over the hold portion only (after the zoom-in
    ramp completes) — the zoom level itself stays put, only the framing pans.
    Omitting them (the common case) keeps the previous fully-static hold.

    Implementation: ``zoompan``. ``crop``'s width/height are evaluated only once
    at init (only x/y re-evaluate per frame), so it cannot animate a zoom;
    ``zoompan`` re-evaluates ``z``/``x``/``y`` every output frame and exposes the
    output timestamp as ``ot``, which the ramp expression is written against.
    ``d=1`` keeps a 1:1 input→output frame mapping; ``fps`` must match the base
    clip so ``ot`` tracks real time; ``s`` pins the output to the clip's WxH.
    """
    zoom_from = _clampf(props.get("zoomFrom"), 1.0, 4.0, 1.0)
    zoom_to = _clampf(props.get("zoomTo"), 1.0, 4.0, 1.3)
    focus_x = _clampf(props.get("focusX"), 0.0, 1.0, 0.5)
    focus_y = _clampf(props.get("focusY"), 0.0, 1.0, 0.5)
    ramp = _clampf(props.get("rampSec"), 0.05, 5.0, 0.5)
    hold = _as_bool(props.get("hold"), True)
    # A genuine hard cut to a different crop (2026-07-19) — reference footage
    # that alternates framing via straight edits, not an animated push, has
    # NO ramp at all, not even the previous 0.05s floor (a few real frames of
    # interpolation, however brief, still isn't a cut). zoomFrom/driftX/Y are
    # meaningless here since nothing eases.
    is_cut = _as_bool(props.get("cut"), False)
    drift_x = _clampf(props.get("driftX"), 0.0, 1.0, focus_x) if props.get("driftX") is not None else focus_x
    drift_y = _clampf(props.get("driftY"), 0.0, 1.0, focus_y) if props.get("driftY") is not None else focus_y

    win = max(0.0001, end_sec - start_sec)
    ramp = min(ramp, win / 2)  # ramp can't exceed half the window (in + out)

    # z(ot): 1.0 outside [start,end); ramp up over the first `ramp`s; hold; and
    # (unless hold) ramp back down over the last `ramp`s. Built as an ffmpeg expr
    # over the zoompan output timestamp `ot`. Half-open end so a hold that lands
    # on a scene cut does not bleed one zoomed frame into the next shot.
    if is_cut:
        # Entry is always instant (that's the point of "cut"). Exit depends
        # on `hold`: true = also instant (correct when the window's own end
        # IS a real scene cut — matches the actual edit). false = ease back
        # to normal over `ramp` before the window ends — for when the model
        # deliberately releases the zoom mid-scene (2026-07-19): an instant
        # snap-back with no real cut underneath reads as a fake, unmotivated
        # cut in continuous footage, so THAT release needs to be smooth even
        # though the entry stayed a hard cut.
        if hold:
            inside = f"{zoom_to}"
        else:
            # `ramp` here is the "cut" entry ramp (clamped tiny, 0.05-0.15s
            # upstream) — too short to read as a deliberate ease-out. The
            # exit needs its own, longer minimum to actually look smooth.
            exit_ramp = min(max(ramp, 0.25), win / 2)
            down = f"({zoom_to}-({zoom_to}-1.0)*min(1,(ot-({end_sec}-{exit_ramp}))/{exit_ramp}))"
            inside = f"if(gt(ot,{end_sec}-{exit_ramp}),{down},{zoom_to})"
    else:
        up = f"({zoom_from}+({zoom_to}-{zoom_from})*min(1,(ot-{start_sec})/{ramp}))"
        if hold:
            inside = up
        else:
            down = f"({zoom_to}-({zoom_to}-{zoom_from})*min(1,(ot-({end_sec}-{ramp}))/{ramp}))"
            inside = f"if(gt(ot,{end_sec}-{ramp}),{down},{up})"
    z = f"if({_in_window('ot', start_sec, end_sec)},{inside},1)"

    # Focus point: fixed at focusX/focusY unless a hold-drift target was given
    # (only meaningful with hold=True — a returning zoom's brief hold has no
    # room for a pan anyway). Drift progresses only across the HOLD portion
    # (after the ramp-in completes), so the pan starts once the push settles.
    if not is_cut and hold and (drift_x != focus_x or drift_y != focus_y):
        ramp_end = f"({start_sec}+{ramp})"
        hold_span = f"max(0.0001,{end_sec}-{ramp_end})"
        prog = f"min(1,max(0,(ot-{ramp_end})/{hold_span}))"
        fx = f"({focus_x}+({drift_x}-{focus_x})*{prog})"
        fy = f"({focus_y}+({drift_y}-{focus_y})*{prog})"
    else:
        fx, fy = f"{focus_x}", f"{focus_y}"

    # Keep the focus point on screen: offset by (full - full/zoom)*focus.
    x = f"(iw-iw/zoom)*{fx}"
    y = f"(ih-ih/zoom)*{fy}"
    return _zoompan(z, x, y, width=width, height=height, fps=fps)


def whip_pan_filter(
    props: dict[str, Any],
    *,
    width: int,
    height: int,
    start_sec: float,
    end_sec: float,
    fps: float = 30.0,
) -> str:
    """Build a whip-pan SCENE-TRANSITION filtergraph straddling one cut instant.

    Unlike `punch_zoom_filter` (holds on a detail for a beat), this window is
    meant to be narrow (~0.2-0.4s) and CENTERED ON the actual cut point in the
    already-merged output timeline — half before the cut, half after — so the
    sweep and the cut land together, reading as one motion through the join
    rather than a hard splice. Reuses the same proven `zoompan` machinery as
    punch-zoom (no new filter dependency): the frame sweeps hard toward
    `direction` while zooming out-then-in, peaking exactly at the window's
    midpoint, then resolves back to the normal 1.0 framing. `ot` (zoompan's
    own output timestamp) drives the expression, same reasoning as
    `punch_zoom_filter`.
    """
    direction = str(props.get("direction", "horizontal")).lower()
    intensity = _clampf(props.get("intensity"), 0.2, 1.0, 0.6)

    win = max(0.0001, end_sec - start_sec)
    mid = start_sec + win / 2
    half = max(0.0001, win / 2)
    zoom_peak = 1.0 + 0.5 * intensity  # 1.1 .. 1.5

    # Triangular envelope: 0 at the window edges, 1 at the cut instant, 0 outside.
    # Whip-pan intentionally STRADDLES the cut, so keep an inclusive gate here —
    # half-open would drop the post-cut half of the sweep one frame early.
    tri = f"max(0,1-abs(ot-{mid})/{half})"
    z = f"if(between(ot,{start_sec},{end_sec}),1+({zoom_peak}-1)*({tri}),1)"

    # Directional sweep: focus point slides hard from one edge toward the
    # other across the window, biased by `direction`, so the zoom reads as a
    # pan rather than a plain push.
    sweep = f"(0.5+0.5*sign({mid}-ot)*({tri}))"
    if direction == "vertical":
        x = "(iw-iw/zoom)/2"
        y = f"(ih-ih/zoom)*{sweep}"
    else:
        x = f"(iw-iw/zoom)*{sweep}"
        y = "(ih-ih/zoom)/2"

    return _zoompan(z, x, y, width=width, height=height, fps=fps)


def scene_drift_filter(
    props: dict[str, Any],
    *,
    width: int,
    height: int,
    start_sec: float,
    end_sec: float,
    fps: float = 30.0,
) -> str:
    """Continuous, gentle camera drift across an ENTIRE scene span (2026-07-18).

    Unlike `punch_zoom_filter` (push/cut INTO a specific detail, THEN a static
    hold), this is a single smooth ease across the WHOLE [start,end] window
    with no plateau and no target detail — ambient handheld-style motion for
    a scene that isn't highlighting anything specific, just keeps drifting
    slowly for the shot's whole length. The caller sizes the window to one
    scene span (from one real cut to the next, via <cuts>), so the drift
    resets at each scene change rather than compounding across the clip.

    Deliberately mild range (zoomFrom/zoomTo default 1.0->1.15, vs
    punch-zoom's up to 4.0) — this is meant to be barely-there ambient
    motion, not a highlight push.
    """
    zoom_from = _clampf(props.get("zoomFrom"), 1.0, 1.6, 1.0)
    zoom_to = _clampf(props.get("zoomTo"), 1.0, 1.6, 1.15)
    fx0 = _clampf(props.get("focusFromX"), 0.0, 1.0, 0.5)
    fy0 = _clampf(props.get("focusFromY"), 0.0, 1.0, 0.5)
    fx1 = _clampf(props.get("focusToX"), 0.0, 1.0, fx0)
    fy1 = _clampf(props.get("focusToY"), 0.0, 1.0, fy0)

    win = max(0.0001, end_sec - start_sec)
    prog = f"min(1,max(0,(ot-{start_sec})/{win}))"
    z_inside = f"({zoom_from}+({zoom_to}-{zoom_from})*{prog})"
    # Same half-open gate as punch-zoom: scene-drift windows end on a cut.
    z = f"if({_in_window('ot', start_sec, end_sec)},{z_inside},1)"
    fx = f"({fx0}+({fx1}-{fx0})*{prog})"
    fy = f"({fy0}+({fy1}-{fy0})*{prog})"
    x = f"(iw-iw/zoom)*{fx}"
    y = f"(ih-ih/zoom)*{fy}"
    return _zoompan(z, x, y, width=width, height=height, fps=fps)


TRANSFORM_REGISTRY: dict[str, dict[str, Any]] = {
    "punch-zoom": {
        "title": "ซูมกระแทก",
        "builder": punch_zoom_filter,
        "propSchema": {
            "zoomFrom": _num("ซูมเริ่ม", 1.0, 4.0),
            "zoomTo": _num("ซูมสุด", 1.0, 4.0),
            "focusX": _num("จุดโฟกัส X", 0.0, 1.0),
            "focusY": _num("จุดโฟกัส Y", 0.0, 1.0),
            "rampSec": _num("เวลาซูม (วิ)", 0.05, 5.0),
            "hold": {"type": "enum", "options": ["true", "false"], "label": "ค้างซูม"},
            "cut": {"type": "enum", "options": ["true", "false"], "label": "ตัดทันที (ไม่มี ramp)"},
            "driftX": _num("แพนกล้องระหว่างค้าง X (ไม่บังคับ)", 0.0, 1.0),
            "driftY": _num("แพนกล้องระหว่างค้าง Y (ไม่บังคับ)", 0.0, 1.0),
        },
    },
    "whip-pan": {
        "title": "แพนปัดฉาก (ทรานซิชัน)",
        "builder": whip_pan_filter,
        "propSchema": {
            "direction": {"type": "enum", "options": ["horizontal", "vertical"], "label": "ทิศทาง"},
            "intensity": _num("ความแรง", 0.2, 1.0),
        },
    },
    "scene-drift": {
        "title": "กล้องขยับเบาๆ ทั้งฉาก",
        "builder": scene_drift_filter,
        "propSchema": {
            "zoomFrom": _num("ซูมเริ่ม", 1.0, 1.6),
            "zoomTo": _num("ซูมปลาย", 1.0, 1.6),
            "focusFromX": _num("จุดเริ่ม X", 0.0, 1.0),
            "focusFromY": _num("จุดเริ่ม Y", 0.0, 1.0),
            "focusToX": _num("จุดปลาย X", 0.0, 1.0),
            "focusToY": _num("จุดปลาย Y", 0.0, 1.0),
        },
    },
}


def transform_entry(component_id: str) -> dict[str, Any] | None:
    return TRANSFORM_REGISTRY.get(component_id)
