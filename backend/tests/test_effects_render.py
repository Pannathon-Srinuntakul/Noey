"""Tests for the effects render engine's filtergraph builder + the per-clip
punch-zoom pre-concat bake (real ffmpeg over lavfi-generated clips, mirrors
test_dub_render.py's convention).
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from packages.video.effects import EffectInstance, EffectsDoc
from packages.video.effects_render import (
    _bake_zoom_punches_per_clip,
    _clip_index_for,
    build_effects_filtergraph,
    render_effects,
)
from packages.video.ffmpeg_bin import ffmpeg_cmd, media_duration


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
    assert "[0:v]scale=w=iw*4:h=ih*4,zoompan" in graph
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
    assert "[0:v]scale=w=iw*4:h=ih*4,zoompan" in graph
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


# ── _bake_zoom_punches_per_clip / render_effects: real ffmpeg over lavfi clips

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


def test_bake_zoom_punches_bakes_only_containing_clip(clips_dir: Path, tmp_path: Path) -> None:
    inst = _zoom("z1", start=3.0, dur=1.0)  # falls inside clip 2 ([2,5))
    zoomed_base, baked_ids = _bake_zoom_punches_per_clip(
        clips_dir, CLIP_DURATIONS, [inst], work_dir=tmp_path,
    )
    assert baked_ids == {"z1"}
    tmp_dir = tmp_path / "_effects_zoom_tmp"
    assert (tmp_dir / "clip_002.mp4").is_file()
    assert not (tmp_dir / "clip_001.mp4").exists()
    assert not (tmp_dir / "clip_003.mp4").exists()
    assert abs(media_duration(zoomed_base) - sum(CLIP_DURATIONS)) < 0.35


def test_bake_zoom_punches_clamps_straddling_instance(clips_dir: Path, tmp_path: Path) -> None:
    # startSec lands in clip 1 ([0,2)) but endSec (4.5) would spill into clip 2.
    inst = _zoom("z1", start=1.0, dur=3.5)
    _zoomed_base, baked_ids = _bake_zoom_punches_per_clip(
        clips_dir, CLIP_DURATIONS, [inst], work_dir=tmp_path,
    )
    # Clamped to clip 1's own [0,2) span: local window [1.0, 2.0) — still >=
    # the degenerate-duration floor, so it's baked (onto clip 1 only).
    assert baked_ids == {"z1"}
    tmp_dir = tmp_path / "_effects_zoom_tmp"
    assert (tmp_dir / "clip_001.mp4").is_file()
    assert not (tmp_dir / "clip_002.mp4").exists()


def test_bake_zoom_punches_multiple_on_same_clip(clips_dir: Path, tmp_path: Path) -> None:
    insts = [_zoom("z1", start=2.5, dur=0.4), _zoom("z2", start=3.8, dur=0.4)]  # both in clip 2
    _zoomed_base, baked_ids = _bake_zoom_punches_per_clip(
        clips_dir, CLIP_DURATIONS, insts, work_dir=tmp_path,
    )
    assert baked_ids == {"z1", "z2"}
    tmp_dir = tmp_path / "_effects_zoom_tmp"
    assert (tmp_dir / "clip_002.mp4").is_file()
    assert not (tmp_dir / "clip_001.mp4").exists()
    assert not (tmp_dir / "clip_003.mp4").exists()


def test_bake_zoom_punches_never_mutates_source_clips(clips_dir: Path, tmp_path: Path) -> None:
    before = (clips_dir / "clip_002.mp4").read_bytes()
    _bake_zoom_punches_per_clip(
        clips_dir, CLIP_DURATIONS, [_zoom("z1", start=3.0, dur=1.0)], work_dir=tmp_path,
    )
    # Re-run with a DIFFERENT prop value — must re-bake from the untouched
    # original, never chain onto the previous bake's temp output.
    _bake_zoom_punches_per_clip(
        clips_dir, CLIP_DURATIONS,
        [_zoom("z1", start=3.0, dur=1.0).model_copy(update={"props": {"zoomTo": 3.5, "focusX": 0.5, "focusY": 0.5, "hold": "true", "cut": "true"}})],
        work_dir=tmp_path,
    )
    after = (clips_dir / "clip_002.mp4").read_bytes()
    assert before == after


def test_render_effects_bakes_zoom_per_clip_then_composites(clips_dir: Path, tmp_path: Path) -> None:
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
    render_effects(
        final_silent, out, doc, {},
        clips_dir=clips_dir, clip_durations_sec=CLIP_DURATIONS,
    )
    assert out.is_file()
    assert abs(media_duration(out) - sum(CLIP_DURATIONS)) < 0.5


def test_render_effects_without_clips_dir_falls_back_to_post_concat(tmp_path: Path) -> None:
    final_silent = tmp_path / "final_silent.mp4"
    _make_clip(final_silent, duration=4.0, color="red")
    doc = EffectsDoc(instances=[_zoom("z1", start=1.0, dur=1.0)])
    out = tmp_path / "final_fx.mp4"
    # No clips_dir/clip_durations_sec — regression guard: today's post-concat
    # behavior must still work unchanged.
    render_effects(final_silent, out, doc, {})
    assert out.is_file()
    assert abs(media_duration(out) - 4.0) < 0.35


def test_render_effects_transitions_unaffected_by_zoom_bake(clips_dir: Path, tmp_path: Path) -> None:
    from packages.video.dub_render import concat_stream_copy

    final_silent = tmp_path / "final_silent.mp4"
    concat_stream_copy(
        [clips_dir / "clip_001.mp4", clips_dir / "clip_002.mp4", clips_dir / "clip_003.mp4"],
        final_silent, tmp_path / "concat.txt",
    )
    # A scene-drift (whole-scene span) alongside a punch-zoom — the zoom gets
    # pre-baked per-clip, the drift must still apply on the post-concat pass
    # against the (re-concatenated) base, since it spans clip 3's whole span.
    drift = EffectInstance(
        id="d1", kind="transform", componentId="scene-drift", startSec=5.0, durationSec=2.0,
        props={"zoomFrom": 1.0, "zoomTo": 1.15},
    )
    doc = EffectsDoc(instances=[_zoom("z1", start=3.0, dur=1.0), drift])
    out = tmp_path / "final_fx.mp4"
    render_effects(final_silent, out, doc, {}, clips_dir=clips_dir, clip_durations_sec=CLIP_DURATIONS)
    assert out.is_file()
