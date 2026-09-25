"""The agentic request survives the trip through LiteLLM.

LiteLLM copies exactly fps / start_offset / end_offset out of video_metadata
and drops everything else (1.100.1, still true in 1.102.1). An unknown key is
not rejected, it is ignored — so the only way to know this works is to assert
the field is on the part LiteLLM hands to the wire.
"""

from __future__ import annotations

import pytest

from packages.llm import gemini_video_mode as mode
from packages.llm.files import gemini_video_block


def test_static_and_none_send_nothing():
    # Static IS Gemini's default. Sending it would add a field that changes no
    # behaviour and has to be explained forever after.
    assert mode.normalize(None) is None
    assert mode.normalize("") is None
    assert mode.normalize("static") is None
    assert mode.carrier("static") == {}


def test_agentic_is_upper_cased_for_the_wire():
    assert mode.normalize("agentic") == "AGENTIC"
    assert mode.normalize("AGENTIC") == "AGENTIC"
    assert mode.carrier("agentic") == {mode.CARRIER_KEY: "AGENTIC"}


def test_an_unknown_mode_is_refused_here_not_by_the_vendor():
    with pytest.raises(ValueError):
        mode.normalize("turbo")


def test_the_block_carries_mode_and_fps_together():
    block = gemini_video_block("f1", fps=5, processing="agentic")["file"]
    assert block["video_metadata"] == {mode.CARRIER_KEY: "AGENTIC", "fps": 5}
    # Default stays byte-identical to what it was before this existed.
    assert "video_metadata" not in gemini_video_block("f1")["file"]


def test_litellm_puts_mediaProcessing_on_the_part():
    mode.install()
    from litellm.llms.vertex_ai.gemini import transformation as tr

    part = tr._apply_gemini_metadata(
        {"file_data": {"file_uri": "u"}},
        "gemini-3.7-flash",
        None,
        {mode.CARRIER_KEY: "AGENTIC", "fps": 5},
    )
    assert part[mode.WIRE_KEY] == "AGENTIC"
    # The carrier key is LiteLLM's to ignore; it must not reach Gemini as part
    # of video_metadata, where it is not a field.
    assert mode.CARRIER_KEY not in part["video_metadata"]
    assert part["video_metadata"]["fps"] == 5


def test_installing_twice_does_not_stack_wrappers():
    mode.install()
    from litellm.llms.vertex_ai.gemini import transformation as tr

    first = tr._apply_gemini_metadata
    mode.install()
    assert tr._apply_gemini_metadata is first


def test_a_part_without_the_mode_is_untouched():
    mode.install()
    from litellm.llms.vertex_ai.gemini import transformation as tr

    part = tr._apply_gemini_metadata(
        {"file_data": {"file_uri": "u"}}, "gemini-3.7-flash", None, {"fps": 2}
    )
    assert mode.WIRE_KEY not in part


def test_the_default_setting_is_still_static():
    from packages.core.settings import Settings

    assert Settings().dub_video_processing == "static"
