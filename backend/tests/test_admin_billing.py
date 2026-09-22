# ruff: noqa: F811  (pytest fixtures imported from tests/admin_helpers.py are parameters here)
"""Admin billing: reconciliation (recorded vendor cost vs the invoice), window
resets, wallet adjustments, estimate accuracy, billing config, the circuit
breaker — all behind the admin session, all writes audited."""

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

MONTH = "2020-01"  # nothing else in the dev database lives here


async def _seed(user_id: int) -> None:
    tid = (await db("SELECT tenant_id FROM core.memberships WHERE user_id = :u", u=user_id))[0][0]
    await db(
        "INSERT INTO core.llm_usage_logs (user_id, tenant_id, feature, model, input_tokens, output_tokens, "
        "cached_tokens, status, tokens, cost_thb, created_at) VALUES "
        "(:u, :t, 'video_cut', 'gemini-3.7-flash', 1000, 100, 10, 'ok', 1553, 60.00, '2020-01-10T00:00:00Z'), "
        "(:u, :t, 'video_cut', 'gemini-3.7-flash', 500, 0, 0, 'retry', 518, 30.00, '2020-01-10T00:00:00Z'), "
        "(:u, :t, 'video_cut', 'gemini-3.7-flash', 700, 70, 0, 'ok', 0, NULL, '2020-01-11T00:00:00Z')",
        u=user_id, t=tid,
    )
    await db(
        "INSERT INTO core.stt_usage_logs (user_id, tenant_id, audio_sec, model, keyterms, tokens, cost_thb, "
        "created_at) VALUES (:u, :t, 3600, 'scribe_v2', true, 186300, 50.00, '2020-01-12T00:00:00Z')",
        u=user_id, t=tid,
    )


async def test_reconciliation_flags_a_gap_above_five_percent(mail):
    target = await make_user(email("recon"))
    await _seed(target)
    await db("DELETE FROM core.vendor_invoices WHERE month = :m", m=MONTH)
    try:
        async with client() as c:
            _, _, s = await new_admin(c, mail)
            h = bearer(s["access_token"])
            empty = (await c.get(f"/admin/reconciliation?month={MONTH}", headers=h)).json()
            g = await c.put(f"/admin/reconciliation/{MONTH}", json={"vendor": "gemini", "amount_thb": 100}, headers=h)
            e = await c.put(
                f"/admin/reconciliation/{MONTH}", json={"vendor": "elevenlabs", "amount_thb": 51, "note": "inv 7"},
                headers=h,
            )
            bad_month = await c.get("/admin/reconciliation?month=2020-13", headers=h)
            bad_vendor = await c.put(f"/admin/reconciliation/{MONTH}", json={"vendor": "aws", "amount_thb": 1}, headers=h)
            anonymous = await c.get(f"/admin/reconciliation?month={MONTH}")
    finally:
        await db("DELETE FROM core.vendor_invoices WHERE month = :m", m=MONTH)

    gem0 = next(v for v in empty["vendors"] if v["vendor"] == "gemini")
    assert gem0["invoice_thb"] is None and gem0["gap_pct"] is None and gem0["warn"] is False
    assert gem0["recorded_thb"] == 90.0 and gem0["unattributed_thb"] == 90.0
    assert gem0["unpriced_rows"] == 1 and gem0["units"]["failed_calls"] == 1
    assert gem0["units"]["input_tokens"] == 2200 and gem0["units"]["cached_tokens"] == 10

    assert g.status_code == 200 and e.status_code == 200
    vendors = {v["vendor"]: v for v in e.json()["vendors"]}
    assert vendors["gemini"]["gap_pct"] == 10.0 and vendors["gemini"]["warn"] is True
    assert vendors["elevenlabs"]["gap_pct"] == round((51 - 50) / 51 * 100, 2)
    assert vendors["elevenlabs"]["warn"] is False and vendors["elevenlabs"]["invoice_note"] == "inv 7"
    assert vendors["elevenlabs"]["units"]["audio_hours"] == 1.0
    assert bad_month.status_code == 422 and bad_vendor.status_code == 422
    assert anonymous.status_code == 401
    audit = await db(
        "SELECT detail FROM core.admin_audit_events WHERE action = 'vendor_invoice_change' "
        "ORDER BY id DESC LIMIT 2"
    )
    assert {a[0]["vendor"] for a in audit} == {"gemini", "elevenlabs"}


async def test_a_normal_user_token_cannot_reach_admin_billing(mail):
    from packages.auth.tokens import encode_access

    uid = await make_user(email("recon"))
    row = await db(
        "SELECT t.id, t.slug, u.token_version FROM core.tenants t JOIN core.memberships m "
        "ON m.tenant_id = t.id JOIN core.users u ON u.id = m.user_id WHERE m.user_id = :u",
        u=uid,
    )
    token = encode_access(uid, int(row[0][0]), str(row[0][1]), int(row[0][2]))
    async with client() as c:
        h = bearer(token)
        codes = {
            (await c.get("/admin/fx", headers=h)).status_code,
            (await c.put("/admin/fx", json={"usd_thb": 35}, headers=h)).status_code,
            (await c.post("/admin/fx/refresh", headers=h)).status_code,
            (await c.get("/admin/reconciliation", headers=h)).status_code,
            (await c.put(f"/admin/reconciliation/{MONTH}", json={"vendor": "gemini", "amount_thb": 1},
                         headers=h)).status_code,
            (await c.post(f"/admin/users/{uid}/window-reset", json={"window": "weekly"}, headers=h)).status_code,
            (await c.post(f"/admin/users/{uid}/wallet-adjust", json={"amount_satang": 100, "note": "x"},
                          headers=h)).status_code,
            (await c.get("/admin/estimate-accuracy", headers=h)).status_code,
            (await c.get("/admin/billing-config", headers=h)).status_code,
            (await c.put("/admin/billing-config", json={"sell_thb_per_1m": 1}, headers=h)).status_code,
            (await c.get("/admin/circuit-breaker", headers=h)).status_code,
            (await c.put("/admin/circuit-breaker", json={"enabled": False, "daily_cap_thb": 0},
                         headers=h)).status_code,
        }
    assert codes <= {401, 403}
    # Nothing a refused call could have changed did change.
    assert await db("SELECT 1 FROM core.wallet_lots WHERE user_id = :u", u=uid) == []


async def test_window_reset_is_per_window_and_audited(mail):
    target = await make_user(email("win"), plan="pro")
    await db(
        "INSERT INTO core.usage_accounts (user_id, five_hour_started_at, five_hour_used, weekly_started_at, "
        "weekly_used) VALUES (:u, now(), 5000, now(), 9000)",
        u=target,
    )
    async with client() as c:
        admin_id, _, s = await new_admin(c, mail)
        h = bearer(s["access_token"])
        r = await c.post(f"/admin/users/{target}/window-reset", json={"window": "five_hour"}, headers=h)
        bad = await c.post(f"/admin/users/{target}/window-reset", json={"window": "daily"}, headers=h)
        missing = await c.post("/admin/users/999999999/window-reset", json={"window": "weekly"}, headers=h)
    assert r.status_code == 200 and bad.status_code == 422 and missing.status_code == 404
    windows = {w["key"]: w for w in r.json()["windows"]}
    assert windows["five_hour"]["used_tokens"] == 0 and windows["weekly"]["used_tokens"] == 9000
    audit = await db(
        "SELECT actor_user_id, detail FROM core.admin_audit_events WHERE action = 'window_reset' AND target_user_id = :t",
        t=target,
    )
    assert audit[0][0] == admin_id and audit[0][1]["window"] == "five_hour" and audit[0][1]["before"]["used"] == 5000


async def test_wallet_adjustments_credit_and_debit_with_an_audit_trail(mail):
    target = await make_user(email("wal"))
    async with client() as c:
        _, _, s = await new_admin(c, mail)
        h = bearer(s["access_token"])
        up = await c.post(f"/admin/users/{target}/wallet-adjust", json={"amount_satang": 20_000, "note": "goodwill"},
                          headers=h)
        down = await c.post(f"/admin/users/{target}/wallet-adjust", json={"amount_satang": -50_000, "note": "fix"},
                            headers=h)
        zero = await c.post(f"/admin/users/{target}/wallet-adjust", json={"amount_satang": 0, "note": "x"}, headers=h)
        no_note = await c.post(f"/admin/users/{target}/wallet-adjust", json={"amount_satang": 5}, headers=h)
    assert up.json()["balance_satang"] == 20_000
    assert down.json()["balance_satang"] == 0  # never below zero
    assert zero.status_code == 422 and no_note.status_code == 422
    audit = await db(
        "SELECT detail FROM core.admin_audit_events WHERE action = 'wallet_adjust' AND target_user_id = :t ORDER BY id",
        t=target,
    )
    assert [a[0]["applied_satang"] for a in audit] == [20_000, -20_000]


async def test_estimate_accuracy_aggregates_closed_runs(mail):
    target = await make_user(email("acc"))
    tid = (await db("SELECT tenant_id FROM core.memberships WHERE user_id = :u", u=target))[0][0]
    for i, (est, actual, ceiling, outcome, status) in enumerate([
        (1000, 800, 1200, "ok", "settled"),
        (1000, 1300, 1200, "ok", "settled"),
        (1000, 1100, 1200, "limit_stop", "stopped"),
        (1000, 0, 1200, "our_failure", "refunded"),  # did no work: left out
    ]):
        await db(
            "INSERT INTO core.ai_runs (id, user_id, tenant_id, kind, precision, estimate_tokens, actual_tokens, "
            "ceiling_tokens, outcome, status) VALUES (:i, :u, :t, 'analyze_video', 'standard', :e, :a, :c, :o, :s)",
            i=f"{target:016d}{i:016d}", u=target, t=tid, e=est, a=actual, c=ceiling, o=outcome, s=status,
        )
    async with client() as c:
        _, _, s = await new_admin(c, mail)
        h = bearer(s["access_token"])
        r = await c.get(f"/admin/estimate-accuracy?user_id={target}", headers=h)
        detail = await c.get(f"/admin/users/{target}", headers=h)
    data = r.json()
    assert data["overall"]["runs"] == 3 and data["overall"]["median_ratio"] == 1.1
    assert data["overall"]["over_ceiling"] == 1 and data["overall"]["limit_stops"] == 1
    assert data["by_kind"][0]["kind"] == "analyze_video"
    assert len(detail.json()["runs"]) == 4
    # What the user's failed runs cost us — how the admin spots abuse.
    failed = detail.json()["failed_runs_30d"]
    assert (failed["runs"], failed["refunded_runs"], failed["charged_after_cap_runs"]) == (1, 1, 0)
    assert failed["refunded_tokens"] == 0 and failed["cost_thb"] == 0.0


async def test_billing_config_and_circuit_breaker_settings(mail):
    from packages.billing import guard

    async with client() as c:
        _, _, s = await new_admin(c, mail)
        h = bearer(s["access_token"])
        before_breaker = (await c.get("/admin/circuit-breaker", headers=h)).json()
        before_cfg = (await c.get("/admin/billing-config", headers=h)).json()
        try:
            cfg = await c.put("/admin/billing-config", json={"reference_thb_per_1m": 55, "sell_thb_per_1m": 260},
                              headers=h)
            bad_cfg = await c.put("/admin/billing-config", json={"sell_thb_per_1m": -1}, headers=h)
            brk = await c.put("/admin/circuit-breaker",
                              json={"enabled": True, "daily_cap_thb": 1234.5, "hard_stop_ratio": 1.5}, headers=h)
            bad_brk = await c.put("/admin/circuit-breaker", json={"enabled": True, "daily_cap_thb": 10,
                                                                   "hard_stop_ratio": 0.5}, headers=h)
        finally:
            await c.put("/admin/billing-config", json={k: before_cfg[k] for k in
                                                        ("reference_thb_per_1m", "sell_thb_per_1m")}, headers=h)
            await c.put("/admin/circuit-breaker", json={k: before_breaker[k] for k in
                                                         ("enabled", "daily_cap_thb", "hard_stop_ratio",
                                                          "alert_email")}, headers=h)
    assert cfg.status_code == 200 and cfg.json()["sell_thb_per_1m"] == 260
    assert cfg.json()["topup_thb_per_1m"] == 350 and cfg.json()["charged_sell_thb_per_1m"] == 250
    assert cfg.json()["rate_card"]["version"] == "v1"
    assert bad_cfg.status_code == 422 and bad_brk.status_code == 422
    assert brk.json()["daily_cap_thb"] == 1234.5 and brk.json()["hard_stop_ratio"] == 1.5
    assert "spend_today_thb" in brk.json() and "tripped" in brk.json()
    audit = await db("SELECT action FROM core.admin_audit_events WHERE action IN "
                     "('billing_config_change', 'circuit_breaker_change') ORDER BY id DESC LIMIT 4")
    assert {a[0] for a in audit} == {"billing_config_change", "circuit_breaker_change"}
    guard.invalidate_cache()


async def test_dashboard_reports_topups_and_wallet_spend_per_user(mail):
    """Paid lots in the period are top-up revenue (admin credits are not);
    run debits net of their refunds are what the balance paid for."""
    target = await make_user(email("topup"))
    await db(
        "INSERT INTO core.wallet_lots (user_id, source, amount_satang, remaining_satang, expires_at, created_at) VALUES "
        "(:u, 'stripe', 30000, 30000, '2021-01-10T00:00:00Z', '2020-01-10T05:00:00Z'), "
        "(:u, 'mock', 10000, 10000, '2021-01-10T00:00:00Z', '2020-01-11T05:00:00Z'), "
        "(:u, 'admin', 99900, 99900, '2021-01-10T00:00:00Z', '2020-01-11T05:00:00Z'), "
        "(:u, 'stripe', 50000, 50000, '2021-03-10T00:00:00Z', '2020-03-10T05:00:00Z')",
        u=target,
    )
    tid = (await db("SELECT tenant_id FROM core.memberships WHERE user_id = :u", u=target))[0][0]
    run_id = f"{target:032d}"
    await db(
        "INSERT INTO core.ai_runs (id, user_id, tenant_id, kind, estimate_tokens, status) "
        "VALUES (:i, :u, :t, 'analyze_video', 1000, 'settled')",
        i=run_id, u=target, t=tid,
    )
    await db(
        "INSERT INTO core.wallet_ledger (user_id, run_id, kind, amount_satang, balance_after_satang, created_at) VALUES "
        "(:u, :r, 'debit', -1200, 0, '2020-01-12T05:00:00Z'), (:u, :r, 'refund', 200, 0, '2020-01-12T06:00:00Z'), "
        "(:u, NULL, 'adjust', -500, 0, '2020-01-12T07:00:00Z')",
        u=target, r=run_id,
    )
    async with client() as c:
        _, _, s = await new_admin(c, mail)
        r = await c.get("/admin/dashboard?from=2020-01-01&to=2020-01-31", headers=bearer(s["access_token"]))
    row = next(u for u in r.json()["users"] if u["id"] == target)
    assert row["topup_satang"] == 40_000 and row["topups"] == 2
    assert row["wallet_spent_satang"] == 1_000
    others = [u for u in r.json()["users"] if u["id"] != target]
    assert all("topup_satang" in u for u in others)
