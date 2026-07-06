"""Edit Mode manual timeline editor: pure-function coverage.

resolve_edit_target / captions_for_edited_cuts are the deterministic helpers
the GET/PUT /videos/{uid}/edit-timeline endpoints rely on to route saves to
the correct on-disk file (timeline.json vs edit_script.json) and to keep
captions in sync with manual cut edits without calling the AI.
"""

from packages.video.timeline import (
    captions_for_edited_cuts,
    dub_segments_from_edit_cuts,
    resolve_edit_target,
)


def test_resolve_edit_target_talking_head() -> None:
    assert resolve_edit_target("talking_head", has_voiceover=False) == "timeline"
    assert resolve_edit_target("talking_head", has_voiceover=True) == "timeline"


def test_resolve_edit_target_dub_first_no_voiceover() -> None:
    assert resolve_edit_target("dub_first", has_voiceover=False) == "edit_script"


def test_resolve_edit_target_dub_first_with_voiceover() -> None:
    assert resolve_edit_target("dub_first", has_voiceover=True) == "timeline"


def test_captions_for_edited_cuts_single_source_passthrough() -> None:
    # Single source clip: local time == global time, so captions should match
    # build_captions_for_cuts called directly.
    segments = [
        {"start": 1.0, "end": 2.0, "text": "hello"},
        {"start": 5.0, "end": 6.0, "text": "world"},
    ]
    sources = [{"id": "clip0", "durationSec": 10.0}]
    cuts = [{"source": "clip0", "in": 0.0, "out": 3.0}, {"source": "clip0", "in": 4.0, "out": 8.0}]

    captions = captions_for_edited_cuts(segments, sources, cuts)

    assert len(captions) == 2
    assert captions[0]["text"] == "hello"
    assert captions[0]["start"] == 1.0
    # second cut starts at out_t=3.0 (duration of first cut), local "world" at 5.0
    # falls within cut 2 (4.0-8.0), offset = 5.0 - 4.0 = 1.0 -> global output 3.0+1.0
    assert captions[1]["text"] == "world"
    assert captions[1]["start"] == 4.0


def test_captions_for_edited_cuts_multi_source_offsets() -> None:
    # Two source clips of 10s each; transcript is on the combined (global) timeline.
    # A cut on clip1 (local in=2.0) must map to global time 10.0+2.0=12.0 to find
    # the matching transcript segment — this is the bug a naive local-time call
    # to build_captions_for_cuts would hit on multi-clip projects.
    segments = [{"start": 12.5, "end": 13.5, "text": "from clip1"}]
    sources = [{"id": "clip0", "durationSec": 10.0}, {"id": "clip1", "durationSec": 10.0}]
    cuts = [{"source": "clip1", "in": 2.0, "out": 4.0}]

    captions = captions_for_edited_cuts(segments, sources, cuts)

    assert len(captions) == 1
    assert captions[0]["text"] == "from clip1"
    # global seg start 12.5, cut global in = 10.0+2.0=12.0 -> offset 0.5, out_t starts at 0
    assert captions[0]["start"] == 0.5


def test_dub_segments_from_edit_cuts_preserves_voiceover_line_id() -> None:
    cuts = [
        {
            "source": "clip0",
            "in": 0.0,
            "out": 2.0,
            "label": "1",
            "voiceoverLineId": 1,
            "voiceoverScript": "hook line",
        },
        {
            "source": "clip0",
            "in": 5.0,
            "out": 7.0,
            "label": "2",
            "voiceoverLineId": 2,
            "voiceoverScript": "second angle",
        },
        {
            "source": "clip1",
            "in": 1.0,
            "out": 3.0,
            "label": "2",
            "voiceoverLineId": 2,
            "voiceoverScript": "",
        },
    ]

    segs = dub_segments_from_edit_cuts(cuts)

    assert len(segs) == 3
    assert segs[0]["voiceoverLineId"] == 1
    assert segs[0]["voiceoverScript"] == "hook line"
    assert segs[1]["voiceoverLineId"] == 2
    assert segs[2]["voiceoverLineId"] == 2
    assert segs[1]["order"] == 2
    assert segs[2]["order"] == 3
    assert segs[2]["sourceClip"] == "clip1"


def test_dub_segments_from_edit_cuts_falls_back_to_label() -> None:
    cuts = [{"source": "clip0", "in": 0.0, "out": 1.5, "label": "3", "voiceoverScript": "from label"}]

    segs = dub_segments_from_edit_cuts(cuts)

    assert segs[0]["voiceoverLineId"] == 3
    assert segs[0]["voiceoverScript"] == "from label"
