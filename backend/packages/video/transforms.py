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

    win = max(0.0001, end_sec - start_sec)
    ramp = min(ramp, win / 2)  # ramp can't exceed half the window (in + out)

    # z(ot): 1.0 outside [start,end]; ramp up over the first `ramp`s; hold; and
    # (unless hold) ramp back down over the last `ramp`s. Built as an ffmpeg expr
    # over the zoompan output timestamp `ot`.
    up = f"({zoom_from}+({zoom_to}-{zoom_from})*min(1,(ot-{start_sec})/{ramp}))"
    if hold:
        inside = up
    else:
        down = f"({zoom_to}-({zoom_to}-{zoom_from})*min(1,(ot-({end_sec}-{ramp}))/{ramp}))"
        inside = f"if(gt(ot,{end_sec}-{ramp}),{down},{up})"
    z = f"if(between(ot,{start_sec},{end_sec}),{inside},1)"

    # Keep the focus point fixed on screen: offset by (full - full/zoom)*focus.
    x = f"(iw-iw/zoom)*{focus_x}"
    y = f"(ih-ih/zoom)*{focus_y}"
    return (
        f"zoompan=z='{z}':x='{x}':y='{y}':d=1:fps={fps:g}:s={width}x{height}"
    )


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
        },
    },
}


def transform_entry(component_id: str) -> dict[str, Any] | None:
    return TRANSFORM_REGISTRY.get(component_id)
