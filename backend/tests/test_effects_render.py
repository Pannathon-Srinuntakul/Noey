"""Tests for the effects render engine's transform filtergraph builder + the per-clip
punch-zoom pre-concat bake (real ffmpeg over lavfi-generated clips, mirrors
test_dub_render.py's convention).
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from packages.video.effects import EffectInstance, EffectsDoc
from packages.video.effects_render import (
    _clamp_transforms_to_cuts,
    _clip_index_for,
    build_effects_filtergraph,
    render_effects,
)
from packages.video.ffmpeg_bin import ffmpeg_cmd, media_duration


def _doc(*insts: EffectInstance) -> EffectsDoc:
    return EffectsDoc(instances=list(insts))


def test_empty_doc_yields_passthrough() -> None:
    graph, label = build_effects_filtergraph(_doc(), width=1080, height=1920, fps=30)
    assert graph == ""
    assert label == "0:v"


def test_transform_only_chain() -> None:
    doc = _doc(
        EffectInstance(id="z", kind="transform", componentId="punch-zoom", startSec=0.5, durationSec=2.0)
    )
    graph, label = build_effects_filtergraph(doc, width=1080, height=1920, fps=30)
    assert "[0:v]scale=w=iw*4:h=ih*4,zoompan" in graph
    assert label == "t0"  # single transform → final label t0


def test_unknown_transform_skipped() -> None:
    doc = _doc(
        EffectInstance(id="x", kind="transform", componentId="nope", startSec=0, durationSec=1)
    )
    graph, label = build_effects_filtergraph(doc, width=100, height=100, fps=30)
    assert graph == ""
    assert label == "0:v"


# ── _clip_index_for: pure cumsum/bisect, no ffmpeg needed ───────────────────

def test_clip_index_for_exact_boundary_hits() -> None:
    boundaries = [0.0, 3.0, 7.0, 10.0]  # 3 clips: [0,3) [3,7) [7,10)
    assert _clip_index_for(0.0, boundaries) == (1, 0.0, 3.0)
    assert _clip_index_for(2.9, boundaries) == (1, 0.0, 3.0)
    assert _clip_index_for(3.0, boundaries) == (2, 3.0, 7.0)  # half-open: boundary goes to NEXT clip
    assert _clip_index_for(6.99, boundaries) == (2, 3.0, 7.0)
    assert _clip_index_for(7.0, boundaries) == (3, 7.0, 10.0)


def test_clip_index_for_clamps_out_of_range() -> None:
    boundaries = [0.0, 3.0, 7.0, 10.0]
    assert _clip_index_for(-1.0, boundaries) == (1, 0.0, 3.0)  # before first clip
    assert _clip_index_for(10.0, boundaries) == (3, 7.0, 10.0)  # exactly at video end
    assert _clip_index_for(999.0, boundaries) == (3, 7.0, 10.0)  # past last clip (stale data)


# ── clamp-to-cut / render_effects: real ffmpeg over lavfi clips

def _make_clip(path: Path, *, duration: float, color: str) -> Path:
    subprocess.run(
        [
            ffmpeg_cmd(), "-y",
            "-f", "lavfi", "-i", f"color=c={color}:size=320x240:rate=30:duration={duration}",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-an", str(path),
        ],
        check=True, capture_output=True,
    )
    return path


@pytest.fixture()
def clips_dir(tmp_path: Path) -> Path:
    clips = tmp_path / "clips"
    clips.mkdir()
    _make_clip(clips / "clip_001.mp4", duration=2.0, color="red")
    _make_clip(clips / "clip_002.mp4", duration=3.0, color="green")
    _make_clip(clips / "clip_003.mp4", duration=2.0, color="blue")
    return clips


CLIP_DURATIONS = [2.0, 3.0, 2.0]  # boundaries: [0,2) [2,5) [5,7)


def _zoom(id_: str, start: float, dur: float) -> EffectInstance:
    return EffectInstance(
        id=id_, kind="transform", componentId="punch-zoom",
        startSec=start, durationSec=dur,
        props={"zoomTo": 2.0, "focusX": 0.5, "focusY": 0.5, "hold": "true", "cut": "true"},
    )


def test_clamp_keeps_a_zoom_inside_its_own_cut() -> None:
    # startSec lands in clip 1 ([0,2)) but the window would spill into clip 2.
    inst = _zoom("z1", start=1.0, dur=3.5)
    out = _clamp_transforms_to_cuts(EffectsDoc(instances=[inst]), CLIP_DURATIONS)
    assert len(out.instances) == 1
    assert abs(out.instances[0].endSec - 2.0) < 1e-6


def test_clamp_leaves_a_contained_zoom_untouched() -> None:
    inst = _zoom("z1", start=2.5, dur=1.0)  # entirely inside clip 2 ([2,5))
    out = _clamp_transforms_to_cuts(EffectsDoc(instances=[inst]), CLIP_DURATIONS)
    assert out.instances[0].durationSec == inst.durationSec


def test_clamp_does_not_erase_a_zoom_that_would_become_degenerate() -> None:
    # Starts a hair before the boundary: clamping would leave ~0.01s, which is
    # worse than a small overshoot, so the instance is passed through as-is.
    inst = _zoom("z1", start=1.99, dur=1.0)
    out = _clamp_transforms_to_cuts(EffectsDoc(instances=[inst]), CLIP_DURATIONS)
    assert out.instances[0].durationSec == inst.durationSec


def test_clamp_is_a_no_op_without_durations() -> None:
    inst = _zoom("z1", start=1.0, dur=3.5)
    out = _clamp_transforms_to_cuts(EffectsDoc(instances=[inst]), [])
    assert out.instances[0].durationSec == inst.durationSec


def test_render_effects_clamps_zoom_to_its_cut(clips_dir: Path, tmp_path: Path) -> None:
    final_silent = tmp_path / "final_silent.mp4"
    # Reuse the clips to build the concatenated base the way the real cut
    # stage would (stream copy, no re-encode) — dub_render.concat_stream_copy.
    from packages.video.dub_render import concat_stream_copy

    concat_stream_copy(
        [clips_dir / "clip_001.mp4", clips_dir / "clip_002.mp4", clips_dir / "clip_003.mp4"],
        final_silent, tmp_path / "concat.txt",
    )
    doc = EffectsDoc(instances=[_zoom("z1", start=3.0, dur=1.0)])
    out = tmp_path / "final_fx.mp4"
    render_effects(final_silent, out, doc, clip_durations_sec=CLIP_DURATIONS)
    assert out.is_file()
    assert abs(media_duration(out) - sum(CLIP_DURATIONS)) < 0.5


def test_render_effects_without_clips_dir_falls_back_to_post_concat(tmp_path: Path) -> None:
    final_silent = tmp_path / "final_silent.mp4"
    _make_clip(final_silent, duration=4.0, color="red")
    doc = EffectsDoc(instances=[_zoom("z1", start=1.0, dur=1.0)])
    out = tmp_path / "final_fx.mp4"
    # No clip_durations_sec — windows applied exactly as authored.
    render_effects(final_silent, out, doc)
    assert out.is_file()
    assert abs(media_duration(out) - 4.0) < 0.35


def test_render_effects_transitions_unaffected_by_zoom_bake(clips_dir: Path, tmp_path: Path) -> None:
    from packages.video.dub_render import concat_stream_copy

    final_silent = tmp_path / "final_silent.mp4"
    concat_stream_copy(
        [clips_dir / "clip_001.mp4", clips_dir / "clip_002.mp4", clips_dir / "clip_003.mp4"],
        final_silent, tmp_path / "concat.txt",
    )
    # A scene-drift (whole-scene span) alongside a punch-zoom — both are applied
    # in the single post-concat pass; the drift must survive the zoom's clamp.
    drift = EffectInstance(
        id="d1", kind="transform", componentId="scene-drift", startSec=5.0, durationSec=2.0,
        props={"zoomFrom": 1.0, "zoomTo": 1.15},
    )
    doc = EffectsDoc(instances=[_zoom("z1", start=3.0, dur=1.0), drift])
    out = tmp_path / "final_fx.mp4"
    render_effects(final_silent, out, doc, clip_durations_sec=CLIP_DURATIONS)
    assert out.is_file()


# ── transitions straddle the cut (2026-09-07) ────────────────────────────────
#
# A whip-pan is placed at `cut - dur/2` and is meant to sweep across the join,
# half on each shot. The clamp treated it like any other transform and cut it
# off at the boundary, so the post-cut half never rendered and every whip-pan
# played as a jerk instead of a sweep — deterministically, on every one.


def _whip(id_: str, start: float, dur: float) -> EffectInstance:
    return EffectInstance(
        id=id_, kind="transform", componentId="whip-pan",
        startSec=start, durationSec=dur,
        props={"direction": "horizontal", "intensity": 0.6},
    )


def test_clamp_exempts_a_transition_that_straddles_the_cut() -> None:
    # Placed exactly the way the editor and the AI place it: centred on the
    # boundary at 2.0s, 0.3s long.
    inst = _whip("w1", start=1.85, dur=0.3)
    out = _clamp_transforms_to_cuts(EffectsDoc(instances=[inst]), CLIP_DURATIONS)
    assert out.instances[0].durationSec == 0.3
    assert abs(out.instances[0].endSec - 2.15) < 1e-6


def test_clamp_still_trims_a_zoom_placed_the_same_way() -> None:
    """The exemption is per-transform, not a blanket loosening of the rule."""
    inst = _zoom("z1", start=1.85, dur=0.3)
    out = _clamp_transforms_to_cuts(EffectsDoc(instances=[inst]), CLIP_DURATIONS)
    assert abs(out.instances[0].endSec - 2.0) < 1e-6


def test_straddles_cut_is_declared_on_the_registry_not_hardcoded() -> None:
    """A future transition inherits the exemption by declaring the same flag."""
    from packages.video.transforms import TRANSFORM_REGISTRY

    assert TRANSFORM_REGISTRY["whip-pan"].get("straddlesCut") is True
    assert not TRANSFORM_REGISTRY["punch-zoom"].get("straddlesCut")
    assert not TRANSFORM_REGISTRY["scene-drift"].get("straddlesCut")


def test_whip_pan_window_survives_into_the_filtergraph(tmp_path: Path) -> None:
    """End to end for the clamp exemption: build the real filter string.

    The clamp used to rewrite durationSec to stop at the cut, so `end_sec`
    reaching whip_pan_filter was the cut instant itself and the triangular
    envelope peaked and snapped back on that frame — the post-cut half of the
    sweep never rendered. This asserts the window that reaches ffmpeg still
    spans the join.
    """
    inst = _whip("w1", start=1.85, dur=0.3)
    doc = _clamp_transforms_to_cuts(EffectsDoc(instances=[inst]), CLIP_DURATIONS)
    graph, _ = build_effects_filtergraph(doc.instances and doc, width=1080, height=1920, fps=30)

    # The cut is at 2.0; both edges of the between() gate must straddle it.
    assert "between(ot,1.85,2.15)" in graph.replace(" ", "")
    # ...and the envelope peaks at the cut instant, not before it.
    assert "abs(ot-2.0)" in graph.replace(" ", "") or "abs(ot-2)" in graph.replace(" ", "")


def test_a_zoom_at_the_same_spot_is_still_cut_short_in_the_filtergraph() -> None:
    """The exemption must not leak to transforms that should be clamped."""
    inst = _zoom("z1", start=1.85, dur=0.3)
    doc = _clamp_transforms_to_cuts(EffectsDoc(instances=[inst]), CLIP_DURATIONS)
    graph, _ = build_effects_filtergraph(doc, width=1080, height=1920, fps=30)
    flat = graph.replace(" ", "")
    assert "2.15" not in flat
