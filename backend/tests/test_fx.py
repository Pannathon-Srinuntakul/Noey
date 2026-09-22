# ruff: noqa: F811  (pytest fixtures imported from tests/admin_helpers.py are parameters here)
"""USD→THB: daily auto-fetch (primary → fallback), sanity band, and the
resolution order override → fetched (≤7 days) → cost config → ฿34.5.
"""

from datetime import UTC, datetime, timedelta

import httpx
import pytest

from packages.billing import fx
from packages.db.session import get_sessionmaker
from tests.admin_helpers import (  # noqa: F401  (fixtures)
    _admin_env,
    bearer,
    client,
    db,
    email,
    mail,
    make_user,
    new_admin,
)


def _transport(primary: tuple[int, object] | Exception, fallback: tuple[int, object] | Exception):
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.host)
        spec = primary if "er-api" in request.url.host else fallback
        if isinstance(spec, Exception):
            raise spec
        status, body = spec
        return httpx.Response(status, json=body)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler)), calls


async def test_primary_feed_wins():
    http, calls = _transport((200, {"result": "success", "rates": {"THB": 33.12}}), (200, {"rates": {"THB": 40}}))
    async with http:
        assert await fx.fetch_usd_thb(http) == (33.12, fx.PRIMARY_SOURCE)
    assert calls == ["open.er-api.com"]


async def test_fallback_when_primary_fails_or_is_unusable():
    for primary in (httpx.ConnectError("down"), (500, {}), (200, {"result": "error"})):
        http, calls = _transport(primary, (200, {"amount": 1, "rates": {"THB": 33.5}}))
        async with http:
            assert await fx.fetch_usd_thb(http) == (33.5, fx.FALLBACK_SOURCE)
        assert calls == ["open.er-api.com", "api.frankfurter.app"]


async def test_out_of_band_rates_are_refused():
    http, _ = _transport((200, {"result": "success", "rates": {"THB": 3.35}}), (200, {"rates": {"THB": 335}}))
    async with http:
        assert await fx.fetch_usd_thb(http) is None


async def test_both_feeds_down_returns_none():
    http, _ = _transport(httpx.ConnectError("x"), httpx.ReadTimeout("y"))
    async with http:
        assert await fx.fetch_usd_thb(http) is None


@pytest.fixture
async def clean_fx():
    """Isolate the shared fx state (override + rows) and restore it afterwards."""
    saved_override = await db("SELECT value FROM core.admin_settings WHERE key = 'fx_override'")
    await db("DELETE FROM core.admin_settings WHERE key = 'fx_override'")
    saved_rows = await db("SELECT rate_date, usd_thb, source, fetched_at FROM core.fx_rates")
    await db("DELETE FROM core.fx_rates")
    fx.invalidate_cache()
    yield
    await db("DELETE FROM core.fx_rates")
    for r in saved_rows:
        await db(
            "INSERT INTO core.fx_rates (rate_date, usd_thb, source, fetched_at) VALUES (:d, :u, :s, :f)",
            d=r[0], u=r[1], s=r[2], f=r[3],
        )
    await db("DELETE FROM core.admin_settings WHERE key = 'fx_override'")
    if saved_override:
        import json

        await db(
            "INSERT INTO core.admin_settings (key, value) VALUES ('fx_override', CAST(:v AS jsonb))",
            v=json.dumps(saved_override[0][0]),
        )
    fx.invalidate_cache()


async def _resolve():
    async with get_sessionmaker()() as session:
        return await fx.resolve_usd_thb(session)


async def test_resolution_order(clean_fx):
    # Nothing fetched, no override → the cost config's manual rate.
    first = await _resolve()
    assert first.source in {"cost_config", "default"} and first.usd_thb > 0

    # A fetched rate from the last 7 days wins over the config.
    await db(
        "INSERT INTO core.fx_rates (rate_date, usd_thb, source) VALUES (:d, 33.4, 'open.er-api.com')",
        d=datetime.now(UTC).date() - timedelta(days=2),
    )
    fetched = await _resolve()
    assert (fetched.usd_thb, fetched.source) == (33.4, "open.er-api.com")

    # The admin override wins over everything.
    await db("INSERT INTO core.admin_settings (key, value) VALUES ('fx_override', '{\"usd_thb\": 36.0}')")
    assert (await _resolve()).usd_thb == 36.0 and (await _resolve()).source == "override"


async def test_a_stale_fetch_is_not_used(clean_fx):
    await db(
        "INSERT INTO core.fx_rates (rate_date, usd_thb, source) VALUES (:d, 30.0, 'open.er-api.com')",
        d=datetime.now(UTC).date() - timedelta(days=fx.MAX_AGE_DAYS + 1),
    )
    assert (await _resolve()).source != "open.er-api.com"


async def test_refresh_stores_one_row_per_day_and_source(clean_fx):
    http, _ = _transport((200, {"result": "success", "rates": {"THB": 33.0}}), (500, {}))
    async with http, get_sessionmaker()() as session:
        await fx.refresh_fx(session, http)
        http2, _ = _transport((200, {"result": "success", "rates": {"THB": 33.25}}), (500, {}))
        async with http2:
            await fx.refresh_fx(session, http2)
    rows = await db("SELECT usd_thb, source FROM core.fx_rates")
    assert [(float(r[0]), r[1]) for r in rows] == [(33.25, "open.er-api.com")]


async def test_admin_fx_override_is_audited_and_guarded(mail, clean_fx):
    async with client() as c:
        _, _, s = await new_admin(c, mail)
        h = bearer(s["access_token"])
        put = await c.put("/admin/fx", json={"usd_thb": 35.25}, headers=h)
        view = await c.get("/admin/fx", headers=h)
        absurd = await c.put("/admin/fx", json={"usd_thb": 3.5}, headers=h)
        cleared = await c.put("/admin/fx", json={"usd_thb": None}, headers=h)
        anonymous = await c.get("/admin/fx")
    assert put.status_code == 200 and put.json()["source"] == "override"
    assert view.json()["usd_thb"] == 35.25 and view.json()["override"] == 35.25
    assert absurd.status_code == 422
    assert cleared.status_code == 200 and cleared.json()["override"] is None
    assert anonymous.status_code == 401
    audit = await db(
        "SELECT detail FROM core.admin_audit_events WHERE action = 'fx_override_change' ORDER BY id DESC LIMIT 2"
    )
    assert {a[0]["after"] for a in audit} == {35.25, None}
