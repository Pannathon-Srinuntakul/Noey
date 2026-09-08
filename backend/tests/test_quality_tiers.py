"""Engine / Precision tiers — the user-facing quality dials.

The mapping tier → provider model / frame rate lives in exactly one module so
nothing else has to know a vendor model id. These tests pin the two properties
that matter operationally: an unknown value must never take a render down, and
the defaults must reproduce today's behaviour byte for byte.
"""

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
    model, fps = quality.resolve(None, None)
    assert fps == 0
    assert model == quality.engine_model("pro")


def test_resolve_returns_both_axes():
    model, fps = quality.resolve("lite", "high")
    assert model == quality.engine_model("lite")
    assert fps == get_settings().dub_precision_high_fps


def test_tier_names_never_leak_a_vendor_name():
    """Whatever a tier is called, it must be safe to render in the UI — the
    product rule is that no screen ever names the AI vendor."""
    banned = ("gemini", "google", "claude", "anthropic", "openai", "gpt", "fps")
    for name in quality.ENGINES + quality.PRECISIONS:
        assert not any(b in name.lower() for b in banned)
