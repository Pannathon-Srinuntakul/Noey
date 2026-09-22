"""The rate card: vendor usage → our tokens (owner-approved 2026-09-22).

The card is the ONE thing that decides how fast a user's limit drains, so
every number here is pinned against the plan (docs/token-billing-plan.md §1).
"""

import dataclasses

import pytest

from packages.billing import rate_card as rc


def test_the_peg_is_fifty_baht_per_million_at_2027_prices():
    """Each rate = vendor $/1M × ฿34.5 ÷ ฿50."""
    v1 = rc.card("v1")
    peg = 34.5 / 50
    assert v1.llm["flash"].input == pytest.approx(1.50 * peg)
    assert v1.llm["flash"].output == pytest.approx(7.50 * peg)
    assert v1.llm["pro"].input == pytest.approx(2.00 * peg)
    assert v1.llm["pro"].output == pytest.approx(12.00 * peg)
    assert v1.llm["pro"].input_long == pytest.approx(4.00 * peg)
    assert v1.llm["pro"].output_long == pytest.approx(18.00 * peg)
    # Scribe v2 pay-as-you-go $0.22/h + $0.05/h keyterms = 186,300 per hour.
    assert v1.stt_per_sec * 3600 == pytest.approx(0.27 * 34.5 / 50 * 1e6)
    assert v1.stt_per_sec == 51.75
    assert v1.cached_ratio == 0.10


def test_money_constants():
    assert rc.REFERENCE_COST_SATANG_PER_1M == 5_000
    assert rc.SELL_SATANG_PER_1M == 25_000
    assert rc.TOPUP_SATANG_PER_1M == 35_000


@pytest.mark.parametrize(
    ("model", "family"),
    [
        ("gemini/gemini-3.7-flash", "flash"),
        ("gemini-3.8-flash", "flash"),
        ("GEMINI/Gemini-3.8-Flash", "flash"),
        ("gemini/gemini-3.1-pro-preview", "pro"),
        ("some-new-model", "pro"),  # unknown → the dearer guess
        ("", "pro"),
        (None, "pro"),
    ],
)
def test_family_matching(model, family):
    assert rc.family_for(model) == family


def test_flash_call():
    # 1M in + 100k out on Flash = 1,035,000 + 517,500.
    assert rc.tokens_for_llm("gemini/gemini-3.7-flash", 1_000_000, 0, 100_000) == 1_552_500


def test_cached_input_is_ten_percent_of_the_input_rate():
    full = rc.tokens_for_llm("gemini-3.8-flash", 100_000, 0, 0)
    half_cached = rc.tokens_for_llm("gemini-3.8-flash", 100_000, 50_000, 0)
    assert full == 103_500
    assert half_cached == 51_750 + 5_175
    # Cached above the prompt size is clamped, never negative.
    assert rc.tokens_for_llm("gemini-3.8-flash", 1_000, 5_000, 0) == rc.tokens_for_llm(
        "gemini-3.8-flash", 1_000, 1_000, 0
    )


def test_pro_long_prompt_tier_prices_the_whole_call():
    at_threshold = rc.tokens_for_llm("gemini-3.1-pro-preview", 200_000, 0, 1_000)
    above = rc.tokens_for_llm("gemini-3.1-pro-preview", 200_001, 0, 1_000)
    assert at_threshold == 276_000 + 8_280
    assert above == rc._ceil(200_001 * 2.76 + 1_000 * 12.42)
    # Flash has no long tier.
    assert rc.tokens_for_llm("gemini-3.7-flash", 300_000, 0, 0) == 310_500


def test_rounding_is_one_ceiling_per_call():
    assert rc.tokens_for_llm("gemini-3.7-flash", 1, 0, 0) == 2  # 1.035 → 2
    assert rc.tokens_for_llm("gemini-3.7-flash", 0, 0, 0) == 0
    # Float noise must not add a token to a whole figure.
    assert rc.tokens_for_llm("gemini-3.7-flash", 1_000_000, 0, 0) == 1_035_000


def test_stt_seconds():
    assert rc.tokens_for_stt(3600) == 186_300
    assert rc.tokens_for_stt(1) == 52  # 51.75 → 52
    assert rc.tokens_for_stt(0) == 0
    assert rc.tokens_for_stt(-4) == 0


def test_versions_are_immutable_and_forward_only():
    assert rc.CURRENT_RATE_VERSION in rc.RATE_CARDS
    with pytest.raises(TypeError):
        rc.RATE_CARDS["v2"] = rc.card("v1")  # type: ignore[index]
    with pytest.raises(TypeError):
        rc.card("v1").llm["flash"] = rc.card("v1").llm["pro"]  # type: ignore[index]
    with pytest.raises(dataclasses.FrozenInstanceError):
        rc.card("v1").stt_per_sec = 1.0  # type: ignore[misc]
    with pytest.raises(KeyError):
        rc.card("v0")


def test_the_card_never_reads_fx_or_vendor_prices():
    """FX / price moves change our margin, never a user's drain rate."""
    import inspect

    imports = [
        line for line in inspect.getsource(rc).splitlines() if line.startswith(("import ", "from "))
    ]
    assert imports and not any("packages" in line for line in imports), imports


def test_describe_is_plain_data():
    d = rc.describe()
    assert d["version"] == "v1" and d["sell_thb_per_1m"] == 250 and d["topup_thb_per_1m"] == 350
    assert set(d["llm"]) == {"flash", "pro"}
