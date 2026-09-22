"""Guard layer 1: rolling windows, reservation, settle, refunds, slots.

Real local Postgres (packages/billing/runs.py locks ``usage_accounts`` rows,
which only a real database can prove). Accounts use the admin-tests domain
and are purged afterwards.
"""

import asyncio
import math
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import text

from packages.billing import limits, runs, wallet
from packages.billing.accounts import get_account, lock_account
from packages.billing.estimate import Estimate
from packages.db.models.ai_run import AiRun
from packages.db.models.core_auth import User
from packages.db.models.usage_account import UsageAccount
from packages.db.session import get_sessionmaker
from tests.admin_helpers import _admin_env, db, email, make_user  # noqa: F401  (fixture)

NOW = datetime(2026, 9, 22, 12, 0, tzinfo=UTC)


def _est(tokens: int, kind: str = "analyze_video") -> Estimate:
    return Estimate(tokens=tokens, ceiling=math.ceil(tokens * 1.2), media_sec=30.0, kind=kind, model="gemini-3.7-flash")


async def _session():
    session = get_sessionmaker()()
    await session.execute(text("SET search_path TO core, public"))
    return session


async def _user(plan: str = "lite", **kw) -> tuple[User, int]:
    uid = await make_user(email("runs"), plan=plan, **kw)
    tid = (await db("SELECT tenant_id FROM core.memberships WHERE user_id = :u", u=uid))[0][0]
    async with get_sessionmaker()() as s:
        await s.execute(text("SET search_path TO core, public"))
        user = await s.get(User, uid)
        s.expunge(user)
    return user, int(tid)


async def _reserve(user: User, tid: int, tokens: int, *, allow_wallet: bool = False, now: datetime = NOW) -> str:
    s = await _session()
    try:
        run = await runs.reserve(s, user=user, tenant_id=tid, estimate=_est(tokens), allow_wallet=allow_wallet, now=now)
        await s.commit()
        return str(run.id)
    finally:
        await s.close()


async def _settle(run_id: str, outcome: str, *, actual: int, now: datetime = NOW) -> AiRun:
    await db("UPDATE core.ai_runs SET actual_tokens = :a WHERE id = :r", a=actual, r=run_id)
    s = await _session()
    try:
        run = await runs.settle(s, run_id, outcome, now=now)
        await s.commit()
        return run
    finally:
        await s.close()


async def _account(user_id: int) -> UsageAccount:
    s = await _session()
    try:
        return await get_account(s, user_id)
    finally:
        await s.close()


# ── window math (pure) ───────────────────────────────────────────────────────

def test_limits_follow_the_owner_table():
    assert limits.window_limit("lite", "weekly") == math.floor(800_000 / 4.33)
    assert limits.window_limit("pro", "five_hour") == math.floor(math.floor(4_000_000 / 4.33) * 0.4)
    assert limits.window_limit("free", "monthly") == 100_000
    assert [limits.plan_limits(p).concurrency for p in ("free", "lite", "starter", "pro", "studio", "agency", "max")] == [
        1, 1, 1, 2, 3, 4, 5,
    ]


def test_a_window_is_rolling_and_starts_at_first_use():
    acct = UsageAccount(user_id=1, weekly_started_at=None, weekly_used=0, five_hour_started_at=None,
                        five_hour_used=0, monthly_started_at=None, monthly_used=0, reserved_tokens=0)
    assert runs.window_resets_at(acct, "weekly", NOW) is None  # "resets 7 d after next use"
    runs.start_windows(acct, NOW)
    assert runs.window_resets_at(acct, "weekly", NOW) == NOW + timedelta(days=7)
    assert runs.window_resets_at(acct, "five_hour", NOW) == NOW + timedelta(hours=5)
    acct.five_hour_used = 900
    assert runs.window_used(acct, "five_hour", NOW + timedelta(hours=4, minutes=59)) == 900
    later = NOW + timedelta(hours=5)
    assert runs.window_used(acct, "five_hour", later) == 0  # ran out → unused
    runs.roll_windows(acct, later)
    assert acct.five_hour_started_at is None and acct.weekly_started_at == NOW


def test_reservations_count_against_every_enforced_window():
    acct = UsageAccount(user_id=1, weekly_started_at=NOW, weekly_used=1000, five_hour_started_at=NOW,
                        five_hour_used=1000, monthly_started_at=NOW, monthly_used=1000, reserved_tokens=500)
    views = runs.enforced_windows("pro", acct, NOW)
    assert [v.key for v in views] == ["weekly", "five_hour"]
    five = next(v for v in views if v.key == "five_hour")
    assert five.headroom == limits.window_limit("pro", "five_hour") - 1500
    assert five.used_pct == round(1500 / five.limit * 100, 1)
    assert runs.binding_window(views).key == "five_hour"


def test_effective_plan_reads_due_changes_and_lapsed_grace():
    user = SimpleNamespace(plan="pro", is_admin=False)
    acct = UsageAccount(user_id=1, pending_plan="lite", pending_plan_at=NOW + timedelta(days=1))
    assert runs.effective_plan(user, acct, NOW) == "pro"
    assert runs.effective_plan(user, acct, NOW + timedelta(days=2)) == "lite"
    acct.grace_until = NOW - timedelta(seconds=1)
    assert runs.effective_plan(user, acct, NOW) == "free"
    assert runs.effective_plan(SimpleNamespace(plan="enterprise"), acct, NOW) == "enterprise"


def test_charge_table():
    run = AiRun(actual_tokens=900, ceiling_tokens=600, estimate_tokens=500)
    assert runs.charge_for(run, "ok") == 600  # capped at the ceiling
    assert runs.charge_for(run, "user_cancel") == 600
    assert runs.charge_for(run, "user_error") == 600
    assert runs.charge_for(run, "limit_stop") == 500  # never more than the reservation
    assert runs.charge_for(run, "our_failure") == 0
    assert runs.charge_for(run, "orphaned") == 0
    small = AiRun(actual_tokens=100, ceiling_tokens=600, estimate_tokens=500)
    assert runs.charge_for(small, "ok") == 100 and runs.charge_for(small, "limit_stop") == 100


# ── reserve / settle (Postgres) ──────────────────────────────────────────────

async def test_reserve_holds_the_estimate_and_settle_charges_actual():
    user, tid = await _user("lite")
    run_id = await _reserve(user, tid, 50_000)
    acct = await _account(user.id)
    assert acct.reserved_tokens == 50_000 and acct.weekly_started_at == NOW
    run = await _settle(run_id, "ok", actual=30_000)
    assert (run.status, run.charged_tokens) == ("settled", 30_000)
    acct = await _account(user.id)
    assert acct.reserved_tokens == 0
    assert (acct.weekly_used, acct.five_hour_used, acct.monthly_used) == (30_000, 30_000, 30_000)
    # Idempotent: a second settle changes nothing.
    await _settle(run_id, "our_failure", actual=30_000)
    assert (await _account(user.id)).weekly_used == 30_000


async def test_our_failure_refunds_everything_and_keeps_nothing_held():
    user, tid = await _user("lite")
    run_id = await _reserve(user, tid, 40_000)
    run = await _settle(run_id, "our_failure", actual=25_000)
    acct = await _account(user.id)
    assert (run.status, run.outcome, run.charged_tokens) == ("refunded", "our_failure", 0)
    assert acct.reserved_tokens == 0 and acct.weekly_used == 0


async def test_refunds_are_capped_per_day_then_failures_are_charged(monkeypatch):
    """A failure we cannot tell from input the user controls must not be free
    to repeat: past the day's refund allowance a failed run is charged what
    it used (capped at its ceiling) — and a run that burned nothing never
    counts towards the allowance."""
    from packages.core.settings import get_settings

    monkeypatch.setenv("BILLING_FREE_REFUNDS_PER_DAY", "2")
    get_settings.cache_clear()
    user, tid = await _user("pro")
    free_fail = await _settle(await _reserve(user, tid, 10_000), "our_failure", actual=0)
    first = [await _settle(await _reserve(user, tid, 10_000), "our_failure", actual=5_000) for _ in range(2)]
    capped = await _settle(await _reserve(user, tid, 10_000), "our_failure", actual=50_000)
    tomorrow = await _settle(
        await _reserve(user, tid, 10_000, now=NOW + timedelta(days=1)), "our_failure", actual=5_000,
        now=NOW + timedelta(days=1),
    )
    assert free_fail.status == "refunded"
    assert [(r.status, r.charged_tokens) for r in first] == [("refunded", 0), ("refunded", 0)]
    assert (capped.status, capped.outcome, capped.charged_tokens) == ("settled", "our_failure", 12_000)
    assert (tomorrow.status, tomorrow.charged_tokens) == ("refunded", 0)


async def test_limit_stop_charges_at_most_the_reservation():
    user, tid = await _user("lite")
    run_id = await _reserve(user, tid, 40_000)
    run = await _settle(run_id, "limit_stop", actual=47_000)
    assert (run.status, run.charged_tokens) == ("stopped", 40_000)
    assert (await _account(user.id)).weekly_used == 40_000


async def test_a_run_that_does_not_fit_is_refused_with_the_binding_window():
    user, tid = await _user("pro")
    five = limits.window_limit("pro", "five_hour")
    first = await _reserve(user, tid, five - 1_000)
    await _settle(first, "ok", actual=five - 1_000)
    with pytest.raises(runs.LimitReached) as exc:
        await _reserve(user, tid, 5_000, now=NOW + timedelta(minutes=1))
    assert exc.value.window == "five_hour"
    assert exc.value.resets_at == NOW + timedelta(hours=5)
    assert exc.value.wallet_can_cover is False and exc.value.wallet_need_satang == wallet.satang_for_tokens(4_000)
    # Five hours later the window has rolled: the same run fits.
    await _reserve(user, tid, 5_000, now=NOW + timedelta(hours=5, seconds=1))


async def test_overshoot_goes_past_100_percent():
    user, tid = await _user("lite")
    weekly = limits.window_limit("lite", "weekly")
    run_id = await _reserve(user, tid, weekly - 10)
    await _settle(run_id, "ok", actual=weekly + 5_000)  # within the ceiling (1.2 × estimate)
    acct = await _account(user.id)
    views = runs.enforced_windows("lite", acct, NOW)
    assert views[0].used == weekly + 5_000 and views[0].used_pct > 100


async def test_parallel_reservations_never_spend_the_same_headroom():
    """The race the row lock exists for: 10 starts at once on a Lite account
    whose Weekly limit fits exactly three of them."""
    user, tid = await _user("lite")
    weekly = limits.window_limit("lite", "weekly")
    each = weekly // 3 - 1

    async def attempt() -> bool:
        try:
            await _reserve(user, tid, each)
            return True
        except runs.LimitReached:
            return False

    results = await asyncio.gather(*(attempt() for _ in range(10)))
    acct = await _account(user.id)
    assert results.count(True) == 3
    assert acct.reserved_tokens == 3 * each <= weekly
    held = await db("SELECT count(*) FROM core.ai_runs WHERE user_id = :u AND status = 'queued'", u=user.id)
    assert held[0][0] == 3


async def test_the_wallet_covers_the_overflow_only_when_allowed():
    user, tid = await _user("free")
    monthly = limits.window_limit("free", "monthly")
    s = await _session()
    await wallet.credit(s, user.id, 10_000, source="mock", now=NOW)
    await s.commit()
    await s.close()
    overflow = 30_000
    with pytest.raises(runs.LimitReached) as exc:
        await _reserve(user, tid, monthly + overflow)
    assert exc.value.wallet_can_cover is True
    run_id = await _reserve(user, tid, monthly + overflow, allow_wallet=True)
    acct = await _account(user.id)
    need = wallet.satang_for_tokens(overflow)
    assert acct.reserved_tokens == monthly and acct.wallet_reserved_satang == need
    run = await _settle(run_id, "ok", actual=monthly + overflow)
    acct = await _account(user.id)
    assert run.charged_tokens == monthly and run.charged_wallet_satang == need
    assert acct.wallet_reserved_satang == 0 and acct.wallet_balance_satang == 10_000 - need
    ledger = await db("SELECT kind, amount_satang, run_id FROM core.wallet_ledger WHERE user_id = :u ORDER BY id", u=user.id)
    assert [r[0] for r in ledger] == ["purchase", "debit"] and ledger[1][1] == -need and ledger[1][2] == run_id


async def test_a_failed_wallet_run_takes_no_baht():
    user, tid = await _user("free")
    s = await _session()
    await wallet.credit(s, user.id, 5_000, source="mock", now=NOW)
    await s.commit()
    await s.close()
    run_id = await _reserve(user, tid, limits.window_limit("free", "monthly") + 10_000, allow_wallet=True)
    await _settle(run_id, "our_failure", actual=90_000)
    acct = await _account(user.id)
    assert acct.wallet_balance_satang == 5_000 and acct.wallet_reserved_satang == 0 and acct.monthly_used == 0


async def test_unlimited_accounts_hold_and_pay_nothing():
    user, tid = await _user("free", admin=True)
    run_id = await _reserve(user, tid, 10_000_000)
    run = await _settle(run_id, "ok", actual=12_000_000)
    acct = await _account(user.id)
    assert run.unlimited is True and run.charged_tokens == 0
    assert acct.reserved_tokens == 0 and acct.monthly_used == 0


async def test_release_gives_the_hold_back():
    user, tid = await _user("lite")
    run_id = await _reserve(user, tid, 20_000)
    s = await _session()
    await runs.release(s, run_id)
    await s.commit()
    await s.close()
    assert (await _account(user.id)).reserved_tokens == 0
    status = await db("SELECT status FROM core.ai_runs WHERE id = :r", r=run_id)
    assert status[0][0] == "released"


# ── concurrency slots ────────────────────────────────────────────────────────

async def _slot(run_id: str, now: datetime = NOW) -> str:
    s = await _session()
    try:
        out = await runs.acquire_slot(s, run_id, now=now)
        await s.commit()
        return out
    finally:
        await s.close()


@pytest.mark.parametrize(("plan", "cap"), [("lite", 1), ("pro", 2)])
async def test_the_plan_caps_concurrent_runs(plan, cap):
    user, tid = await _user(plan)
    ids = [await _reserve(user, tid, 1_000) for _ in range(cap + 1)]
    got = [await _slot(r) for r in ids]
    assert got == ["run"] * cap + ["wait"]
    assert await _slot(ids[0]) == "run"  # the holder renews its lease
    await _settle(ids[0], "ok", actual=10)
    assert await _slot(ids[-1]) == "run"  # a slot freed at settle
    assert await _slot(ids[0]) == "gone"  # a closed run never works again


async def test_a_lapsed_lease_frees_the_slot_and_the_sweeper_settles_it():
    user, tid = await _user("lite")
    a = await _reserve(user, tid, 1_000)
    b = await _reserve(user, tid, 1_000)
    assert await _slot(a) == "run" and await _slot(b) == "wait"
    later = NOW + runs.LEASE + timedelta(seconds=1)
    assert await _slot(b, now=later) == "run"  # a's worker died
    s = await _session()
    swept = await runs.sweep_orphans(s, now=later + runs.ORPHAN_GRACE)
    await s.commit()
    await s.close()
    assert swept >= 1
    row = await db("SELECT status, outcome, charged_tokens FROM core.ai_runs WHERE id = :r", r=a)
    assert tuple(row[0]) == ("refunded", "orphaned", 0)


async def test_a_run_still_waiting_for_a_slot_is_not_swept():
    """Waiting is not orphaned: each retry renews the queued run's lease, so a
    long queue (or a 1-slot plan with a big batch) survives past 4 h."""
    # Years back: the sweeper is global, and this must not touch the dev
    # database's own open runs.
    base = NOW - timedelta(days=3650)
    user, tid = await _user("lite")
    busy = await _reserve(user, tid, 1_000, now=base)
    waiting = await _reserve(user, tid, 1_000, now=base)
    assert await _slot(busy, now=base) == "run"
    much_later = base + runs.QUEUED_MAX_AGE + timedelta(minutes=5)
    assert await _slot(busy, now=much_later) == "run"  # still working, lease renewed
    assert await _slot(waiting, now=much_later) == "wait"  # still asking
    s = await _session()
    await runs.sweep_orphans(s, now=much_later + timedelta(minutes=1))
    await s.commit()
    await s.close()
    row = await db("SELECT status FROM core.ai_runs WHERE id = :r", r=waiting)
    assert row[0][0] == "queued"
    # Nobody asked for it again within the grace: now it is orphaned.
    s = await _session()
    await runs.sweep_orphans(s, now=much_later + runs.LEASE + runs.ORPHAN_GRACE + timedelta(minutes=1))
    await s.commit()
    await s.close()
    row = await db("SELECT status, outcome FROM core.ai_runs WHERE id = :r", r=waiting)
    assert tuple(row[0]) == ("refunded", "orphaned")


async def test_admin_window_reset_clears_one_window():
    user, tid = await _user("pro")
    run_id = await _reserve(user, tid, 10_000)
    await _settle(run_id, "ok", actual=10_000)
    s = await _session()
    before = await runs.reset_windows(s, user.id, ("five_hour",))
    await s.commit()
    await s.close()
    acct = await _account(user.id)
    assert before["five_hour"]["used"] == 10_000
    assert acct.five_hour_used == 0 and acct.five_hour_started_at is None and acct.weekly_used == 10_000


async def test_lock_account_creates_the_row_once():
    user, _ = await _user("lite")
    s = await _session()
    a = await lock_account(s, user.id)
    b = await lock_account(s, user.id)
    await s.commit()
    await s.close()
    assert a is b
    n = await db("SELECT count(*) FROM core.usage_accounts WHERE user_id = :u", u=user.id)
    assert n[0][0] == 1
