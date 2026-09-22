"""Real vendor cost of one request, in THB — what the owner pays, not the user.

Priced from the admin's vendor price table (packages/admin/cost_config.py,
dated schedule + Pro's >200k tier + cached-input ratio + per-hour STT with the
keyterms surcharge) and the current USD→THB rate (packages/billing/fx.py).
Recorded on the usage row as ``cost_thb`` + ``fx_rate`` at the moment it is
written, so a later price or FX edit never rewrites history — and never
changes what a user was charged (that is the rate card's job).
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy.ext.asyncio import AsyncSession

from packages.admin.cost_config import CostConfig, load_cost_config, model_price, stt_price
from packages.billing import fx

CONFIG_CACHE_SEC = 60.0
_Q = Decimal("0.0001")


@dataclass(frozen=True)
class Pricing:
    config: CostConfig
    usd_thb: float
    fx_source: str


def _thb(usd: float, usd_thb: float) -> Decimal:
    return Decimal(str(usd * usd_thb)).quantize(_Q, rounding=ROUND_HALF_UP)


def llm_cost_usd(
    config: CostConfig,
    model: str | None,
    input_tokens: int,
    cached_tokens: int,
    output_tokens: int,
    on: date,
) -> float:
    price = model_price(config, model).at(on)
    inp = max(0, int(input_tokens or 0))
    cached = min(max(0, int(cached_tokens or 0)), inp)
    out = max(0, int(output_tokens or 0))
    rate_in, rate_out = price.rates_usd(inp)
    return ((inp - cached) * rate_in + cached * rate_in * price.cached_ratio + out * rate_out) / 1e6


def stt_cost_usd(config: CostConfig, model: str | None, seconds: float, keyterms: bool) -> float:
    price = stt_price(config, model)
    per_hour = price.usd_per_hour + (price.keyterms_usd_per_hour if keyterms else 0.0)
    return max(0.0, float(seconds or 0.0)) * per_hour / 3600.0


def cost_thb_for_llm(
    pricing: Pricing,
    model: str | None,
    input_tokens: int,
    cached_tokens: int,
    output_tokens: int,
    on: date | None = None,
) -> Decimal:
    on = on or datetime.now(UTC).date()
    usd = llm_cost_usd(pricing.config, model, input_tokens, cached_tokens, output_tokens, on)
    return _thb(usd, pricing.usd_thb)


def cost_thb_for_stt(pricing: Pricing, model: str | None, seconds: float, keyterms: bool) -> Decimal:
    return _thb(stt_cost_usd(pricing.config, model, seconds, keyterms), pricing.usd_thb)


_cache: tuple[float, Pricing] | None = None


def invalidate_cache() -> None:
    global _cache
    _cache = None


async def current_pricing(session: AsyncSession) -> Pricing:
    """The price table + FX rate, cached ``CONFIG_CACHE_SEC`` per process."""
    global _cache
    now = time.monotonic()
    if _cache is not None and now - _cache[0] < CONFIG_CACHE_SEC:
        return _cache[1]
    config = await load_cost_config(session)
    quote = await fx.current_usd_thb(session)
    pricing = Pricing(config=config, usd_thb=quote.usd_thb, fx_source=quote.source)
    _cache = (now, pricing)
    return pricing
