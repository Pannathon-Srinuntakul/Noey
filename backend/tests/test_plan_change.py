"""Plan changes by the owner's rules, independent of Stripe
(packages/billing/plan_change.py): upgrade now, downgrade / cancel at period
end, a 3-day grace after a failed payment, enterprise never touched."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import text

from packages.billing import plan_change, runs
from packages.billing.accounts import get_account
from packages.db.models.core_auth import User
from packages.db.session import get_sessionmaker
from tests.admin_helpers import _admin_env, email, make_user  # noqa: F401

NOW = datetime(2026, 9, 22, 12, 0, tzinfo=UTC)
PERIOD_END = NOW + timedelta(days=20)


async def _with_user(plan: str, fn):
    """Run ``fn(session, user)`` on a fresh account, commit, return the user's
    plan and usage-account row."""
    uid = await make_user(email("plans"), plan=plan)
    return uid, await _run(uid, fn)


async def _run(uid: int, fn):
    async with get_sessionmaker()() as s:
        await s.execute(text("SET search_path TO core, public"))
        user = await s.get(User, uid)
        await fn(s, user)
        await s.commit()
        user = await s.get(User, uid, populate_existing=True)
        return str(user.plan), await get_account(s, uid)


async def test_an_upgrade_takes_effect_now():
    _, (plan, acct) = await _with_user("lite", lambda s, u: plan_change.upgrade(s, u, "pro"))
    assert plan == "pro" and acct.pending_plan is None


async def test_a_downgrade_waits_for_the_period_to_end():
    uid, (plan, acct) = await _with_user(
        "pro", lambda s, u: plan_change.schedule_downgrade(s, u, "lite", PERIOD_END)
    )
    assert plan == "pro" and (acct.pending_plan, acct.pending_plan_at) == ("lite", PERIOD_END)
    user = await _user(uid)
    assert runs.effective_plan(user, acct, PERIOD_END - timedelta(seconds=1)) == "pro"
    assert runs.effective_plan(user, acct, PERIOD_END) == "lite"  # limits never lag the rule
    changed = await _apply(PERIOD_END - timedelta(hours=1))
    assert (await _user(uid)).plan == "pro"
    changed = await _apply(PERIOD_END + timedelta(minutes=1))
    assert changed >= 1 and (await _user(uid)).plan == "lite"


async def test_cancel_keeps_the_tier_until_period_end_then_free_and_resume_undoes_it():
    uid, (plan, acct) = await _with_user("studio", lambda s, u: plan_change.schedule_cancel(s, u, PERIOD_END))
    assert plan == "studio" and acct.pending_plan == "free"
    _, acct = await _run(uid, lambda s, u: plan_change.resume(s, u))
    assert acct.pending_plan is None
    await _run(uid, lambda s, u: plan_change.schedule_cancel(s, u, PERIOD_END))
    await _apply(PERIOD_END + timedelta(seconds=1))
    assert (await _user(uid)).plan == "free"


async def test_a_failed_payment_gets_three_days_then_free():
    uid, (plan, acct) = await _with_user("pro", lambda s, u: plan_change.payment_failed(s, u, NOW))
    assert plan == "pro" and acct.grace_until == NOW + timedelta(days=3)
    # A second failure does not extend the grace.
    _, acct = await _run(uid, lambda s, u: plan_change.payment_failed(s, u, NOW + timedelta(days=1)))
    assert acct.grace_until == NOW + timedelta(days=3)
    await _apply(NOW + timedelta(days=2))
    assert (await _user(uid)).plan == "pro"
    await _apply(NOW + timedelta(days=3, seconds=1))
    assert (await _user(uid)).plan == "free"


async def test_a_recovered_payment_clears_the_grace():
    uid, _ = await _with_user("pro", lambda s, u: plan_change.payment_failed(s, u, NOW))
    _, acct = await _run(uid, lambda s, u: plan_change.payment_recovered(s, u))
    assert acct.grace_until is None


async def test_enterprise_is_never_touched():
    uid, (plan, _) = await _with_user("enterprise", lambda s, u: plan_change.upgrade(s, u, "lite"))
    assert plan == "enterprise"
    await _run(uid, lambda s, u: plan_change.schedule_cancel(s, u, NOW))
    await _run(uid, lambda s, u: plan_change.payment_failed(s, u, NOW - timedelta(days=9)))
    await _apply(NOW + timedelta(days=30))
    assert (await _user(uid)).plan == "enterprise"


async def test_mirroring_a_subscription_follows_the_same_rules():
    async def mirror(target, status="active", ending=False, now=NOW):
        async def fn(s, u):
            await plan_change.mirror_subscription(
                s, u, target, status=status, period_end=PERIOD_END, ending=ending, now=now
            )
        return fn

    uid, (plan, _) = await _with_user("free", await mirror("starter"))
    assert plan == "starter"  # a new subscription: immediate
    plan, acct = await _run(uid, await mirror("lite"))
    assert plan == "starter" and acct.pending_plan == "lite"  # downgrade: next cycle
    plan, acct = await _run(uid, await mirror("starter"))
    assert plan == "starter" and acct.pending_plan is None  # changed back before the cycle ended
    plan, acct = await _run(uid, await mirror("starter", ending=True))
    assert plan == "starter" and acct.pending_plan == "free"  # cancel at period end
    plan, acct = await _run(uid, await mirror("starter", status="past_due"))
    assert plan == "starter" and acct.grace_until is not None and acct.pending_plan is None
    plan, _ = await _run(uid, await mirror("starter", status="past_due", now=NOW + timedelta(days=4)))
    assert plan == "free"  # the grace ran out while the provider still says past_due
    plan, acct = await _run(uid, await mirror("free", status="canceled"))
    assert plan == "free" and acct.grace_until is None


async def _user(uid: int) -> User:
    async with get_sessionmaker()() as s:
        await s.execute(text("SET search_path TO core, public"))
        user = await s.get(User, uid)
        s.expunge(user)
        return user


async def _apply(now: datetime) -> int:
    async with get_sessionmaker()() as s:
        await s.execute(text("SET search_path TO core, public"))
        changed = await plan_change.apply_due(s, now)
        await s.commit()
        return changed

