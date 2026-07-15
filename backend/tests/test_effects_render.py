"""Tests for the effects render engine's filtergraph builder.

The ffmpeg execution path (render_effects) is exercised by the desktop
sidecar/integration runs; here we lock the filter_complex string logic, which
is where placement/timing bugs would hide.
"""

from __future__ import annotations

from packages.video.effects import EffectInstance, EffectsDoc
from packages.video.effects_render import build_effects_filtergraph


def _doc(*insts: EffectInstance) -> EffectsDoc:
    return EffectsDoc(instances=list(insts))


def test_empty_doc_yields_passthrough() -> None:
    graph, label = build_effects_filtergraph(_doc(), [], width=1080, height=1920, fps=30)
    assert graph == ""
    assert label == "0:v"


def test_transform_only_chain() -> None:
    doc = _doc(
        EffectInstance(id="z", kind="transform", componentId="punch-zoom", startSec=0.5, durationSec=2.0)
    )
    graph, label = build_effects_filtergraph(doc, [], width=1080, height=1920, fps=30)
    assert "[0:v]zoompan" in graph
    assert label == "t0"  # single transform → final label t0


def test_unknown_transform_skipped() -> None:
    doc = _doc(
        EffectInstance(id="x", kind="transform", componentId="nope", startSec=0, durationSec=1)
    )
    graph, label = build_effects_filtergraph(doc, [], width=100, height=100, fps=30)
    assert graph == ""
    assert label == "0:v"


def test_overlay_is_shifted_and_gated() -> None:
    doc = _doc(
        EffectInstance(id="ov", kind="overlay", componentId="sticker-badge", startSec=1.0, durationSec=2.5)
    )
    graph, label = build_effects_filtergraph(doc, [("ov", 1)], width=1080, height=1920, fps=30)
    # frame 0 of the overlay input is delayed to its startSec
    assert "[1:v]setpts=PTS-STARTPTS+1.0/TB[ov1]" in graph
    # composited only within its window
    assert "enable='between(t,1.0,3.5)'" in graph
    assert label == "c1"


def test_transform_then_overlay_order() -> None:
    doc = _doc(
        EffectInstance(id="z", kind="transform", componentId="punch-zoom", startSec=0.0, durationSec=2.0),
        EffectInstance(id="ov", kind="overlay", componentId="text-reveal", startSec=0.2, durationSec=3.0),
    )
    graph, label = build_effects_filtergraph(doc, [("ov", 1)], width=1080, height=1920, fps=30)
    # transform consumes 0:v → t0; overlay composites onto t0 → c1
    assert "[0:v]zoompan" in graph
    assert "[t0][ov1]overlay" in graph
    assert label == "c1"


def test_overlay_without_input_mapping_is_ignored() -> None:
    # overlay in the doc but no (id, index) provided → not composited
    doc = _doc(
        EffectInstance(id="ov", kind="overlay", componentId="sticker-badge", startSec=1.0, durationSec=1.0)
    )
    graph, label = build_effects_filtergraph(doc, [], width=100, height=100, fps=30)
    assert graph == ""
    assert label == "0:v"
