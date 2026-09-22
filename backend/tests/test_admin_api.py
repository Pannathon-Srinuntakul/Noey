# ruff: noqa: F811  (pytest fixtures imported from tests/admin_helpers.py are parameters here)
"""Admin dashboard behaviour: the facts it reports, and that its actions reach
the same state the web editor and the marketing site read (users.plan,
usage_reset_at, is_active/token_version, GET /billing/plans).
"""

import uuid
from types import SimpleNamespace

from packages.admin import pricing
from packages.auth.tokens import encode_access
from packages.billing import catalog, service
from services.api.main import app
from services.api.routers import admin as admin_router
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


async def _tenant(user_id: int) -> tuple[int, str]:
    row = await db(
        "SELECT t.id, t.slug FROM core.tenants t JOIN core.memberships m ON m.tenant_id = t.id WHERE m.user_id = :u",
        u=user_id,
    )
    return int(row[0][0]), str(row[0][1])


async def _user_token(user_id: int) -> str:
    tid, slug = await _tenant(user_id)
    tv = (await db("SELECT token_version FROM core.users WHERE id = :u", u=user_id))[0][0]
    return encode_access(user_id, tid, slug, int(tv))


async def _seed_usage(user_id: int) -> str:
    tid, slug = await _tenant(user_id)
    uid = str(uuid.uuid4())
    await db(
        "INSERT INTO core.llm_usage_logs (user_id, tenant_id, feature, reference_id, model, input_tokens, output_tokens) "
        "VALUES (:u, :t, 'video_cut', :r, 'gemini/gemini-3.7-flash', 1000, 200), "
        "(:u, :t, 'video_effects', :r, 'gemini-3.1-pro-preview', 3000, 100)",
        u=user_id, t=tid, r=uid,
    )
    await db(
        "INSERT INTO core.stt_usage_logs (user_id, tenant_id, reference_id, audio_sec, model) "
        "VALUES (:u, :t, :r, 90, 'scribe_v2')",
        u=user_id, t=tid, r=uid,
    )
    await db(
        "INSERT INTO tenant_default.video_projects (uid, user_id, tenant_slug, mode, status, engine, precision, brief, local_meta) "
        "VALUES (:a, :u, :s, 'dub_first', 'done', 'pro', 'high', 'รีวิวรองเท้า\nบรรทัดสอง', "
        "'{\"clips\": [{\"id\": \"c1\", \"durationSec\": 30.5}, {\"id\": \"c2\", \"durationSec\": 12}]}'::jsonb), "
        "(:b, :u, :s, 'talking_head', 'error', 'lite', 'standard', NULL, NULL)",
        a=uid, b=str(uuid.uuid4()), u=user_id, s=slug,
    )
    return uid


async def _cleanup_projects(user_id: int) -> None:
    await db("DELETE FROM tenant_default.video_projects WHERE user_id = :u", u=user_id)


async def test_dashboard_reports_real_usage_facts(mail):
    async with client() as c:
        _, _, s = await new_admin(c, mail)
        target = await make_user(email("creator"), plan="starter")
        project = await _seed_usage(target)
        try:
            r = await c.get("/admin/dashboard", headers=bearer(s["access_token"]))
            detail = await c.get(f"/admin/users/{target}", headers=bearer(s["access_token"]))
        finally:
            await _cleanup_projects(target)
    assert r.status_code == 200, r.text
    data = r.json()
    me = next(u for u in data["users"] if u["id"] == target)
    assert me["plan"] == "starter" and me["internal"] is False
    assert {(t["model"], t["feature"]) for t in me["tokens"]} == {
        ("gemini-3.7-flash", "video_cut"),
        ("gemini-3.1-pro-preview", "video_effects"),
    }
    assert me["stt"] == [{"model": "scribe_v2", "seconds": 90.0}]
    assert (me["clips"], me["failed"], me["projects"]) == (1, 1, 2)
    assert me["engine_pro_pct"] == 50.0 and me["precision_high_pct"] == 50.0
    assert me["last_active_days"] == 0
    assert me["quota_used_tokens"] == 4300 and me["quota_used_pct"] is not None
    assert data["period"]["days"] == 30
    assert "gemini-3.7-flash" in data["model_defaults"]
    assert data["cost_config"]["fx_rate"] > 0
    assert set(data["prices"]["satang"]) == {p.tier for p in catalog.PAID_PLANS}
    # The chart always spans 30 days and splits customers from internal accounts.
    assert any(b["key"] == data["today"] and b["clips"] >= 1 and not b["internal"] for b in data["daily"])

    jobs = detail.json()["jobs"]
    first = next(j for j in jobs if j["uid"] == project)
    assert first["name"] == "รีวิวรองเท้า" and first["footage_sec"] == 42.5
    assert {t["feature"] for t in first["tokens"]} == {"video_cut", "video_effects"}


async def test_dashboard_rejects_a_bad_period(mail):
    async with client() as c:
        _, _, s = await new_admin(c, mail)
        backwards = await c.get("/admin/dashboard?from=2026-09-10&to=2026-09-01", headers=bearer(s["access_token"]))
        too_long = await c.get("/admin/dashboard?from=2024-01-01&to=2026-09-01", headers=bearer(s["access_token"]))
    assert backwards.status_code == 422 and too_long.status_code == 422


async def test_plan_change_is_what_the_web_app_reads_and_is_audited(mail):
    async with client() as c:
        admin_id, _, s = await new_admin(c, mail)
        target = await make_user(email("creator"))
        r = await c.patch(f"/admin/users/{target}/plan", json={"plan": "pro"}, headers=bearer(s["access_token"]))
        usage = await c.get("/usage/me", headers=bearer(await _user_token(target)))
        bad = await c.patch(f"/admin/users/{target}/plan", json={"plan": "platinum"}, headers=bearer(s["access_token"]))
        missing = await c.patch("/admin/users/999999999/plan", json={"plan": "pro"}, headers=bearer(s["access_token"]))
    assert r.status_code == 200 and r.json()["plan"] == "pro"
    assert usage.json()["plan"] == "pro"
    assert bad.status_code == 422 and missing.status_code == 404
    audit = await db(
        "SELECT actor_user_id, detail FROM core.admin_audit_events WHERE action = 'plan_change' AND target_user_id = :t",
        t=target,
    )
    assert audit[0][0] == admin_id
    assert audit[0][1]["before"] == "free" and audit[0][1]["after"] == "pro"


async def test_quota_reset_moves_the_web_apps_quota_window(mail):
    async with client() as c:
        _, _, s = await new_admin(c, mail)
        target = await make_user(email("creator"))
        await _seed_usage(target)
        try:
            token = await _user_token(target)
            before = (await c.get("/usage/me", headers=bearer(token))).json()["used_tokens"]
            r = await c.post(f"/admin/users/{target}/quota-reset", headers=bearer(s["access_token"]))
            after = (await c.get("/usage/me", headers=bearer(token))).json()["used_tokens"]
        finally:
            await _cleanup_projects(target)
    assert before == 4300 and r.status_code == 200 and after == 0
    assert await db("SELECT 1 FROM core.admin_audit_events WHERE action = 'quota_reset' AND target_user_id = :t", t=target)


async def test_deactivation_signs_the_user_out_of_the_web_app_and_back(mail):
    async with client() as c:
        _, _, s = await new_admin(c, mail)
        target = await make_user(email("creator"))
        token = await _user_token(target)
        assert (await c.get("/auth/me", headers=bearer(token))).status_code == 200
        off = await c.patch(f"/admin/users/{target}/active", json={"active": False}, headers=bearer(s["access_token"]))
        after = await c.get("/auth/me", headers=bearer(token))
        on = await c.patch(f"/admin/users/{target}/active", json={"active": True}, headers=bearer(s["access_token"]))
        old_token_again = await c.get("/auth/me", headers=bearer(token))
        fresh = await c.get("/auth/me", headers=bearer(await _user_token(target)))
    assert off.status_code == 200 and off.json()["active"] is False
    assert after.status_code == 401
    assert on.status_code == 200
    assert old_token_again.status_code == 401  # revoked for good, not just while inactive
    assert fresh.status_code == 200
    rows = await db(
        "SELECT action, detail FROM core.admin_audit_events WHERE target_user_id = :t ORDER BY id", t=target
    )
    assert [r[0] for r in rows] == ["account_deactivate", "account_activate"]
    assert rows[0][1] == {"before": True, "after": False}


async def test_an_admin_cannot_deactivate_themself(mail):
    async with client() as c:
        admin_id, _, s = await new_admin(c, mail)
        r = await c.patch(f"/admin/users/{admin_id}/active", json={"active": False}, headers=bearer(s["access_token"]))
        still = await c.get("/admin/auth/me", headers=bearer(s["access_token"]))
    assert r.status_code == 409 and still.status_code == 200


async def test_deactivating_another_admin_ends_their_admin_session(mail):
    async with client() as c:
        _, _, s = await new_admin(c, mail)
        other_id, _, other = await new_admin(c, mail, remember=True)
        r = await c.patch(f"/admin/users/{other_id}/active", json={"active": False}, headers=bearer(s["access_token"]))
        theirs = await c.get("/admin/auth/me", headers=bearer(other["access_token"]))
    assert r.status_code == 200 and theirs.status_code == 401
    devices = await db("SELECT revoked_at FROM core.admin_devices WHERE user_id = :u", u=other_id)
    assert devices and all(d[0] is not None for d in devices)


async def test_cost_config_round_trip_validation_and_audit(mail):
    async with client() as c:
        _, _, s = await new_admin(c, mail)
        h = bearer(s["access_token"])
        original = (await c.get("/admin/cost-config", headers=h)).json()
        try:
            changed = dict(original, fx_rate=36.0)
            put = await c.put("/admin/cost-config", json=changed, headers=h)
            again = (await c.get("/admin/cost-config", headers=h)).json()
            negative = await c.put("/admin/cost-config", json=dict(original, fx_rate=-1), headers=h)
            dup = dict(original, fixed=[{"id": "a", "label": "x", "value": 1}, {"id": "a", "label": "y", "value": 2}])
            duplicate_ids = await c.put("/admin/cost-config", json=dup, headers=h)
            huge = dict(original, fixed=[{"id": f"f{i}", "label": "x", "value": 1} for i in range(41)])
            too_many = await c.put("/admin/cost-config", json=huge, headers=h)
            injected = dict(original, models={"bad model id; drop": {"input": 1, "output": 1}})
            bad_key = await c.put("/admin/cost-config", json=injected, headers=h)
        finally:
            await c.put("/admin/cost-config", json=original, headers=h)
    assert put.status_code == 200 and again["fx_rate"] == 36.0
    assert {negative.status_code, duplicate_ids.status_code, too_many.status_code, bad_key.status_code} == {422}
    rows = await db(
        "SELECT detail FROM core.admin_audit_events WHERE action = 'cost_config_change' ORDER BY id DESC LIMIT 2"
    )
    assert any(r[0]["after"]["fx_rate"] == 36.0 and r[0]["before"]["fx_rate"] == original["fx_rate"] for r in rows)


async def test_price_edit_without_stripe_reaches_the_public_price_list(mail):
    before = await db("SELECT tier, unit_amount FROM core.plan_price_overrides")
    async with client() as c:
        _, _, s = await new_admin(c, mail)
        h = bearer(s["access_token"])
        try:
            r = await c.put("/admin/plan-prices", json={"prices": {"starter": 315}}, headers=h)
            public = await c.get("/billing/plans")
            free = await c.put("/admin/plan-prices", json={"prices": {"free": 10}}, headers=h)
            zero = await c.put("/admin/plan-prices", json={"prices": {"pro": 0}}, headers=h)
            huge = await c.put("/admin/plan-prices", json={"prices": {"pro": 10_000_000}}, headers=h)
        finally:
            await db("DELETE FROM core.plan_price_overrides")
            for tier, amount in before:
                await db("INSERT INTO core.plan_price_overrides (tier, unit_amount) VALUES (:t, :a)", t=tier, a=amount)
            service.reset_plans_cache()
    assert r.status_code == 200 and r.json()["changed"] == ["starter"]
    starter = next(p for p in public.json()["plans"] if p["tier"] == "starter")
    assert starter["unit_amount"] == 31_500 and public.json()["source"] == "mock"
    assert {free.status_code, zero.status_code, huge.status_code} == {422}
    audit = await db("SELECT detail FROM core.admin_audit_events WHERE action = 'price_change' ORDER BY id DESC LIMIT 1")
    assert audit[0][0]["tier"] == "starter" and audit[0][0]["after"] == 31_500 and audit[0][0]["source"] == "local"


class _Page(SimpleNamespace):
    pass


class FakeStripe:
    """Just enough of the async StripeClient for a price replacement."""

    def __init__(self) -> None:
        self.prices = {
            p.lookup_key: SimpleNamespace(id=f"price_old_{p.tier}", lookup_key=p.lookup_key, unit_amount=p.mock_unit_amount,
                                          currency="thb", recurring=SimpleNamespace(interval="month"), active=True)
            for p in catalog.PAID_PLANS
        }
        self.created: list[dict] = []
        self.archived: list[str] = []
        self.portal_updates: list[dict] = []
        outer = self

        class Prices:
            async def list_async(self, params):  # type: ignore[no-untyped-def]
                keys = params["lookup_keys"]
                return _Page(data=[outer.prices[k] for k in keys if k in outer.prices])

            async def create_async(self, params):  # type: ignore[no-untyped-def]
                outer.created.append(params)
                new = SimpleNamespace(id=f"price_new_{len(outer.created)}", lookup_key=params["lookup_key"],
                                      unit_amount=params["unit_amount"], currency="thb",
                                      recurring=SimpleNamespace(interval="month"), active=True)
                outer.prices[params["lookup_key"]] = new
                return new

            async def update_async(self, price_id, params):  # type: ignore[no-untyped-def]
                outer.archived.append(price_id)

        class Configs:
            async def list_async(self, params):  # type: ignore[no-untyped-def]
                return _Page(data=[SimpleNamespace(id="bpc_1", metadata={"managed_by": "noey_stripe_seed"})])

            async def update_async(self, config_id, params):  # type: ignore[no-untyped-def]
                outer.portal_updates.append({"id": config_id, **params})

        self.v1 = SimpleNamespace(prices=Prices(), billing_portal=SimpleNamespace(configurations=Configs()))


async def test_price_edit_with_stripe_replaces_the_price_and_relists_the_portal(mail):
    fake = FakeStripe()
    app.dependency_overrides[admin_router._optional_stripe] = lambda: fake
    before = await db("SELECT tier, unit_amount FROM core.plan_price_overrides")
    try:
        async with client() as c:
            _, _, s = await new_admin(c, mail)
            r = await c.put("/admin/plan-prices", json={"prices": {"pro": 1090}}, headers=bearer(s["access_token"]))
    finally:
        app.dependency_overrides.pop(admin_router._optional_stripe, None)
        await db("DELETE FROM core.plan_price_overrides")
        for tier, amount in before:
            await db("INSERT INTO core.plan_price_overrides (tier, unit_amount) VALUES (:t, :a)", t=tier, a=amount)
        service.reset_plans_cache()
    assert r.status_code == 200, r.text
    assert fake.created[0]["unit_amount"] == 109_000
    assert fake.created[0]["transfer_lookup_key"] is True and fake.created[0]["lookup_key"] == "noey_pro_monthly"
    assert fake.archived == ["price_old_pro"]  # archived, never deleted: subscribers keep their price
    listed = fake.portal_updates[0]["features"]["subscription_update"]["products"]
    assert {"product": "noey_pro", "prices": [fake.prices["noey_pro_monthly"].id]} in listed
    assert r.json()["satang"]["pro"] == 109_000
    assert pricing.MAX_PRICE_THB == 100_000
