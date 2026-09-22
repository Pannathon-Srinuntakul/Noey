"""The USD→THB rate real vendor cost is priced with.

Resolution order (``current_usd_thb``):

1. the admin override (``admin_settings`` key ``fx_override``) — always wins;
2. the newest fetched rate in ``core.fx_rates``, if it is at most 7 days old;
3. the manual ``fx_rate`` in the admin cost config;
4. ฿34.5 — the rate the rate card was pegged at.

The worker's ``refresh_fx`` cron fetches once a day: open.er-api.com first
(free, no key), frankfurter.app (ECB reference rates) when that fails. A
figure outside ``SANE_BAND`` is refused rather than stored — a broken feed
must not silently re-price every usage row.

The rate card never reads any of this: FX moves our margin, never how fast a
user's limit drains (packages/billing/rate_card.py).
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from packages.core.logging import get_logger
from packages.db.models.admin import AdminSetting
from packages.db.models.fx import FxRate

log = get_logger(__name__)

OVERRIDE_KEY = "fx_override"
DEFAULT_USD_THB = 34.5
SANE_BAND = (25.0, 50.0)
MAX_AGE_DAYS = 7
CACHE_SEC = 600.0

PRIMARY_URL = "https://open.er-api.com/v6/latest/USD"
FALLBACK_URL = "https://api.frankfurter.app/latest?from=USD&to=THB"
PRIMARY_SOURCE = "open.er-api.com"
FALLBACK_SOURCE = "frankfurter.app"


@dataclass(frozen=True)
class FxQuote:
    usd_thb: float
    #: override | open.er-api.com | frankfurter.app | cost_config | default
    source: str
    #: The day a fetched rate was for (None for override / fallbacks).
    rate_date: date | None = None


def is_sane(rate: float) -> bool:
    return SANE_BAND[0] <= rate <= SANE_BAND[1]


def _parse_primary(body: Any) -> float | None:
    if not isinstance(body, dict) or body.get("result") != "success":
        return None
    rate = (body.get("rates") or {}).get("THB")
    return float(rate) if isinstance(rate, (int, float)) else None


def _parse_fallback(body: Any) -> float | None:
    if not isinstance(body, dict):
        return None
    rate = (body.get("rates") or {}).get("THB")
    return float(rate) if isinstance(rate, (int, float)) else None


async def fetch_usd_thb(client: Any = None) -> tuple[float, str] | None:
    """Fetch today's rate: primary, then fallback. None when both fail."""
    import httpx

    own = client is None
    http = client or httpx.AsyncClient(timeout=httpx.Timeout(10.0))
    try:
        for url, source, parse in (
            (PRIMARY_URL, PRIMARY_SOURCE, _parse_primary),
            (FALLBACK_URL, FALLBACK_SOURCE, _parse_fallback),
        ):
            try:
                resp = await http.get(url)
                rate = parse(resp.json()) if resp.status_code == 200 else None
            except Exception as exc:  # noqa: BLE001 — any feed failure falls through
                log.warning("fx_fetch_failed", source=source, error=str(exc)[:200])
                continue
            if rate is None:
                log.warning("fx_fetch_unusable", source=source, status=resp.status_code)
                continue
            if not is_sane(rate):
                log.warning("fx_rate_out_of_band", source=source, rate=rate, band=SANE_BAND)
                continue
            return rate, source
        return None
    finally:
        if own:
            await http.aclose()


async def refresh_fx(session: AsyncSession, client: Any = None) -> FxQuote | None:
    """Fetch and store today's rate (one row per UTC day and source)."""
    fetched = await fetch_usd_thb(client)
    if fetched is None:
        log.error("fx_refresh_failed", note="kept the last stored rate")
        return None
    rate, source = fetched
    today = datetime.now(UTC).date()
    value = Decimal(str(round(rate, 4)))
    stmt = pg_insert(FxRate).values(rate_date=today, usd_thb=value, source=source)
    stmt = stmt.on_conflict_do_update(
        constraint="uq_fx_rates_rate_date_source",
        set_={"usd_thb": value, "fetched_at": datetime.now(UTC)},
    )
    await session.execute(stmt)
    await session.commit()
    invalidate_cache()
    log.info("fx_refreshed", usd_thb=rate, source=source)
    return FxQuote(rate, source, today)


# ── override (admin) ─────────────────────────────────────────────────────────

async def load_override(session: AsyncSession) -> float | None:
    row = (
        await session.execute(select(AdminSetting).where(AdminSetting.key == OVERRIDE_KEY))
    ).scalar_one_or_none()
    if row is None or not isinstance(row.value, dict):
        return None
    value = row.value.get("usd_thb")
    return float(value) if isinstance(value, (int, float)) else None


async def save_override(session: AsyncSession, usd_thb: float | None, actor_id: int) -> None:
    """Set (or with None, clear) the override. The caller commits."""
    row = (
        await session.execute(
            select(AdminSetting).where(AdminSetting.key == OVERRIDE_KEY).with_for_update()
        )
    ).scalar_one_or_none()
    value = {"usd_thb": usd_thb}
    if row is None:
        session.add(AdminSetting(key=OVERRIDE_KEY, value=value, updated_by=actor_id))
    else:
        row.value = value
        row.updated_by = actor_id
    await session.flush()
    invalidate_cache()


# ── resolution ───────────────────────────────────────────────────────────────

_cache: tuple[float, FxQuote] | None = None


def invalidate_cache() -> None:
    global _cache
    _cache = None


async def latest_fetched(session: AsyncSession) -> FxRate | None:
    return (
        await session.execute(
            select(FxRate).order_by(FxRate.rate_date.desc(), FxRate.fetched_at.desc()).limit(1)
        )
    ).scalar_one_or_none()


async def resolve_usd_thb(session: AsyncSession, *, today: date | None = None) -> FxQuote:
    """The rate in force now (no cache) — see the module docstring for the order."""
    override = await load_override(session)
    if override is not None:
        return FxQuote(override, "override")
    today = today or datetime.now(UTC).date()
    row = await latest_fetched(session)
    if row is not None and row.rate_date >= today - timedelta(days=MAX_AGE_DAYS):
        return FxQuote(float(row.usd_thb), row.source, row.rate_date)
    from packages.admin.cost_config import load_cost_config

    try:
        config = await load_cost_config(session)
        return FxQuote(float(config.fx_rate), "cost_config")
    except Exception as exc:  # noqa: BLE001 — a bad stored config must not stop pricing
        log.warning("fx_cost_config_unreadable", error=str(exc)[:200])
    return FxQuote(DEFAULT_USD_THB, "default")


async def current_usd_thb(session: AsyncSession) -> FxQuote:
    """``resolve_usd_thb`` cached for ``CACHE_SEC`` per process."""
    global _cache
    now = time.monotonic()
    if _cache is not None and now - _cache[0] < CACHE_SEC:
        return _cache[1]
    quote = await resolve_usd_thb(session)
    _cache = (now, quote)
    return quote


async def history(session: AsyncSession, days: int = 30) -> list[dict[str, Any]]:
    since = datetime.now(UTC).date() - timedelta(days=days)
    rows = (
        await session.execute(
            select(FxRate).where(FxRate.rate_date >= since).order_by(FxRate.rate_date.desc())
        )
    ).scalars()
    return [
        {"date": r.rate_date.isoformat(), "usd_thb": float(r.usd_thb), "source": r.source}
        for r in rows
    ]
