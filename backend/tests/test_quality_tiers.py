"""Engine / Precision tiers — the user-facing quality dials.

The mapping tier → provider model / frame rate lives in exactly one module so
nothing else has to know a vendor model id. These tests pin the two properties
that matter operationally: an unknown value must never take a render down, and
the defaults must reproduce today's behaviour byte for byte.
"""

from types import SimpleNamespace

import pytest

from packages.core.settings import get_settings
from packages.video import quality


@pytest.fixture(autouse=True)
def _clear_settings_cache():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_known_values_pass_through():
    assert quality.normalize_engine("lite") == "lite"
    assert quality.normalize_engine("pro") == "pro"
    assert quality.normalize_precision("standard") == "standard"
    assert quality.normalize_precision("high") == "high"


@pytest.mark.parametrize("bad", [None, "", "  ", "ultra", "PRO!", "5fps", "0"])
def test_unknown_values_degrade_to_the_default_instead_of_raising(bad):
    """A typo in a stored row (or a client newer than this server) must not be
    able to fail someone's render — same rule DUB_PROMPT_VERSION follows."""
    assert quality.normalize_engine(bad) == quality.DEFAULT_ENGINE
    assert quality.normalize_precision(bad) == quality.DEFAULT_PRECISION


def test_case_and_whitespace_tolerated():
    assert quality.normalize_engine("  Lite ") == "lite"
    assert quality.normalize_precision("HIGH") == "high"


def test_precision_maps_to_frame_rate():
    # 0 means "attach no video_metadata at all" — the provider default (~1 fps),
    # which is exactly what shipped before this feature.
    assert quality.precision_fps("standard") == 0
    assert quality.precision_fps(None) == 0
    assert quality.precision_fps("high") == get_settings().dub_precision_high_fps
    assert quality.precision_fps("high") > 0


def test_engine_maps_to_distinct_models():
    lite, pro = quality.engine_model("lite"), quality.engine_model("pro")
    assert lite and pro
    assert lite != pro, "the two tiers must not resolve to the same model"


def test_default_tier_is_pro_standard():
    """The defaults reproduce current behaviour: the model DUB_VISION_MODEL
    already selects, sampled at the provider default rate."""
    assert quality.DEFAULT_ENGINE == "pro"
    assert quality.DEFAULT_PRECISION == "standard"
    model, fps, effort = quality.resolve(None, None)
    assert fps == 0
    assert model == quality.engine_model("pro")
    assert effort == quality.engine_effort("pro")


def test_resolve_returns_every_axis():
    model, fps, effort = quality.resolve("lite", "high")
    assert model == quality.engine_model("lite")
    assert fps == get_settings().dub_precision_high_fps
    assert effort == quality.engine_effort("lite")


# ── thinking depth ───────────────────────────────────────────────────────────
#
# Effort used to be one environment variable for every account and every job,
# while thinking is ~94% of a cut's fixed cost — so the cheap engine bought a
# cheaper model and still paid for the expensive thinking. It is now part of the
# tier the user already picks.


def test_engine_maps_to_thinking_depth():
    assert quality.engine_effort("lite") == "medium"
    assert quality.engine_effort("pro") == "high"


@pytest.mark.parametrize("bad", [None, "", "  ", "ultra", "PRO!"])
def test_unknown_engine_falls_back_to_the_default_tiers_effort(bad):
    """Same rule as the model: a typo must not fail a render, and it must not
    silently buy a different depth than the default tier's either."""
    assert quality.engine_effort(bad) == quality.engine_effort(quality.DEFAULT_ENGINE)


def test_per_tier_effort_is_overridable(monkeypatch):
    monkeypatch.setenv("DUB_EFFORT_LITE", "low")
    monkeypatch.setenv("DUB_EFFORT_PRO", "medium")
    get_settings.cache_clear()
    assert quality.engine_effort("lite") == "low"
    assert quality.engine_effort("pro") == "medium"


def test_blank_per_tier_effort_falls_back_to_the_single_setting(monkeypatch):
    """Blanking both DUB_EFFORT_* restores the one-knob behaviour this replaced
    — the escape hatch if binding effort to the tier ever has to be undone."""
    monkeypatch.setenv("DUB_EFFORT_LITE", "")
    monkeypatch.setenv("DUB_EFFORT_PRO", "")
    monkeypatch.setenv("DUB_VISION_EFFORT", "high")
    get_settings.cache_clear()
    assert quality.engine_effort("lite") == "high"
    assert quality.engine_effort("pro") == "high"


# ── the depth the dub call sites actually send ───────────────────────────────


def _stub_gemini(monkeypatch, captured: dict, payload: str):
    async def fake_upload(path, mime_type: str) -> str:
        return "file_x"

    async def fake_delete(ids) -> None:
        pass

    async def fake_stream(messages, *, system, project_uid, on_thinking, **kwargs):
        message = SimpleNamespace(content=payload)
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])

    def fake_call_kwargs(**kw):
        captured.update(kw)
        return {"model": "test/model"}

    monkeypatch.setattr("packages.llm.files.upload_gemini_file", fake_upload)
    monkeypatch.setattr("packages.llm.files.delete_gemini_files", fake_delete)
    monkeypatch.setattr("packages.llm.gateway.acompletion_stream_thinking", fake_stream)
    monkeypatch.setattr("packages.llm.config.call_kwargs", fake_call_kwargs)


@pytest.mark.asyncio
@pytest.mark.parametrize("engine", ["lite", "pro"])
async def test_cut_call_thinks_at_the_engine_tiers_depth(monkeypatch, engine):
    from packages.video import dub_ai

    captured: dict = {}
    _stub_gemini(monkeypatch, captured, '{"mode": "highlight", "segments": []}')

    _model, _fps, effort = quality.resolve(engine, "standard")
    await dub_ai.generate_dub_edit_script_video(
        [], brief="", user_script="", target_duration_sec=None, project_uid="p1",
        effort=effort,
    )
    assert captured["effort"] == quality.engine_effort(engine)


@pytest.mark.asyncio
async def test_reedit_call_thinks_at_the_engine_tiers_depth(monkeypatch, tmp_path):
    from packages.video import dub_ai

    captured: dict = {}
    _stub_gemini(monkeypatch, captured, '{"segments": []}')

    await dub_ai.generate_dub_reedit_script_video(
        [], (tmp_path / "preview.mp4", 10.0),
        current_segments=[], selected_line_ids=[], instruction="สั้นลง",
        project_uid="p1", effort=quality.engine_effort("lite"),
    )
    assert captured["effort"] == "medium"


@pytest.mark.asyncio
async def test_a_caller_with_no_tier_still_reads_the_setting(monkeypatch):
    """DUB_VISION_EFFORT is not retired: it is the fallback for every call site
    that has no Engine tier in hand (speech selection, the A/B probe, any future
    caller), so passing no effort must reproduce the pre-tier behaviour."""
    from packages.video import dub_ai

    monkeypatch.setenv("DUB_VISION_EFFORT", "low")
    monkeypatch.setenv("DUB_EFFORT_LITE", "medium")
    monkeypatch.setenv("DUB_EFFORT_PRO", "high")
    get_settings.cache_clear()

    captured: dict = {}
    _stub_gemini(monkeypatch, captured, '{"mode": "highlight", "segments": []}')
    await dub_ai.generate_dub_edit_script_video(
        [], brief="", user_script="", target_duration_sec=None, project_uid="p1",
    )
    assert captured["effort"] == "low"


def test_speech_selection_has_no_tier_and_keeps_the_setting(monkeypatch):
    """The speech modes pick segments from a transcript — a different request,
    never measured in the effort A/B, and with no Engine tier reaching it. It
    stays on DUB_VISION_EFFORT on purpose."""
    import inspect

    from packages.video import speech_select

    src = inspect.getsource(speech_select)
    assert "effort=settings.dub_vision_effort" in src
    assert "engine_effort" not in src


def test_tier_names_never_leak_a_vendor_name():
    """Whatever a tier is called, it must be safe to render in the UI — the
    product rule is that no screen ever names the AI vendor."""
    banned = ("gemini", "google", "claude", "anthropic", "openai", "gpt", "fps")
    for name in quality.ENGINES + quality.PRECISIONS:
        assert not any(b in name.lower() for b in banned)
