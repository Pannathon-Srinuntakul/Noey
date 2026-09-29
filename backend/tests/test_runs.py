"""Guard layer 1: rolling windows, charge as spent, settle, refunds, slots.

Real local Postgres (packages/billing/runs.py locks ``usage_accounts`` rows,
which only a real database can prove). Accounts use the admin-tests domain
and are purged afterwards.
"""

import asyncio
import dataclasses
import math
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import text

from packages.billing import limits, plan_change, runs, wallet
from packages.billing.accounts import get_account, lock_account, set_billing_anchor
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


async def _open(user: User, tid: int, tokens: int, *, allow_wallet: bool = False, now: datetime = NOW) -> str:
    s = await _session()
    try:
        run = await runs.open_run(
            s, user=user, tenant_id=tid, estimate=_est(tokens), allow_wallet=allow_wallet, now=now
        )
        await s.commit()
        return str(run.id)
    finally:
        await s.close()


async def _spend(run_id: str, tokens: int, *, now: datetime = NOW) -> int:
    """One recorded vendor request — what metering does per usage row."""
    s = await _session()
    try:
        charged = await runs.charge_as_spent(s, run_id, tokens, now=now)
        await s.commit()
        return charged
    finally:
        await s.close()


async def _settle(run_id: str, outcome: str, *, actual: int, now: datetime = NOW) -> AiRun:
    """Spend ``actual`` the way a run really does — per recorded request — and
    then settle it."""
    if actual:
        await _spend(run_id, actual, now=now)
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


@contextmanager
def _enforcing(plan: str, windows: tuple[str, ...]):
    """Give ``plan`` those enforced windows for the duration of a test.

    No plan enforces more than one window today (limits.py rule 1), but the
    machinery still has to handle several — the sub-windows are all still
    tracked, and switching one back on must not need new code. These tests
    exercise that path; nothing in the shipped table reaches it.
    """
    old = limits.PLAN_LIMITS[plan]
    limits.PLAN_LIMITS[plan] = dataclasses.replace(old, windows=windows)
    try:
        yield
    finally:
        limits.PLAN_LIMITS[plan] = old


# ── window math (pure) ───────────────────────────────────────────────────────

def test_limits_follow_the_owner_table():
    lite_weekly = math.floor(limits.PLAN_LIMITS["lite"].monthly / limits.WEEKS_PER_MONTH)
    assert limits.window_limit("lite", "weekly") == lite_weekly
    assert limits.window_limit("lite", "five_hour") == math.floor(
        lite_weekly * limits.FIVE_HOUR_SHARE
    )
    # Free's credit is a lifetime one — the same number under either name.
    assert limits.window_limit("free", "lifetime") == limits.PLAN_LIMITS["free"].monthly
    assert limits.plan_limits("free").windows == ("lifetime",)
    assert [limits.plan_limits(p).concurrency for p in ("free", "lite", "starter", "pro", "studio", "agency", "max")] == [
        1, 1, 1, 2, 3, 4, 5,
    ]


def test_only_the_lifetime_window_never_comes_back():
    assert limits.window_resets("lifetime") is False
    assert [w for w in limits.TRACKED_WINDOWS if not limits.window_resets(w)] == ["lifetime"]
    assert all(limits.window_resets(w) for w in ("five_hour", "weekly", "monthly"))


def test_a_lifetime_window_never_rolls_over_however_long_it_waits():
    """Free's credit is spent once. A rolling window would hand it back; this
    one must still read as used a decade later."""
    acct = UsageAccount(user_id=1, reserved_tokens=0)
    runs.start_windows(acct, NOW)
    acct.lifetime_used = 40_000
    much_later = NOW + timedelta(days=365 * 10)
    assert runs.window_active(acct.lifetime_started_at, "lifetime", much_later) is True
    assert runs.window_used(acct, "lifetime", much_later) == 40_000
    # Nothing to count down to, and rolling the windows leaves it alone.
    assert runs.window_resets_at(acct, "lifetime", much_later) is None
    runs.roll_windows(acct, much_later)
    assert acct.lifetime_started_at == NOW and acct.lifetime_used == 40_000
    # The weekly window beside it did roll.
    assert acct.weekly_started_at is None and acct.weekly_used == 0


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
    with _enforcing("studio", ("weekly", "five_hour")):
        views = runs.enforced_windows("studio", acct, NOW)
        five = next(v for v in views if v.key == "five_hour")
        assert [v.key for v in views] == ["weekly", "five_hour"]
        assert five.headroom == limits.window_limit("studio", "five_hour") - 1500
        assert five.used_pct == round(1500 / five.limit * 100, 1)
        assert runs.binding_window(views).key == "five_hour"


def test_a_window_too_small_for_the_run_does_not_govern_it():
    """A 5-hour window is 40 % of the weekly one, so footage can cost more
    than it holds however empty it is. Stopping the run there would make it
    unstartable forever — the weekly window governs instead."""
    acct = UsageAccount(user_id=1, weekly_started_at=NOW, weekly_used=0, five_hour_started_at=NOW,
                        five_hour_used=0, monthly_started_at=NOW, monthly_used=0, reserved_tokens=0)
    with _enforcing("studio", ("weekly", "five_hour")):
        views = runs.enforced_windows("studio", acct, NOW)
        five = limits.window_limit("studio", "five_hour")
        week = limits.window_limit("studio", "weekly")
        small = runs.binding_window(runs.windows_for_run(views, five // 2))
        big = runs.binding_window(runs.windows_for_run(views, five + 1))
        assert small.key == "five_hour" and big.key == "weekly"
        # Past every window, the biggest one still answers (the start refused it).
        assert runs.binding_window(runs.windows_for_run(views, week * 10)).key == "weekly"
        assert runs.windows_for_run(views, 0) == views


def test_effective_plan_reads_due_changes_and_lapsed_grace():
    user = SimpleNamespace(plan="pro", is_admin=False)
    acct = UsageAccount(user_id=1, pending_plan="lite", pending_plan_at=NOW + timedelta(days=1))
    assert runs.effective_plan(user, acct, NOW) == "pro"
    assert runs.effective_plan(user, acct, NOW + timedelta(days=2)) == "lite"
    acct.grace_until = NOW - timedelta(seconds=1)
    assert runs.effective_plan(user, acct, NOW) == "free"
    assert runs.effective_plan(SimpleNamespace(plan="enterprise"), acct, NOW) == "enterprise"


# ── the monthly window follows the subscription's anniversary ────────────────

def _month(day: int | None = None, started: datetime | None = None, used: int = 0) -> UsageAccount:
    return UsageAccount(
        user_id=1, monthly_anchor_day=day, monthly_started_at=started,
        monthly_used=used, reserved_tokens=0,
    )


def test_the_month_refills_on_the_billing_day_not_30_days_after_first_use():
    """Billed on the 15th, first cut of the cycle on the 20th: the allowance
    still belongs to the 15th's period and comes back on the 15th. Under the
    old rolling rule it came back on the 20th, and a month later on the 25th."""
    acct = _month(day=15)
    first_use = datetime(2026, 3, 20, 9, 0, tzinfo=UTC)
    runs.start_windows(acct, first_use)
    assert acct.monthly_started_at == datetime(2026, 3, 15, tzinfo=UTC)
    acct.monthly_used = 500_000
    assert runs.window_resets_at(acct, "monthly", first_use) == datetime(2026, 4, 15, tzinfo=UTC)

    # A minute before the anniversary the month is still spent …
    assert runs.window_used(acct, "monthly", datetime(2026, 4, 14, 23, 59, tzinfo=UTC)) == 500_000
    # … and at 00:00 on the 15th it is empty again.
    reset = datetime(2026, 4, 15, tzinfo=UTC)
    assert runs.window_used(acct, "monthly", reset) == 0
    runs.roll_windows(acct, reset)
    assert acct.monthly_started_at is None and acct.monthly_used == 0

    # Second cycle, and it does not drift: coming back on the 28th still puts
    # the period start on the 15th and the next refill on the 15th.
    later = datetime(2026, 4, 28, tzinfo=UTC)
    runs.start_windows(acct, later)
    assert acct.monthly_started_at == datetime(2026, 4, 15, tzinfo=UTC)
    assert runs.window_resets_at(acct, "monthly", later) == datetime(2026, 5, 15, tzinfo=UTC)


def test_a_31st_anchor_keeps_the_31st_through_short_months():
    """Stripe's own rule, not an invention: a subscription anchored on the
    31st invoices on the last day of a month too short for it and goes back to
    the 31st in the next long one — the ANCHOR is kept, not where it landed."""
    at = datetime(2026, 1, 31, tzinfo=UTC)
    walk = []
    for _ in range(13):
        at = runs.period_end(at, 31)
        walk.append(at.date().isoformat())
    assert walk == [
        "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30", "2026-07-31",
        "2026-08-31", "2026-09-30", "2026-10-31", "2026-11-30", "2026-12-31",
        "2027-01-31", "2027-02-28",
    ]
    # A 30-day month: mid-April the period is the one that opened on 31 March.
    mid_april = datetime(2026, 4, 12, tzinfo=UTC)
    assert runs.period_start(mid_april, 31) == datetime(2026, 3, 31, tzinfo=UTC)
    assert runs.period_end(mid_april, 31) == datetime(2026, 4, 30, tzinfo=UTC)
    # A 28-day February, and the leap one beside it.
    assert runs.period_end(datetime(2026, 2, 5, tzinfo=UTC), 31) == datetime(2026, 2, 28, tzinfo=UTC)
    assert runs.period_end(datetime(2028, 2, 5, tzinfo=UTC), 31) == datetime(2028, 2, 29, tzinfo=UTC)
    # A month the clamp shortened is a whole period all the same.
    feb = _month(day=31, started=datetime(2026, 2, 28, tzinfo=UTC), used=700_000)
    assert runs.window_used(feb, "monthly", datetime(2026, 3, 30, tzinfo=UTC)) == 700_000
    assert runs.window_used(feb, "monthly", datetime(2026, 3, 31, tzinfo=UTC)) == 0


def test_an_account_with_no_subscription_pins_its_own_calendar_day():
    """Admin-granted, enterprise, a plan set by hand, a lapsed subscription:
    no billing date exists, so the day of the first charge becomes the
    anniversary — once. It is still a fixed date on a calendar, which is the
    whole point; it simply is not Stripe's."""
    acct = _month()
    assert runs.window_resets_at(acct, "monthly", NOW) is None  # nothing to count to yet
    runs.start_windows(acct, datetime(2026, 3, 7, 18, 30, tzinfo=UTC))
    assert acct.monthly_anchor_day == 7
    assert acct.monthly_started_at == datetime(2026, 3, 7, tzinfo=UTC)

    for opened in (datetime(2026, 4, 7, tzinfo=UTC), datetime(2026, 5, 7, tzinfo=UTC)):
        acct.monthly_used = 1_000
        runs.start_windows(acct, opened + timedelta(days=11))
        assert acct.monthly_started_at == opened and acct.monthly_anchor_day == 7
        assert acct.monthly_used == 0


def test_the_countdown_is_there_before_anything_has_been_charged():
    """The editor renders a countdown from ``resets_at``. A paid account that
    has not run anything this month still has a real date to show — the window
    belongs to the subscription, not to the usage."""
    acct = _month(day=15)
    at = datetime(2026, 3, 20, tzinfo=UTC)
    [view] = runs.enforced_windows("pro", acct, at)
    assert view.used == 0 and view.active is False
    assert view.resets_at == datetime(2026, 4, 15, tzinfo=UTC)
    assert limits.window_resets("monthly") is True


def test_a_start_left_inside_the_period_keeps_what_it_has_used():
    """What the backfill leaves behind, and what a moved anchor produces: a
    start somewhere INSIDE the current period, not exactly on it. It must read
    as the same month, never as a fresh one."""
    acct = _month(day=15, started=datetime(2026, 3, 20, tzinfo=UTC), used=123_456)
    at = datetime(2026, 4, 2, tzinfo=UTC)
    assert runs.window_used(acct, "monthly", at) == 123_456
    assert runs.window_resets_at(acct, "monthly", at) == datetime(2026, 4, 15, tzinfo=UTC)


def test_a_window_untouched_for_months_refills_once_and_starts_from_this_period():
    """Nothing runs a cron over idle accounts, so months of silence have to
    read right the first time somebody asks."""
    acct = _month(day=15, started=datetime(2026, 1, 15, tzinfo=UTC), used=700_000)
    at = datetime(2026, 6, 20, tzinfo=UTC)
    assert runs.window_used(acct, "monthly", at) == 0
    assert runs.window_resets_at(acct, "monthly", at) == datetime(2026, 7, 15, tzinfo=UTC)
    runs.start_windows(acct, at)
    # One period's worth of allowance, not five months' — and it starts at the
    # anniversary it is in, not at the day they came back.
    assert acct.monthly_started_at == datetime(2026, 6, 15, tzinfo=UTC) and acct.monthly_used == 0


def test_the_lifetime_credit_ignores_the_billing_anniversary_entirely():
    """Free's credit is spent once. Anniversaries pass it by — ``resets`` stays
    False and nothing ever hands it back."""
    acct = _month(day=15)
    runs.start_windows(acct, datetime(2026, 3, 20, tzinfo=UTC))
    acct.lifetime_used = acct.monthly_used = 40_000
    far = datetime(2027, 8, 1, tzinfo=UTC)
    assert runs.window_used(acct, "lifetime", far) == 40_000
    assert runs.window_resets_at(acct, "lifetime", far) is None
    assert limits.window_resets("lifetime") is False
    assert runs.window_used(acct, "monthly", far) == 0
    runs.roll_windows(acct, far)
    assert acct.lifetime_started_at == datetime(2026, 3, 20, tzinfo=UTC)
    assert acct.lifetime_used == 40_000 and acct.monthly_started_at is None


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


# ── open / charge as spent / settle (Postgres) ───────────────────────────────

async def test_opening_a_run_holds_nothing_and_charges_nothing():
    """The estimate is no longer reserved (owner, 2026-09-26): opening a run
    leaves the windows exactly as they were."""
    user, tid = await _user("lite")
    run_id = await _open(user, tid, 50_000)
    acct = await _account(user.id)
    assert acct.reserved_tokens == 0 and acct.weekly_used == 0
    row = await db("SELECT reserved_tokens, status FROM core.ai_runs WHERE id = :r", r=run_id)
    assert tuple(row[0]) == (0, "queued")


async def test_each_recorded_request_charges_itself_as_the_run_goes():
    """Charged per call, not at the end: a run that never settles (the worker
    died) has still paid for what it burned."""
    user, tid = await _user("lite")
    run_id = await _open(user, tid, 50_000)
    assert await _spend(run_id, 12_000) == 12_000
    acct = await _account(user.id)
    assert (acct.weekly_used, acct.five_hour_used, acct.monthly_used) == (12_000,) * 3
    assert acct.weekly_started_at == NOW  # the window starts at the first charge
    await _spend(run_id, 8_000)
    acct = await _account(user.id)
    assert acct.weekly_used == 20_000
    row = await db("SELECT actual_tokens, charged_tokens FROM core.ai_runs WHERE id = :r", r=run_id)
    assert tuple(row[0]) == (20_000, 20_000)


async def test_a_paid_plan_still_spends_its_lifetime_credit():
    """``lifetime`` is charged for every plan, not only Free. Otherwise the
    trial credit would be refilled by upgrading and coming back: subscribe for
    a month, cut on Pro's quota, cancel — and Free's untouched credit is there
    again, every month, forever."""
    user, tid = await _user("pro")
    assert "lifetime" not in limits.plan_limits("pro").windows  # not ENFORCED on Pro
    run_id = await _open(user, tid, 50_000)
    await _spend(run_id, 12_000)
    acct = await _account(user.id)
    assert acct.lifetime_used == 12_000 and acct.lifetime_started_at is not None
    # Back on Free the same credit is what the enforced window reads.
    views = runs.enforced_windows("free", acct, NOW)
    assert [v.key for v in views] == ["lifetime"] and views[0].used == 12_000


async def test_settle_trues_up_what_the_run_already_paid():
    user, tid = await _user("lite")
    run_id = await _open(user, tid, 50_000)
    run = await _settle(run_id, "ok", actual=30_000)
    assert (run.status, run.charged_tokens) == ("settled", 30_000)
    acct = await _account(user.id)
    assert (acct.weekly_used, acct.five_hour_used, acct.monthly_used) == (30_000,) * 3
    # Idempotent: a second settle changes nothing — and a usage row that
    # arrives after it (an outbox replay) is recorded but not charged again.
    await _settle(run_id, "our_failure", actual=30_000)
    assert (await _account(user.id)).weekly_used == 30_000
    row = await db("SELECT actual_tokens, charged_tokens FROM core.ai_runs WHERE id = :r", r=run_id)
    assert tuple(row[0]) == (60_000, 30_000)


async def test_our_failure_refunds_everything_and_keeps_nothing_held():
    user, tid = await _user("lite")
    run_id = await _open(user, tid, 40_000)
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
    free_fail = await _settle(await _open(user, tid, 10_000), "our_failure", actual=0)
    first = [await _settle(await _open(user, tid, 10_000), "our_failure", actual=5_000) for _ in range(2)]
    capped = await _settle(await _open(user, tid, 10_000), "our_failure", actual=50_000)
    tomorrow = await _settle(
        await _open(user, tid, 10_000, now=NOW + timedelta(days=1)), "our_failure", actual=5_000,
        now=NOW + timedelta(days=1),
    )
    assert free_fail.status == "refunded"
    assert [(r.status, r.charged_tokens) for r in first] == [("refunded", 0), ("refunded", 0)]
    assert (capped.status, capped.outcome, capped.charged_tokens) == ("settled", "our_failure", 12_000)
    assert (tomorrow.status, tomorrow.charged_tokens) == ("refunded", 0)


async def test_limit_stop_charges_at_most_the_estimate_and_refunds_the_rest():
    """A run the guard stopped pays what it burned up to the estimate — the
    overshoot it already charged per call comes back off the windows."""
    user, tid = await _user("lite")
    run_id = await _open(user, tid, 40_000)
    run = await _settle(run_id, "limit_stop", actual=47_000)
    assert (run.status, run.charged_tokens) == ("stopped", 40_000)
    assert (await _account(user.id)).weekly_used == 40_000


async def test_a_full_window_no_longer_refuses_the_start():
    """The reservation is gone: a start the estimate would have refused now
    goes ahead, and the quota snapshot is what stops it mid-run."""
    user, tid = await _user("lite")
    [key] = limits.plan_limits("lite").windows
    budget = limits.window_limit("lite", key)
    # No subscription, so the first charge pins NOW's day as the billing day.
    refills = runs.period_end(NOW, NOW.day)
    await _settle(await _open(user, tid, budget - 1_000), "ok", actual=budget - 1_000)
    later = NOW + timedelta(minutes=1)
    run_id = await _open(user, tid, 5_000, now=later)
    s = await _session()
    try:
        snap = await runs.quota_snapshot(s, run_id, now=later)
    finally:
        await s.close()
    assert snap.window == key and snap.headroom == 1_000
    assert snap.resets_at == refills
    assert snap.budget == 1_000  # no balance, no consent
    # Once the month has turned over the whole run fits again.
    s = await _session()
    try:
        rolled = await runs.quota_snapshot(s, run_id, now=refills + timedelta(seconds=1))
    finally:
        await s.close()
    assert rolled.headroom == budget


async def test_the_billing_day_is_stored_once_and_drives_the_charging_path():
    """``window_used`` runs inside the account lock and on every
    ``GET /usage/me``; neither may ask Stripe when the month started. The sync
    writes the day down, and everything else reads the row."""
    user, _ = await _user("pro")
    s = await _session()
    try:
        assert await set_billing_anchor(s, int(user.id), datetime(2026, 5, 15, 14, 32, tzinfo=UTC)) == 15
        await s.commit()
    finally:
        await s.close()
    assert (await _account(int(user.id))).monthly_anchor_day == 15

    # No date to take one from (no subscription, or one that ended) leaves the
    # stored day alone — lapsing a subscription cannot buy an extra reset.
    s = await _session()
    try:
        assert await set_billing_anchor(s, int(user.id), None) is None
        await s.commit()
    finally:
        await s.close()
    assert (await _account(int(user.id))).monthly_anchor_day == 15

    # The first charge then opens the period that CONTAINS it, not one that
    # starts at the moment of the charge.
    s = await _session()
    try:
        runs.start_windows(await lock_account(s, int(user.id)), NOW)
        await s.commit()
    finally:
        await s.close()
    acct = await _account(int(user.id))
    assert acct.monthly_started_at == runs.period_start(NOW, 15) == datetime(2026, 9, 15, tzinfo=UTC)
    assert runs.window_resets_at(acct, "monthly", NOW) == datetime(2026, 10, 15, tzinfo=UTC)


async def test_an_upgrade_mid_cycle_widens_the_month_without_restarting_it():
    """Proration buys the bigger plan for the REST of the period, not a second
    period. So what is used stays used and the reset day does not move — the
    allowance still grows, because the limit did. Emptying the window here
    would sell a whole month for a few days' proration, over and over."""
    user, tid = await _user("lite")
    spent = 400_000
    await _settle(await _open(user, tid, spent), "ok", actual=spent)
    acct = await _account(int(user.id))
    [before] = runs.enforced_windows("lite", acct, NOW)

    s = await _session()
    try:
        await plan_change.upgrade(s, await s.get(User, int(user.id)), "pro")
        await s.commit()
    finally:
        await s.close()

    acct = await _account(int(user.id))
    [after] = runs.enforced_windows("pro", acct, NOW)
    assert before.used == after.used == spent  # nothing handed back
    assert after.resets_at == before.resets_at  # the billing day did not move
    assert after.limit > before.limit and after.headroom > before.headroom
    # Every tracked window carried the charge, whatever the plan enforces.
    assert acct.weekly_used == acct.lifetime_used == spent


async def test_a_downgrade_lands_on_the_same_day_the_month_refills():
    """A downgrade applies at the end of the paid period — which is now the
    same instant the allowance comes back. Until then the paid-for tier and
    the month it paid for both stand; after it, the smaller plan starts on an
    empty month rather than inheriting a full one it cannot hold."""
    user, tid = await _user("pro")
    spent = 3_000_000
    await _settle(await _open(user, tid, spent), "ok", actual=spent)
    acct = await _account(int(user.id))
    refills = runs.window_resets_at(acct, "monthly", NOW)

    s = await _session()
    try:
        await plan_change.schedule_downgrade(s, await s.get(User, int(user.id)), "lite", refills)
        await s.commit()
    finally:
        await s.close()

    acct = await _account(int(user.id))
    eve = refills - timedelta(seconds=1)
    assert runs.effective_plan(user, acct, eve) == "pro"
    [still_pro] = runs.enforced_windows("pro", acct, eve)
    assert still_pro.used == spent and still_pro.resets_at == refills

    assert runs.effective_plan(user, acct, refills) == "lite"
    [now_lite] = runs.enforced_windows("lite", acct, refills)
    assert now_lite.limit == limits.window_limit("lite", "monthly")
    assert now_lite.used == 0 and now_lite.headroom == now_lite.limit
    # Free's trial credit is the one window a cycle never gives back.
    assert acct.lifetime_used == spent


async def test_the_quota_snapshot_adds_the_balance_only_with_consent():
    user, tid = await _user("free")
    monthly = limits.window_limit("free", "lifetime")
    s = await _session()
    await wallet.credit(s, user.id, 10_000, source="mock", now=NOW)
    await s.commit()
    await s.close()
    await _settle(await _open(user, tid, monthly), "ok", actual=monthly)
    plain = await _open(user, tid, 10_000, now=NOW + timedelta(minutes=1))
    consented = await _open(user, tid, 10_000, allow_wallet=True, now=NOW + timedelta(minutes=1))
    s = await _session()
    try:
        no_consent = await runs.quota_snapshot(s, plain, now=NOW + timedelta(minutes=1))
        with_consent = await runs.quota_snapshot(s, consented, now=NOW + timedelta(minutes=1))
    finally:
        await s.close()
    assert no_consent.budget == 0
    assert with_consent.budget == wallet.tokens_for_satang(10_000) > 0


async def test_overshoot_goes_past_100_percent():
    user, tid = await _user("lite")
    [key] = limits.plan_limits("lite").windows
    budget = limits.window_limit("lite", key)
    run_id = await _open(user, tid, budget - 10)
    await _settle(run_id, "ok", actual=budget + 5_000)  # within the ceiling (1.2 × estimate)
    acct = await _account(user.id)
    views = runs.enforced_windows("lite", acct, NOW)
    assert views[0].used == budget + 5_000 and views[0].used_pct > 100


async def test_parallel_charges_never_spend_the_same_headroom_twice():
    """The race the row lock exists for: 10 requests of one user recording at
    once must add up to exactly what they spent, never less."""
    user, tid = await _user("lite")
    weekly = limits.window_limit("lite", "weekly")
    each = weekly // 20
    ids = [await _open(user, tid, each) for _ in range(10)]
    await asyncio.gather(*(_spend(r, each) for r in ids))
    acct = await _account(user.id)
    assert acct.weekly_used == 10 * each <= weekly


async def test_the_wallet_carries_the_overflow_only_when_allowed():
    user, tid = await _user("free")
    monthly = limits.window_limit("free", "lifetime")
    s = await _session()
    await wallet.credit(s, user.id, 10_000, source="mock", now=NOW)
    await s.commit()
    await s.close()
    overflow = 30_000
    # No consent: the overflow lands on the windows (past 100 %), not on baht.
    plain = await _open(user, tid, monthly + overflow)
    await _settle(plain, "ok", actual=monthly + overflow)
    acct = await _account(user.id)
    assert acct.wallet_balance_satang == 10_000 and acct.monthly_used == monthly + overflow

    user, tid = await _user("free")
    s = await _session()
    await wallet.credit(s, user.id, 10_000, source="mock", now=NOW)
    await s.commit()
    await s.close()
    run_id = await _open(user, tid, monthly + overflow, allow_wallet=True)
    run = await _settle(run_id, "ok", actual=monthly + overflow)
    need = wallet.satang_for_tokens(overflow)
    acct = await _account(user.id)
    assert run.charged_tokens == monthly and run.charged_wallet_satang == need
    assert acct.wallet_balance_satang == 10_000 - need and acct.monthly_used == monthly
    ledger = await db("SELECT kind, amount_satang, run_id FROM core.wallet_ledger WHERE user_id = :u ORDER BY id", u=user.id)
    assert [r[0] for r in ledger] == ["purchase", "debit"] and ledger[1][1] == -need and ledger[1][2] == run_id


async def test_a_failed_wallet_run_gives_the_baht_back():
    user, tid = await _user("free")
    s = await _session()
    await wallet.credit(s, user.id, 5_000, source="mock", now=NOW)
    await s.commit()
    await s.close()
    run_id = await _open(user, tid, limits.window_limit("free", "lifetime") + 10_000, allow_wallet=True)
    await _settle(run_id, "our_failure", actual=90_000)
    acct = await _account(user.id)
    assert acct.wallet_balance_satang == 5_000 and acct.monthly_used == 0
    row = await db("SELECT charged_tokens, charged_wallet_satang FROM core.ai_runs WHERE id = :r", r=run_id)
    assert tuple(row[0]) == (0, 0)


async def test_unlimited_accounts_hold_and_pay_nothing():
    user, tid = await _user("free", admin=True)
    run_id = await _open(user, tid, 10_000_000)
    run = await _settle(run_id, "ok", actual=12_000_000)
    acct = await _account(user.id)
    assert run.unlimited is True and run.charged_tokens == 0
    assert acct.reserved_tokens == 0 and acct.monthly_used == 0


async def test_release_gives_the_hold_back():
    user, tid = await _user("lite")
    run_id = await _open(user, tid, 20_000)
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
    ids = [await _open(user, tid, 1_000) for _ in range(cap + 1)]
    got = [await _slot(r) for r in ids]
    assert got == ["run"] * cap + ["wait"]
    assert await _slot(ids[0]) == "run"  # the holder renews its lease
    await _settle(ids[0], "ok", actual=10)
    assert await _slot(ids[-1]) == "run"  # a slot freed at settle
    assert await _slot(ids[0]) == "gone"  # a closed run never works again


async def test_a_lapsed_lease_frees_the_slot_and_the_sweeper_settles_it():
    user, tid = await _user("lite")
    a = await _open(user, tid, 1_000)
    b = await _open(user, tid, 1_000)
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
    busy = await _open(user, tid, 1_000, now=base)
    waiting = await _open(user, tid, 1_000, now=base)
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
    run_id = await _open(user, tid, 10_000)
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
