"""Real vendor cost (cost_thb) and the admin's vendor price table.

Correct list prices (owner, 2026-09-22): Flash $0.75/$3.75 until 2026-12-31
then $1.50/$7.50; 3.1 Pro $2/$12, $4/$18 above 200k prompt tokens; Scribe v2
$0.22/h + $0.05/h when keyterms are sent.
"""

from datetime import date
from decimal import Decimal

import pytest

from packages.admin.cost_config import (
    DEFAULT_COST_CONFIG,
    CostConfig,
    default_model_price,
    model_price,
    stt_price,
)
from packages.billing import vendor_cost as vc

PRICING = vc.Pricing(config=DEFAULT_COST_CONFIG, usd_thb=34.5, fx_source="test")


def test_default_prices_are_the_real_list_prices():
    m = DEFAULT_COST_CONFIG.models
    for flash in ("gemini-3.7-flash", "gemini-3.8-flash"):
        now = m[flash].at(date(2026, 9, 22))
        later = m[flash].at(date(2027, 1, 1))
        assert (now.input, now.output) == (0.75, 3.75)
        assert (later.input, later.output) == (1.50, 7.50)
    pro = m["gemini-3.1-pro-preview"]
    assert (pro.input, pro.output, pro.input_long, pro.output_long, pro.long_threshold) == (
        2.0, 12.0, 4.0, 18.0, 200_000,
    )
    stt = DEFAULT_COST_CONFIG.stt["scribe_v2"]
    assert (stt.usd_per_hour, stt.keyterms_usd_per_hour) == (0.22, 0.05)
    assert DEFAULT_COST_CONFIG.vat_included is False  # owner not VAT-registered


def test_the_flash_promo_ends_after_new_years_eve():
    flash = DEFAULT_COST_CONFIG.models["gemini-3.7-flash"]
    assert flash.at(date(2026, 12, 31)).input == 0.75
    assert flash.at(date(2027, 1, 1)).input == 1.50


def test_llm_cost():
    # 1M in + 100k out on Flash in 2026: $0.75 + $0.375 = $1.125 → ฿38.8125.
    cost = vc.cost_thb_for_llm(PRICING, "gemini/gemini-3.7-flash", 1_000_000, 0, 100_000, date(2026, 9, 22))
    assert cost == Decimal("38.8125")
    # Same call in 2027 costs double.
    later = vc.cost_thb_for_llm(PRICING, "gemini/gemini-3.7-flash", 1_000_000, 0, 100_000, date(2027, 2, 1))
    assert later == Decimal("77.6250")


def test_cached_input_and_long_tier():
    # Pro, 300k prompt (long tier), 100k cached: (200k×4 + 100k×0.4 + 10k×18)/1e6 = $1.02.
    usd = vc.llm_cost_usd(DEFAULT_COST_CONFIG, "gemini-3.1-pro-preview", 300_000, 100_000, 10_000, date(2026, 9, 22))
    assert usd == pytest.approx(1.02)
    short = vc.llm_cost_usd(DEFAULT_COST_CONFIG, "gemini-3.1-pro-preview", 200_000, 0, 0, date(2026, 9, 22))
    assert short == pytest.approx(0.40)


def test_stt_cost_depends_on_keyterms():
    hour_plain = vc.cost_thb_for_stt(PRICING, "scribe_v2", 3600, keyterms=False)
    hour_terms = vc.cost_thb_for_stt(PRICING, "scribe_v2", 3600, keyterms=True)
    assert hour_plain == Decimal("7.5900")  # 0.22 × 34.5
    assert hour_terms == Decimal("9.3150")  # 0.27 × 34.5


def test_unknown_models_are_priced_dear_not_cheap():
    assert default_model_price("gemini-9-ultra").input == 2.0
    assert model_price(DEFAULT_COST_CONFIG, "gemini/unknown").output == 12.0
    assert stt_price(DEFAULT_COST_CONFIG, "scribe_v9").usd_per_hour >= 0.22


def test_a_legacy_document_is_upgraded_not_rejected():
    """The old admin stored STT as a credit package and stale model prices."""
    legacy = {
        "fx_rate": 35.0,
        "models": {
            "gemini-3.7-flash": {"input": 0.15, "output": 1.20},  # stale default
            "gemini-3.8-flash": {"input": 0.5, "output": 3.0},  # owner-edited: kept
        },
        "stt": {"model": "scribe_v2", "credits_per_hour": 4000, "monthly_price": 790, "credits": 100000},
        "fixed": [],
        "per_user": [],
        "vat_included": True,
        "include_internal": True,
    }
    cfg = CostConfig.model_validate(legacy)
    assert cfg.fx_rate == 35.0
    assert cfg.stt["scribe_v2"].usd_per_hour == 0.22
    assert cfg.models["gemini-3.7-flash"].at(date(2026, 9, 1)).input == 0.75
    assert cfg.models["gemini-3.8-flash"].input == 0.5
    assert cfg.vat_included is False


def test_the_current_document_round_trips():
    dumped = DEFAULT_COST_CONFIG.model_dump(mode="json")
    again = CostConfig.model_validate(dumped)
    assert again == DEFAULT_COST_CONFIG
    assert dumped["models"]["gemini-3.7-flash"]["then"]["input"] == 1.5
