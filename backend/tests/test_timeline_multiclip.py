"""Multi-clip timeline mapping tests."""

from packages.video.timeline import (
    _repair_segment_words,
    _snap_to_words,
    annotate_dub_script_output_times,
    anchor_dub_segments_to_frames,
    clamp_dub_segments_to_clip_durations,
    normalize_dub_edit_script,
    build_clip_boundaries,
    build_silence_gap_candidates,
    build_speech_cuts,
    enforce_unique_chronological_dub_cuts,
    filter_renderable_cuts,
    filter_short_cuts,
    localize_cuts,
    remove_overlapping_cuts,
    resnap_selected_cuts,
    split_global_cut,
    MAX_WORD_DUR,
    WORD_TAIL,
)


def test_build_silence_gap_candidates_between_cuts() -> None:
    speech_cuts = [
        {"type": "cut", "source": "clip0", "in": 0.0, "out": 5.0, "label": "opening"},
        {"type": "cut", "source": "clip0", "in": 8.5, "out": 12.0, "label": "speech"},
        {"type": "cut", "source": "clip0", "in": 12.1, "out": 15.0, "label": "conclusion"},
    ]
    gaps = build_silence_gap_candidates(speech_cuts)
    assert len(gaps) == 2
    assert gaps[0] == {"id": 0, "in": 5.0, "out": 8.5}
    assert gaps[1] == {"id": 1, "in": 12.0, "out": 12.1}


def test_build_silence_gap_candidates_no_gaps() -> None:
    assert build_silence_gap_candidates([]) == []
    assert build_silence_gap_candidates([{"in": 0.0, "out": 5.0}]) == []


def test_build_clip_boundaries_offsets() -> None:
    boundaries = build_clip_boundaries([10.0, 20.0, 5.0])
    assert boundaries[0]["id"] == "clip0"
    assert boundaries[0]["start"] == 0.0
    assert boundaries[0]["end"] == 10.0
    assert boundaries[1]["start"] == 10.0
    assert boundaries[1]["end"] == 30.0
    assert boundaries[2]["start"] == 30.0
    assert boundaries[2]["end"] == 35.0


def test_localize_cuts_splits_across_clips() -> None:
    boundaries = build_clip_boundaries([10.0, 10.0])
    global_cuts = [{"type": "cut", "source": "clip0", "in": 8.0, "out": 12.0, "label": "speech"}]
    localized = localize_cuts(global_cuts, boundaries)
    assert len(localized) == 2
    assert localized[0]["source"] == "clip0"
    assert localized[0]["in"] == 8.0
    assert localized[0]["out"] == 10.0
    assert localized[1]["source"] == "clip1"
    assert localized[1]["in"] == 0.0
    assert localized[1]["out"] == 2.0


def test_split_global_cut_wholly_inside_second_clip() -> None:
    boundaries = build_clip_boundaries([10.0, 10.0])
    parts = split_global_cut(15.0, 18.0, boundaries, label="hook")
    assert len(parts) == 1
    assert parts[0]["source"] == "clip1"
    assert parts[0]["in"] == 5.0
    assert parts[0]["out"] == 8.0
    assert parts[0]["label"] == "hook"


def test_filter_renderable_cuts_drops_subframe_segments() -> None:
    cuts = [
        {"type": "cut", "source": "clip0", "in": 1.0, "out": 2.0, "label": "speech"},
        {"type": "cut", "source": "clip4", "in": 600.326, "out": 600.374, "label": "speech"},
    ]
    kept = filter_renderable_cuts(cuts)
    assert len(kept) == 1
    assert kept[0]["in"] == 1.0


def test_filter_short_cuts_drops_under_one_second() -> None:
    cuts = [
        {"type": "cut", "source": "clip0", "in": 1.0, "out": 1.9, "label": "speech"},
        {"type": "cut", "source": "clip0", "in": 2.0, "out": 3.0, "label": "speech"},
        {"type": "cut", "source": "clip0", "in": 4.0, "out": 5.0, "label": "speech"},
    ]
    kept = filter_short_cuts(cuts)
    assert len(kept) == 2
    assert kept[0]["in"] == 2.0
    assert kept[1]["in"] == 4.0


def test_remove_overlapping_cuts_trims_later_cut() -> None:
    """Overlapping resnap must not drop the entire later cut (475c37ee regression)."""
    cuts = [
        {"type": "cut", "source": "clip0", "in": 81.24, "out": 150.47, "label": "opening"},
        {"type": "cut", "source": "clip0", "in": 131.59, "out": 287.15, "label": "speech"},
    ]
    kept = remove_overlapping_cuts(cuts)
    assert len(kept) == 2
    assert kept[0]["out"] == 150.47
    assert kept[1]["in"] >= 150.47
    assert kept[1]["out"] == 287.15


def test_snap_to_words_extends_past_last_word_end() -> None:
    words = [(1.0, 1.4), (1.5, 2.0), (2.1, 2.55)]
    cut_in, cut_out = _snap_to_words(1.0, 2.55, words, is_opening=False, is_conclusion=False)
    assert cut_in <= 1.0
    assert cut_out >= 2.55 + WORD_TAIL - 0.01


def test_repair_extends_last_word_to_segment_end() -> None:
    seg = {
        "start": 10.0,
        "end": 12.5,
        "text": "สวัสดีครับ",
        "words": [
            {"word": "สวัสดี", "start": 10.0, "end": 11.8},
            {"word": "ครับ", "start": 11.8, "end": 11.85},
        ],
    }
    repaired = _repair_segment_words(seg)
    assert repaired[-1][1] >= 12.5 - 0.01


def test_repair_clamps_absurd_word_span() -> None:
    seg = {
        "start": 5.16,
        "end": 9.58,
        "text": "1.5 goose",
        "words": [{"word": ".5", "start": 5.16, "end": 9.58}],
    }
    repaired = _repair_segment_words(seg)
    assert repaired[0][1] - repaired[0][0] <= MAX_WORD_DUR + 0.01


def test_build_speech_cuts_no_midword_split_thai() -> None:
    """Thai Whisper splits characters with large inter-char gaps — must NOT split mid-word."""
    # Mirrors the actual transcript.json bug: "ปันดับแรก" split because
    # " ป"(7.8-8.3) → "ั"(9.18) gap = 0.88s > old WORD_GAP_THRESHOLD (0.35s).
    segments = [
        {
            "start": 6.1,
            "end": 9.88,
            "text": "แต่งหน้ากันจากฟินแน่ ปันดับแรก",
            "words": [
                {"word": "แต", "start": 6.1, "end": 6.34},
                {"word": "่งหน้ากันจากฟินแน่", "start": 6.34, "end": 7.68},
                # Large gap here simulating Thai character-level timestamps:
                {"word": " ป", "start": 7.8, "end": 8.3},
                {"word": "ัน", "start": 9.18, "end": 9.44},   # 0.88s gap after " ป"
                {"word": "ดับแรก", "start": 9.44, "end": 9.88},
            ],
        },
        {
            "start": 9.88,
            "end": 10.92,
            "text": "โอ้ว มายกอด",
            "words": [
                {"word": "โอ้ว", "start": 9.88, "end": 10.42},
                {"word": "มายกอด", "start": 10.48, "end": 10.92},
            ],
        },
    ]
    cuts = build_speech_cuts(segments, source_duration=45.0)
    # Both segments close together (0s gap) → merged into ONE cut
    assert len(cuts) == 1, f"Expected 1 cut, got {len(cuts)}: {cuts}"
    # Cut must span all speech — not end at 8.8s (the old bug)
    assert cuts[0]["out"] > 10.0, f"Cut ends too early at {cuts[0]['out']}s — mid-word split"


def test_build_speech_cuts_drops_hallucinated_micro_segment() -> None:
    segments = [
        {
            "start": 5.1,
            "end": 5.16,
            "text": "noise",
            "words": [
                {"word": "x", "start": 5.1, "end": 5.1},
                {"word": "y", "start": 5.1, "end": 5.16},
            ],
        },
        {
            "start": 20.0,
            "end": 23.0,
            "text": "วันนี้มารีวิวครีมตัวนี้เลยนะครับ",
            "words": [
                {"word": "วันนี้", "start": 20.0, "end": 20.6},
                {"word": "มารีวิว", "start": 20.6, "end": 21.2},
                {"word": "ครีม", "start": 21.2, "end": 21.8},
                {"word": "ตัวนี้", "start": 21.8, "end": 22.4},
                {"word": "เลย", "start": 22.4, "end": 22.8},
                {"word": "นะครับ", "start": 22.8, "end": 23.0},
            ],
        },
    ]
    cuts = build_speech_cuts(segments)
    assert len(cuts) == 1
    assert cuts[0]["in"] >= 19.7  # segment.start=20.0 minus WORD_LEAD_IN padding


def test_resnap_selected_cuts_expands_join_lead() -> None:
    """After AI jump, second block should start earlier than raw cut.in."""
    segments = [
        {"start": 0.0, "end": 3.0, "text": "วันนี้มารีวิวครีม", "words": [
            {"word": "วันนี้", "start": 0.3, "end": 0.8},
            {"word": "มารีวิว", "start": 0.8, "end": 1.4},
            {"word": "ครีม", "start": 1.4, "end": 2.0},
        ]},
        {"start": 10.0, "end": 13.0, "text": "ราคาไม่แพงมาก", "words": [
            {"word": "ราคา", "start": 10.2, "end": 10.8},
            {"word": "ไม่แพง", "start": 10.8, "end": 11.4},
            {"word": "มาก", "start": 11.4, "end": 12.0},
        ]},
    ]
    raw_cuts = [
        {"type": "cut", "source": "clip0", "in": 10.0, "out": 13.0, "label": "speech"},
    ]
    resnapped = resnap_selected_cuts(raw_cuts, segments, source_duration=60.0)
    assert len(resnapped) == 1
    assert resnapped[0]["in"] < 10.0  # join lead pulls before Whisper segment.start
    assert resnapped[0]["out"] > 12.0 + WORD_TAIL - 0.05




def test_annotate_dub_script_output_times() -> None:
    script = {
        "segments": [
            {"order": 1, "sourceIn": 62.0, "sourceOut": 67.0, "durationSec": 5.0},
            {"order": 2, "sourceIn": 72.0, "sourceOut": 77.0, "durationSec": 5.0},
            {"order": 3, "sourceIn": 243.0, "sourceOut": 248.0, "durationSec": 5.0},
        ],
    }
    out = annotate_dub_script_output_times(script)
    segs = out["segments"]
    assert segs[0]["outputIn"] == 0.0
    assert segs[0]["outputOut"] == 5.0
    assert segs[1]["outputIn"] == 5.0
    assert segs[2]["outputOut"] == 15.0
    assert out["totalEstimatedSec"] == 15


def test_normalize_dub_montage_groups() -> None:
    script = {
        "segments": [
            {
                "order": 1,
                "voiceoverLineId": 1,
                "sourceIn": 0.0,
                "sourceOut": 3.0,
                "voiceoverScript": "hook line",
            },
            {
                "order": 2,
                "voiceoverLineId": 2,
                "sourceIn": 10.0,
                "sourceOut": 10.6,
                "voiceoverScript": "demo montage",
            },
            {
                "order": 3,
                "voiceoverLineId": 2,
                "sourceIn": 12.0,
                "sourceOut": 13.2,
            },
        ],
    }
    out = normalize_dub_edit_script(script)
    segs = out["segments"]
    assert segs[1]["voiceoverScript"] == "demo montage"
    assert segs[2]["voiceoverScript"] == "demo montage"
    assert segs[1]["voiceoverLineOutputIn"] == segs[1]["outputIn"]
    assert segs[2]["voiceoverLineOutputOut"] == segs[2]["outputOut"]
    assert segs[1]["durationSec"] >= 0.35
    assert out["totalEstimatedSec"] == int(round(segs[-1]["outputOut"]))


def test_normalize_dub_backward_compat_single_cut() -> None:
    script = {
        "segments": [
            {
                "order": 1,
                "sourceIn": 1.0,
                "sourceOut": 4.0,
                "durationSec": 3.0,
                "voiceoverScript": "line one",
            },
            {
                "order": 2,
                "sourceIn": 5.0,
                "sourceOut": 8.0,
                "durationSec": 3.0,
                "voiceoverScript": "line two",
            },
        ],
    }
    out = normalize_dub_edit_script(script)
    segs = out["segments"]
    assert segs[0]["voiceoverLineId"] == 1
    assert segs[1]["voiceoverLineId"] == 2
    assert segs[0]["voiceoverLineOutputIn"] == 0.0
    assert segs[1]["voiceoverLineOutputIn"] == 3.0


def test_anchor_dub_segments_snaps_loose_trim() -> None:
    frames = [
        {"clip_id": "clip0", "time": 12.0, "scene_start": 10.0, "scene_end": 20.0},
        {"clip_id": "clip0", "time": 28.0, "scene_start": 25.0, "scene_end": 35.0},
    ]
    script = {
        "segments": [
            {
                "order": 1,
                "sourceClip": "clip0",
                "sourceIn": 10.2,
                "sourceOut": 13.2,
                "durationSec": 3.0,
                "voiceoverScript": "hook",
            },
            {
                "order": 2,
                "sourceClip": "clip0",
                "sourceIn": 28.0,
                "sourceOut": 30.0,
                "durationSec": 2.0,
            },
        ],
    }
    out = anchor_dub_segments_to_frames(script, frames)
    assert out["segments"][0]["sourceIn"] == 12.0
    assert out["segments"][0]["sourceOut"] == 15.0
    assert out["segments"][1]["sourceIn"] == 28.0


def test_clamp_dub_segments_drops_segment_starting_past_clip_end() -> None:
    """Gemini video path: a segment starting at/after the real clip duration is hallucinated — drop it."""
    script = {
        "segments": [
            {"order": 1, "sourceClip": "clip0", "sourceIn": 5.0, "sourceOut": 8.0},
            {"order": 2, "sourceClip": "clip0", "sourceIn": 45.0, "sourceOut": 49.0},  # clip0 is only 40s
        ],
    }
    out = clamp_dub_segments_to_clip_durations(script, {"clip0": 40.0})
    assert len(out["segments"]) == 1
    assert out["segments"][0]["order"] == 1


def test_clamp_dub_segments_clamps_overshoot() -> None:
    """sourceOut spilling slightly past the clip's real end is clamped, not dropped."""
    script = {
        "segments": [
            {"order": 1, "sourceClip": "clip0", "sourceIn": 38.0, "sourceOut": 41.5, "matchedFrameTime": 41.5},
        ],
    }
    out = clamp_dub_segments_to_clip_durations(script, {"clip0": 40.0})
    seg = out["segments"][0]
    assert seg["sourceOut"] == 40.0
    assert seg["matchedFrameTime"] == 40.0


def test_clamp_dub_segments_drops_unknown_clip_and_invalid_range() -> None:
    script = {
        "segments": [
            {"order": 1, "sourceClip": "clip9", "sourceIn": 1.0, "sourceOut": 3.0},  # unknown clip
            {"order": 2, "sourceClip": "clip0", "sourceIn": -1.0, "sourceOut": 3.0},  # negative sourceIn
            {"order": 3, "sourceClip": "clip0", "sourceIn": 5.0, "sourceOut": 4.0},  # out <= in
            {"order": 4, "sourceClip": "clip0", "sourceIn": 10.0, "sourceOut": 12.0},  # valid
        ],
    }
    out = clamp_dub_segments_to_clip_durations(script, {"clip0": 40.0})
    assert [s["order"] for s in out["segments"]] == [4]


def test_normalize_dub_with_sample_frames_anchors() -> None:
    frames = [{"clip_id": "clip0", "time": 18.0, "scene_start": 15.0, "scene_end": 25.0}]
    script = {
        "segments": [
            {
                "order": 1,
                "sourceClip": "clip0",
                "sourceIn": 15.5,
                "sourceOut": 18.5,
                "durationSec": 3.0,
            },
        ],
    }
    out = normalize_dub_edit_script(script, sample_frames=frames)
    assert out["segments"][0]["sourceIn"] == 18.0


def test_dub_sample_time_skips_scene_lead_in() -> None:
    from packages.video.scene import _sample_time_in_scene

    scene = {"start": 10.0, "duration": 20.0}
    t = _sample_time_in_scene(scene, 0.5, lead_skip_pct=0.25)
    assert t == 22.5  # 10 + 5 (skip) + 7.5 (half of remaining)


def test_clip_edge_times_long_clip() -> None:
    from packages.video.scene import _clip_edge_times

    edges = _clip_edge_times(600.0)
    assert edges[0] == ("opening", 5.0)
    assert edges[1] == ("closing", 595.0)


def test_clip_edge_times_short_clip() -> None:
    from packages.video.scene import _clip_edge_times

    edges = _clip_edge_times(5.0)
    assert len(edges) == 2
    assert edges[0][0] == "opening"
    assert edges[1][0] == "closing"
    assert edges[1][1] - edges[0][1] >= 2.0


def test_format_frame_descriptor_edge() -> None:
    from packages.video.scene import format_frame_descriptor

    assert format_frame_descriptor({
        "clip_id": "clip0",
        "time": 12.3,
        "edge": "opening",
    }) == "[clip0 clip opening at 12.3s]"
    assert "scene 2" in format_frame_descriptor({
        "clip_id": "clip0",
        "scene_idx": 2,
        "time": 45.0,
        "scene_start": 40.0,
        "scene_end": 50.0,
    })


def test_enforce_unique_chronological_dub_cuts() -> None:
    """Dedup duplicate anchors but keep AI playback order (not source-time sort)."""
    frames = [
        {"clip_id": "clip0", "time": 7.3, "scene_start": 0.0, "scene_end": 30.0},
        {"clip_id": "clip0", "time": 45.0, "scene_start": 40.0, "scene_end": 55.0},
        {"clip_id": "clip0", "time": 91.2, "scene_start": 80.0, "scene_end": 100.0},
        {"clip_id": "clip0", "time": 118.5, "scene_start": 110.0, "scene_end": 130.0},
    ]
    script = {
        "totalEstimatedSec": 10,
        "segments": [
            {
                "order": 1,
                "voiceoverLineId": 1,
                "sourceClip": "clip0",
                "sourceIn": 118.5,
                "sourceOut": 120.2,
                "durationSec": 1.7,
                "matchedFrameTime": 118.5,
                "voiceoverScript": "hook",
            },
            {
                "order": 2,
                "voiceoverLineId": 2,
                "sourceClip": "clip0",
                "sourceIn": 7.3,
                "sourceOut": 9.0,
                "durationSec": 1.7,
                "matchedFrameTime": 7.3,
                "voiceoverScript": "demo",
            },
            {
                "order": 3,
                "voiceoverLineId": 2,
                "sourceClip": "clip0",
                "sourceIn": 7.29,
                "sourceOut": 8.99,
                "durationSec": 1.7,
                "matchedFrameTime": 7.29,
            },
            {
                "order": 4,
                "voiceoverLineId": 3,
                "sourceClip": "clip0",
                "sourceIn": 91.2,
                "sourceOut": 92.9,
                "durationSec": 1.7,
                "matchedFrameTime": 91.2,
                "voiceoverScript": "cta",
            },
        ],
    }
    out = enforce_unique_chronological_dub_cuts(script, frames)
    segs = out["segments"]
    anchors = [s["matchedFrameTime"] for s in segs]
    assert len(anchors) == 3
    assert len(anchors) == len(set(round(a, 1) for a in anchors))
    assert anchors == [118.5, 7.3, 91.2]
    assert [s["voiceoverScript"] for s in segs if s.get("voiceoverScript")] == ["hook", "demo", "cta"]
    assert 7.29 not in anchors


def test_normalize_dub_dedupes_with_sample_frames() -> None:
    frames = [
        {"clip_id": "clip0", "time": 10.0, "scene_start": 8.0, "scene_end": 20.0},
        {"clip_id": "clip0", "time": 25.0, "scene_start": 22.0, "scene_end": 35.0},
        {"clip_id": "clip0", "time": 40.0, "scene_start": 38.0, "scene_end": 50.0},
    ]
    script = {
        "totalEstimatedSec": 6,
        "segments": [
            {
                "order": 1,
                "voiceoverLineId": 1,
                "sourceClip": "clip0",
                "sourceIn": 10.0,
                "sourceOut": 12.0,
                "durationSec": 2.0,
                "matchedFrameTime": 10.0,
                "voiceoverScript": "a",
            },
            {
                "order": 2,
                "voiceoverLineId": 1,
                "sourceClip": "clip0",
                "sourceIn": 10.1,
                "sourceOut": 12.1,
                "durationSec": 2.0,
                "matchedFrameTime": 10.0,
            },
        ],
    }
    out = normalize_dub_edit_script(script, sample_frames=frames)
    anchors = [s["matchedFrameTime"] for s in out["segments"]]
    assert len(anchors) == 1
    assert anchors[0] == 10.0


def test_talking_head_total_limit() -> None:
    from packages.video.timeline import TALKING_HEAD_MAX_TOTAL_SEC, talking_head_exceeds_total_limit

    assert not talking_head_exceeds_total_limit(TALKING_HEAD_MAX_TOTAL_SEC)
    assert talking_head_exceeds_total_limit(TALKING_HEAD_MAX_TOTAL_SEC + 1)
