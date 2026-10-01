"""Paid runs: rolling windows, charge as spent, settle at end, slots.

Guard layer 1 of docs/token-billing-plan.md §4, and the state behind
``GET /usage/me`` (docs/token-billing-design.md §4, §6.1, §10).

Windows (``core.usage_accounts``). A plan ENFORCES some windows
(limits.PLAN_LIMITS) but all four are TRACKED: every charge adds to all of
them. There are two kinds:

**``monthly`` — the calendar window every paid plan enforces.** It runs from
one billing anniversary to the next: 00:00 UTC on ``monthly_anchor_day`` of
each month, the day the subscription actually renews. It used to be a rolling
30 days from first use, which drifted away from the invoice — a customer
billed on the 15th whose first cut landed on the 12th got a fresh allowance on
the 12th, three days before paying for it, and further adrift every month.
Now the answer to "when does my quota come back?" is a date the customer
already knows. ``monthly_started_at`` holds the START of the current period
(the last anniversary), so the window is active while that start is still the
current period's; the length of a month is never assumed — a 31st anchor lands
on the 28th/29th/30th in a month too short for it and returns to the 31st in
the next long one, which is Stripe's own rule, not an invention.

**The rolling sub-windows** (``five_hour``, ``weekly``) keep the old rule —
active while ``now < started_at + length``, restarting at the next charge — and
``lifetime`` never runs out at all. ``weekly`` is ENFORCED on Pro and up
beside ``monthly`` (owner, 2026-10-01 — 40 % of the month, rolling 7 days
from the first charge after the last week ran out; see limits.py rule 1);
``five_hour`` is recorded only.

The anchor (``usage_accounts.monthly_anchor_day``) is stored, never fetched:
``window_used`` / ``window_resets_at`` run on every ``GET /usage/me`` and
inside the account lock, and neither may call Stripe. The Stripe sync keeps it
fresh (packages/billing/service.py); an account with no subscription at all —
admin-granted, enterprise, a plan set by hand — pins it once to the day of its
first charge, so it too resets on a fixed calendar date.

**No reservation (owner, 2026-09-26).** A start used to hold the whole
server-side estimate up front, which refused work that would have fitted: the
estimate reserves ~104 k where a real cut spends ~70 k, so a user with 90 k
left was refused a job they could afford. Nothing is held any more.
``open_run`` only opens the row; the ONE thing still checked before starting
is impossibility — a run that cannot fit an enforced window even when that
window is empty (``plan_features.check_run_size``), or footage longer than a
single request can carry (``limits.video_call_footage_sec``). Neither waiting
for a reset nor topping up would make those work.

Charged as spent. Every recorded vendor request charges its own rate-card
tokens, in the transaction that writes the usage row
(``packages/billing/metering.py`` → ``charge_as_spent``): on the windows up
to the headroom, then — only with the user's consent at start — on the top-up
balance. The run carries what it may take from the balance in
``ai_runs.reserved_wallet_satang``: with nothing reserved any more, that
column now means "satang this run is allowed to spend", not "satang held".

Out of quota mid-run. ``guard`` carries a ``QuotaSnapshot`` taken when the
task starts and stops the run before the call that would go past it
(``QuotaExhausted``) — a PAUSE, not a crash: the project keeps everything it
has produced and resumes from the same stage once the window rolls or the
balance is used.

Settle (``settle``) charges the DIFFERENCE between what the outcome says the
user owes and what the run already paid as it went, and refunds the rest:

    ok / user_cancel / user_error   min(actual, ceiling)
    limit_stop (guard layer 2)      min(actual, estimate)
    our_failure / orphaned          0 — the vendor cost stays on our books

Refund cap: a user's first ``settings.billing_free_refunds_per_day``
``our_failure`` runs of a UTC day that burned vendor tokens are refunded in
full; past that, a failed run is charged ``min(actual, ceiling)`` like an ok
one (status ``settled``, outcome still ``our_failure``). A failure we cannot
tell apart from input the user controls — a timeout on an oversized file,
a vendor error the file provokes — must not be repeatable for free until the
global circuit breaker pauses the service for everyone. Every refund is
logged (``run_refunded``) with what it cost us, and the admin sees the 30-day
per-user total (packages/admin/accuracy.py:refunded_summary).

Unlimited accounts (admin / enterprise) are charged nothing; their runs and
usage rows are still recorded.

Concurrency. A worker task takes a SLOT before its first model call
(``acquire_slot``): at most ``limits.concurrency_for`` runs per user are
``running`` with a live lease. The lease is renewed while the task runs and
lapses after ``LEASE`` if the worker dies; ``sweep_orphans`` settles those.
"""

from __future__ import annotations

import calendar
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from packages.billing import limits as limits_mod
from packages.billing import wallet
from packages.billing.accounts import get_account, lock_account
from packages.billing.estimate import Estimate
from packages.core.logging import get_logger
from packages.db.models.ai_run import AiRun
from packages.db.models.core_auth import User
from packages.db.models.usage_account import UsageAccount

log = get_logger(__name__)

LEASE = timedelta(minutes=10)
#: A running run whose lease lapsed this long ago is orphaned (worker died).
ORPHAN_GRACE = timedelta(minutes=10)
#: A queued run older than this never got a worker (arq's job_timeout is 3 h).
QUEUED_MAX_AGE = timedelta(hours=4)

Outcome = Literal[
    "ok", "limit_stop", "our_failure", "user_cancel", "user_error", "orphaned", "safety_cap",
]
OUTCOMES: frozenset[str] = frozenset(
    {"ok", "limit_stop", "our_failure", "user_cancel", "user_error", "orphaned", "safety_cap"}
)
#: Outcomes the user is not charged for (subject to the daily refund cap).
REFUNDED_OUTCOMES: frozenset[str] = frozenset({"our_failure", "orphaned"})
#: The run status each outcome settles into. ``limit_stop`` is the run that
#: PAUSED on the plan's quota (the project goes to ``paused_quota`` and a NEW
#: run resumes it); ``safety_cap`` is a required answer that hit the per-call
#: safety cap (guard.OutputTruncated) — billed like any call, owner
#: 2026-10-01, and the project is left in a retryable error.
_STATUS_FOR: dict[str, str] = {
    "ok": "settled",
    "user_error": "settled",
    "safety_cap": "settled",
    "user_cancel": "cancelled",
    "limit_stop": "stopped",
    "our_failure": "refunded",
    "orphaned": "refunded",
}
OPEN_STATUSES = ("queued", "running")
SlotResult = Literal["run", "wait", "gone"]


def _now() -> datetime:
    return datetime.now(UTC)


def iso(value: datetime | None) -> str | None:
    """UTC ISO-8601 with ``Z`` — what every billing endpoint returns; the
    browser formats it in the viewer's own timezone."""
    if value is None:
        return None
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


# A start used to raise ``LimitReached`` here when the estimate did not fit.
# Nothing reserves any more, so nothing refuses a start on quota: the run is
# stopped mid-way instead, by ``guard.QuotaExhausted``, which carries the same
# window / reset time / wallet figures.


# ── window math ──────────────────────────────────────────────────────────────

#: The one window that follows the subscription's calendar instead of a length.
ANNIVERSARY_WINDOW = "monthly"


def _started(account: UsageAccount | None, key: str) -> datetime | None:
    return getattr(account, f"{key}_started_at", None) if account is not None else None


def _used_raw(account: UsageAccount | None, key: str) -> int:
    return int(getattr(account, f"{key}_used", 0) or 0) if account is not None else 0


# ── the billing anniversary ──────────────────────────────────────────────────

def _anniversary(year: int, month: int, day: int) -> datetime:
    """00:00 UTC on ``day`` of ``month``, clamped to the month's last day.

    ``month`` may be 0 or 13: it rolls into the neighbouring year. Clamping is
    Stripe's rule for a subscription anchored past the end of a short month —
    the 31st invoices on the 28th in February and goes back to the 31st in
    March, because the ANCHOR is kept, not the date it landed on.
    """
    year, month = year + (month - 1) // 12, (month - 1) % 12 + 1
    last = calendar.monthrange(year, month)[1]
    return datetime(year, month, min(max(day, 1), last), tzinfo=UTC)


def period_start(now: datetime, anchor_day: int) -> datetime:
    """The most recent billing anniversary at or before ``now``."""
    at = now.astimezone(UTC)
    this = _anniversary(at.year, at.month, anchor_day)
    return this if this <= at else _anniversary(at.year, at.month - 1, anchor_day)


def period_end(now: datetime, anchor_day: int) -> datetime:
    """The next billing anniversary strictly after ``now`` — the moment the
    allowance refills, and what the editor counts down to."""
    at = now.astimezone(UTC)
    this = _anniversary(at.year, at.month, anchor_day)
    return this if this > at else _anniversary(at.year, at.month + 1, anchor_day)


def anchor_day(account: UsageAccount | None) -> int | None:
    """The day of the month this account's allowance refills on.

    The stored anchor (the subscription's, or the day of the account's first
    charge) first; failing that, the day the current period was stamped on,
    which is the same number for every row written since. None only for an
    account that has never been charged and never had a subscription — there
    is nothing to count down to yet, and the window reads as unused anyway.
    """
    if account is None:
        return None
    stored = getattr(account, "monthly_anchor_day", None)
    if stored:
        return min(max(int(stored), 1), 31)
    started = _started(account, ANNIVERSARY_WINDOW)
    return started.astimezone(UTC).day if started is not None else None


def window_active(
    started_at: datetime | None, key: str, now: datetime, anchor: int | None = None
) -> bool:
    if started_at is None:
        return False
    if key == ANNIVERSARY_WINDOW and anchor:
        # Still inside the period it was stamped for. ``>=`` rather than ``==``
        # on purpose: a start somewhere INSIDE the current period (a row the
        # backfill re-anchored, an anchor the subscription moved a few days
        # later in the same month) keeps counting rather than handing out a
        # second allowance.
        return started_at.astimezone(UTC) >= period_start(now, anchor)
    length = limits_mod.WINDOW_SECONDS[key]
    if length is None:
        return True  # ``lifetime``: started once, never runs out
    return now < started_at + timedelta(seconds=length)


def window_used(account: UsageAccount | None, key: str, now: datetime) -> int:
    """Charged tokens in the window — 0 once it has run out."""
    active = window_active(_started(account, key), key, now, anchor_day(account))
    return _used_raw(account, key) if active else 0


def window_resets_at(account: UsageAccount | None, key: str, now: datetime) -> datetime | None:
    """When the window refills. None for ``lifetime``, which never comes back.

    ``monthly`` answers with the real next anniversary whether or not anything
    has been charged yet — the date is the subscription's, not the usage's, and
    the editor renders a countdown from it. A rolling sub-window still answers
    None while it is inactive ("5 h after next use").
    """
    started = _started(account, key)
    length = limits_mod.WINDOW_SECONDS[key]
    if length is None:
        return None
    if key == ANNIVERSARY_WINDOW:
        day = anchor_day(account)
        return period_end(now, day) if day else None
    if not window_active(started, key, now):
        return None
    assert started is not None
    return started + timedelta(seconds=length)


def roll_windows(account: UsageAccount, now: datetime) -> None:
    """Clear every window that has run out (it restarts at the next use)."""
    day = anchor_day(account)
    for key in limits_mod.TRACKED_WINDOWS:
        started = _started(account, key)
        if started is not None and not window_active(started, key, now, day):
            setattr(account, f"{key}_started_at", None)
            setattr(account, f"{key}_used", 0)


def start_windows(account: UsageAccount, now: datetime) -> None:
    """Start every inactive window — "first use" for the rolling ones, the
    current billing period for ``monthly``.

    ``monthly`` is stamped with the period's START, not with ``now``, so a
    first cut on the 20th of a cycle anchored to the 15th still runs out on the
    15th. An account with no anchor yet (no subscription: admin-granted,
    enterprise, a plan set by hand) pins today's day-of-month as its anchor
    here — once, and never again, so it too has a fixed calendar date.
    """
    roll_windows(account, now)
    day = anchor_day(account) or now.astimezone(UTC).day
    if not getattr(account, "monthly_anchor_day", None):
        account.monthly_anchor_day = day
    for key in limits_mod.TRACKED_WINDOWS:
        if _started(account, key) is None:
            at = period_start(now, day) if key == ANNIVERSARY_WINDOW else now
            setattr(account, f"{key}_started_at", at)
            setattr(account, f"{key}_used", 0)


def effective_plan(user: Any, account: UsageAccount | None, now: datetime) -> str:
    """The plan the limits come from right now.

    A payment-failed grace that has lapsed reads as Free, and a scheduled
    downgrade/cancel that is due reads as its target — even before the hourly
    ``plan_change.apply_due`` cron has written it to ``users.plan``.
    """
    plan = str(getattr(user, "plan", None) or "free")
    if plan in limits_mod.UNLIMITED_PLANS:
        return plan
    if account is not None:
        if account.grace_until is not None and account.grace_until <= now:
            return "free"
        if account.pending_plan and account.pending_plan_at is not None and account.pending_plan_at <= now:
            return account.pending_plan
    return plan


@dataclass(frozen=True)
class WindowView:
    key: str
    limit: int
    used: int
    reserved: int
    resets_at: datetime | None
    active: bool

    @property
    def headroom(self) -> int:
        return self.limit - self.used - self.reserved

    @property
    def used_pct(self) -> float:
        if self.limit <= 0:
            return 100.0
        return round((self.used + self.reserved) / self.limit * 100, 1)


# ── the carried overage (owner, 2026-10-01) ──────────────────────────────────
#
# A call in flight when the window reaches 100 % is charged in full, so a
# window can end above 100 %. The excess (``usage_accounts.overage_tokens``,
# charged past ``overage_window``) is not billed as money and not forgotten:
#
# * the next period of that window STARTS at it — 106 % ends a month, the next
#   month opens at 6 %;
# * Free's ``lifetime`` never resets, so its overage waits for an upgrade and
#   opens the first paid window; if the user never upgrades we absorb it;
# * a cancellation or downgrade to Free does NOT drop it (owner, 2026-10-01):
#   it stays on the account, dormant, and opens the first paid window if the
#   user subscribes again — it is never billed as money;
# * a run the user let spend the top-up balance pays its excess from there
#   and carries nothing (``apply_charge``).
#
# Views add a pending carry to the window it will open (``carry_target``);
# charging paths make it real under the account lock (``apply_carry``).


def _overage(account: UsageAccount | None) -> tuple[str | None, int]:
    if account is None:
        return None, 0
    return getattr(account, "overage_window", None), int(getattr(account, "overage_tokens", 0) or 0)


def _carry_destination(account: UsageAccount | None, plan: str) -> tuple[str, int] | None:
    """Which enforced window the MAIN overage belongs to on ``plan`` and how
    much — None when there is none, or while it is DORMANT: a paid window's
    overage on an account that is on Free now waits for the next
    subscription instead of being charged against the trial credit. (The
    weekly window's own overage is ``_weekly_carry``.)"""
    src, tokens = _overage(account)
    primary = limits_mod.primary_window(plan)
    if tokens <= 0 or not src or primary is None:
        return None
    if src == primary:
        return src, tokens
    if primary == "lifetime":
        return None  # dormant on Free
    # Free → paid (or a paid window the new plan does not enforce): it opens
    # the plan's main paid window.
    return primary, tokens


def _weekly_overage(account: UsageAccount | None) -> int:
    return int(getattr(account, "weekly_overage_tokens", 0) or 0) if account is not None else 0


def _weekly_carry(account: UsageAccount | None, plan: str, now: datetime) -> int:
    """The weekly overage a VIEW must add to the weekly window right now: only
    on a plan that enforces it, and only while the week it was charged in has
    run out and the next has not started (inside a running week the excess
    is simply part of that week's own usage)."""
    tokens = _weekly_overage(account)
    if tokens <= 0 or not limits_mod.enforces_weekly(plan):
        return 0
    if window_active(_started(account, "weekly"), "weekly", now):
        return 0
    return tokens


def carry_target(account: UsageAccount | None, plan: str, now: datetime) -> tuple[str, int] | None:
    """The carry a VIEW must add right now: the window it will open and the
    amount — only while that window has not started its new period yet (once
    it has, ``apply_carry`` already put the carry inside its ``used``; and
    while the window it was charged past is still running, the overage is
    simply part of that window's own usage)."""
    dest = _carry_destination(account, plan)
    if dest is None:
        return None
    key, tokens = dest
    if window_active(_started(account, key), key, now, anchor_day(account)):
        return None
    return key, tokens


def apply_carry(account: UsageAccount, plan: str, now: datetime) -> None:
    """Make the carried overage real (the caller holds the account lock and
    has rolled the windows): open the window it belongs to at that amount.
    A dormant overage (``_carry_destination`` None) is left alone.
    Idempotent."""
    _apply_weekly_carry(account, plan, now)
    src, tokens = _overage(account)
    if tokens <= 0:
        return
    dest = _carry_destination(account, plan)
    if dest is None:
        return
    key, _ = dest
    day = anchor_day(account)
    if window_active(_started(account, key), key, now, day):
        if key != src:
            # Free → paid inside a period that is already running: every
            # tracked window was charged alongside ``lifetime``, so this one
            # already holds the overage. Counted once, not twice.
            _clear_overage(account)
        return
    if key == ANNIVERSARY_WINDOW:
        day = day or now.astimezone(UTC).day
        if not getattr(account, "monthly_anchor_day", None):
            account.monthly_anchor_day = day
        at = period_start(now, day)
    else:
        at = now
    setattr(account, f"{key}_started_at", at)
    setattr(account, f"{key}_used", tokens)
    log.info("overage_carried", user_id=int(account.user_id), window=key, source=src, tokens=tokens)
    _clear_overage(account)


def _apply_weekly_carry(account: UsageAccount, plan: str, now: datetime) -> None:
    """The weekly half of ``apply_carry``: a week that ended past 100 % opens
    the next week at the excess (rolling — the new week starts now, at the
    charge that opened it). The month is NOT charged again: every token in it
    was already counted there when it was spent. On a plan without a weekly
    window the excess means nothing and is dropped — it was a pace limit,
    never a debt."""
    tokens = _weekly_overage(account)
    if tokens <= 0:
        return
    if not limits_mod.enforces_weekly(plan):
        account.weekly_overage_tokens = 0
        return
    if window_active(_started(account, "weekly"), "weekly", now):
        return
    account.weekly_started_at = now
    account.weekly_used = tokens
    account.weekly_overage_tokens = 0
    log.info("overage_carried", user_id=int(account.user_id), window="weekly", source="weekly", tokens=tokens)


def _clear_overage(account: UsageAccount) -> None:
    account.overage_tokens = 0
    account.overage_window = None


def restart_paid_windows(account: UsageAccount, now: datetime, anchor: datetime | None = None) -> None:
    """A NEW billing cycle starts now (owner, 2026-10-01): Free → paid, or an
    upgrade, which Stripe bills as a fresh cycle from today
    (``billing_cycle_anchor=now``, the unused part of the old plan credited).

    The paid windows restart at 0 and the month is re-anchored on today:
    ``monthly`` / ``weekly`` / ``five_hour``. What was used before — the trial
    credit's ordinary usage, or the old plan's month — never counts against
    the plan just paid for (the bug: 419k of trial usage showed up as 52 % of
    a fresh Lite month). ``lifetime`` is untouched: a later return to Free
    must not refill the trial credit.

    Carried OVERAGE still carries: what a window was charged PAST 100 % opens
    the new period — the main window's (``overage_tokens``; for Free that is
    usage past the trial credit) the month, the week's the week. The caller
    holds the account lock. ``anchor`` — the provider's new billing-cycle
    anchor (its day of the month is the new reset day); ``now`` without one."""
    day = (anchor or now).astimezone(UTC).day
    account.monthly_anchor_day = day
    account.monthly_started_at = period_start(now, day)
    account.monthly_used = max(0, int(account.overage_tokens or 0))
    account.weekly_started_at = now
    account.weekly_used = _weekly_overage(account)
    account.five_hour_started_at = None
    account.five_hour_used = 0
    carried = (int(account.monthly_used or 0), int(account.weekly_used or 0))
    _clear_overage(account)
    account.weekly_overage_tokens = 0
    log.info(
        "paid_windows_restarted", user_id=int(account.user_id), anchor_day=day,
        carried_month=carried[0], carried_week=carried[1],
    )


def enforced_windows(plan: str, account: UsageAccount | None, now: datetime) -> list[WindowView]:
    reserved = int(account.reserved_tokens or 0) if account is not None else 0
    day = anchor_day(account)
    carry = carry_target(account, plan, now)
    out = []
    for key in limits_mod.plan_limits(plan).windows:
        started = _started(account, key)
        used = window_used(account, key, now)
        if carry is not None and carry[0] == key:
            used += carry[1]
        if key == "weekly":
            used += _weekly_carry(account, plan, now)
        out.append(
            WindowView(
                key=key,
                limit=limits_mod.window_limit(plan, key),
                used=used,
                reserved=reserved,
                resets_at=window_resets_at(account, key, now),
                active=window_active(started, key, now, day),
            )
        )
    return out


def binding_window(views: list[WindowView]) -> WindowView | None:
    """The window with the least headroom (the one a charge fills first)."""
    return min(views, key=lambda v: v.headroom) if views else None


def windows_for_run(views: list[WindowView], estimate_tokens: int) -> list[WindowView]:
    """The windows that may govern a run of this size.

    A window SMALLER than the run itself can never contain it — Pro's 5-hour
    window is 40 % of its weekly one, so an hour of footage costs more than a
    5-hour window holds however empty it is. Letting that window stop the run
    would make it unstartable forever, and waiting would not help. The plan's
    own answer to a started run that outgrows a window is to let it finish and
    count the overshoot (docs/token-billing-plan.md §2), so such a window is
    left out here and the next one up governs. A run too big for EVERY window
    never starts at all (plan_features.check_run_size).
    """
    if estimate_tokens <= 0 or not views:
        return views
    fit = [v for v in views if v.limit >= estimate_tokens]
    return fit or [max(views, key=lambda v: v.limit)]


@dataclass(frozen=True)
class QuotaSnapshot:
    """What a run may still spend, read once when its task starts.

    The worker decrements it locally as the run spends (guard.RunMeter), so
    the mid-run check costs no query per call. A snapshot can go stale — a
    parallel run of the same user spending at the same time — which only means
    the pause comes one call late; the windows themselves are charged under
    the account lock and can never be double-spent.
    """

    window: str | None
    headroom: int
    resets_at: datetime | None
    #: Spendable top-up balance, in satang.
    wallet_satang: int
    #: Satang this run is allowed to take from it (0 = no consent given).
    wallet_allowance: int
    unlimited: bool = False

    @property
    def budget(self) -> int:
        """Rate-card tokens the run may still spend, balance included."""
        allowed = min(self.wallet_satang, self.wallet_allowance)
        return max(0, self.headroom) + wallet.tokens_for_satang(allowed)


async def quota_snapshot(
    session: AsyncSession, run_id: str, now: datetime | None = None
) -> QuotaSnapshot | None:
    """``run_id``'s remaining quota right now. None when there is nothing to
    stop at (unlimited account, or the run is gone)."""
    at = now or _now()
    run = await session.get(AiRun, run_id)
    if run is None:
        return None
    if run.unlimited:
        return QuotaSnapshot(
            window=None, headroom=0, resets_at=None, wallet_satang=0,
            wallet_allowance=0, unlimited=True,
        )
    account = await get_account(session, int(run.user_id))
    user = await session.get(User, int(run.user_id))
    views = enforced_windows(effective_plan(user, account, at), account, at)
    tightest = binding_window(windows_for_run(views, int(run.estimate_tokens or 0)))
    # No account row yet = nothing used yet; the balance is then 0 too.
    spare = await wallet.available(session, account, at) if account is not None else 0
    return QuotaSnapshot(
        window=tightest.key if tightest else None,
        headroom=tightest.headroom if tightest else 0,
        resets_at=tightest.resets_at if tightest else None,
        wallet_satang=spare,
        wallet_allowance=int(run.reserved_wallet_satang or 0),
    )


@dataclass(frozen=True)
class StartWindow:
    """The plan window new work starts against: the enforced window with the
    least room — on Pro and up whichever of ``weekly`` / ``monthly`` is
    closer to full, since a new run must fit what is left of BOTH."""

    window: str
    limit: int
    #: What is left; ≤ 0 when the window is at (or past) 100 %.
    headroom: int
    resets_at: datetime | None
    #: Spendable top-up balance, satang (what could carry new work instead).
    wallet_satang: int
    #: What this user's runs already in flight still expect to spend (Σ their
    #: estimate less what each has already been charged). The start gate
    #: counts it as spent, so concurrent slots (Pro 2 … Max 5) cannot each
    #: start against the same headroom and take the full allowance at once.
    in_flight: int = 0

    @property
    def full(self) -> bool:
        return self.headroom <= 0

    @property
    def left_for_new_work(self) -> int:
        return self.headroom - self.in_flight


async def start_window(session: AsyncSession, user: User, now: datetime | None = None) -> StartWindow | None:
    """What the two pre-start quota checks read (guard.quota_full_refusal,
    guard.remaining_refusal) — None for an unlimited account or a plan with
    no enforced window. Carried overage included. ``session`` must resolve
    the core tables."""
    if limits_mod.is_unlimited(user):
        return None
    at = now or _now()
    account = await get_account(session, int(user.id))
    tightest = binding_window(enforced_windows(effective_plan(user, account, at), account, at))
    if tightest is None:
        return None
    spare = await wallet.available(session, account, at) if account is not None else 0
    outstanding = (
        await session.execute(
            select(
                func.coalesce(
                    func.sum(func.greatest(AiRun.estimate_tokens - func.coalesce(AiRun.actual_tokens, 0), 0)),
                    0,
                )
            ).where(
                AiRun.user_id == int(user.id),
                AiRun.status.in_(OPEN_STATUSES),
                AiRun.unlimited.is_(False),
            )
        )
    ).scalar_one()
    return StartWindow(
        window=tightest.key, limit=tightest.limit, headroom=tightest.headroom,
        resets_at=tightest.resets_at, wallet_satang=max(0, int(spare)),
        in_flight=max(0, int(outstanding or 0)),
    )


# ── open / release / settle ──────────────────────────────────────────────────

async def open_run(
    session: AsyncSession,
    *,
    user: User,
    tenant_id: int,
    estimate: Estimate,
    allow_wallet: bool = False,
    job_id: str | None = None,
    reference_id: str | None = None,
    mode: str | None = None,
    engine: str | None = None,
    precision: str | None = None,
    now: datetime | None = None,
) -> AiRun:
    """Open the run row. Nothing is held (see the module docstring).

    ``allow_wallet`` records the user's consent as the run's wallet allowance
    — the balance it may spend once its windows are full. Flushes the run; the
    CALLER commits (before enqueueing the worker task).
    """
    at = now or _now()
    account = await lock_account(session, int(user.id))
    roll_windows(account, at)
    unlimited = limits_mod.is_unlimited(user)
    allowance = 0
    if allow_wallet and not unlimited:
        allowance = await wallet.available(session, account, at)
    if account.reserved_tokens or account.wallet_reserved_satang:
        # Nothing reserves any more: a hold left by a run that started before
        # this change would otherwise shrink this user's headroom — and make
        # their own balance unspendable — forever.
        account.reserved_tokens = 0
        account.wallet_reserved_satang = 0

    run = AiRun(
        id=uuid.uuid4().hex,
        user_id=int(user.id),
        tenant_id=int(tenant_id),
        job_id=job_id,
        reference_id=reference_id,
        kind=estimate.kind,
        mode=mode,
        engine=engine,
        precision=precision,
        media_sec=float(estimate.media_sec),
        estimate_tokens=int(estimate.tokens),
        reserved_tokens=0,
        reserved_wallet_satang=allowance,
        ceiling_tokens=int(estimate.ceiling),
        actual_tokens=0,
        status="queued",
        unlimited=unlimited,
        estimator_version=estimate.estimator_version,
        rate_version=estimate.rate_version,
        created_at=at,
    )
    session.add(run)
    await session.flush()
    log.info(
        "run_opened", run_id=run.id, user_id=int(user.id), kind=estimate.kind,
        estimate=estimate.tokens, wallet_allowance=allowance, unlimited=unlimited,
    )
    return run


async def lock_run(session: AsyncSession, run_id: str) -> tuple[UsageAccount, AiRun] | None:
    """Account first, then the run — the one lock order (see accounts.py)."""
    user_id = (await session.execute(select(AiRun.user_id).where(AiRun.id == run_id))).scalar_one_or_none()
    if user_id is None:
        return None
    account = await lock_account(session, int(user_id))
    run = (
        await session.execute(
            select(AiRun).where(AiRun.id == run_id).with_for_update().execution_options(populate_existing=True)
        )
    ).scalar_one()
    return account, run


def _drop_holds(account: UsageAccount, run: AiRun) -> None:
    """Give back a hold made before 2026-09-26 (nothing reserves any more)."""
    account.reserved_tokens = max(0, int(account.reserved_tokens or 0) - int(run.reserved_tokens or 0))


async def release(session: AsyncSession, run_id: str, now: datetime | None = None) -> None:
    """Drop a run that never got to work (enqueue failed, the route errored
    after opening it). Nothing is charged. Idempotent."""
    locked = await lock_run(session, run_id)
    if locked is None:
        return
    account, run = locked
    if run.status not in OPEN_STATUSES:
        return
    _drop_holds(account, run)
    run.status = "released"
    run.outcome = None
    run.charged_tokens = 0
    run.charged_wallet_satang = 0
    run.settled_at = now or _now()
    run.lease_until = None
    await session.flush()
    log.info("run_released", run_id=run_id)


def paid_tokens(run: AiRun) -> int:
    """What the run already paid as it went — on the windows AND, at the rate
    card, in baht."""
    return int(run.charged_tokens or 0) + wallet.tokens_for_satang(int(run.charged_wallet_satang or 0))


def charge_for(run: AiRun, outcome: str) -> int:
    """Tokens the user owes for a run that ended with ``outcome``.

    Since 2026-10-01 that is simply what it was charged as it went — actual
    usage, past 100 % of the window when a call in flight crossed it (the
    excess carries into the next period, ``apply_charge``) — for every
    outcome except our own failures, which are refunded. No cap at the
    estimate or the ceiling any more: the estimate is advice, and a cap there
    is what made a truncated run cost the user its estimate for nothing."""
    if outcome in REFUNDED_OUTCOMES:
        return 0
    return paid_tokens(run)


# ── charging, as the run spends ──────────────────────────────────────────────

async def apply_charge(
    session: AsyncSession, account: UsageAccount, run: AiRun, tokens: int, now: datetime
) -> tuple[int, int]:
    """Charge ``tokens`` — actual usage, in full. On the windows up to their
    headroom, then on the balance when the run is allowed to use it, and
    whatever is still left back on the windows, past 100 % (owner,
    2026-10-01: the call in flight is charged for what it really used). That
    excess is recorded as the account's overage, which opens the window's
    next period (``apply_carry``) instead of being billed as money. A call is
    only ever sent while the window has something left (guard.admit), so the
    excess is what the call(s) in flight wrote past the line.

    The caller holds ``account``'s lock. Returns (window tokens, satang).
    """
    if tokens <= 0 or run.unlimited:
        return 0, 0
    roll_windows(account, now)
    user = await session.get(User, int(run.user_id))
    plan = effective_plan(user, account, now)
    apply_carry(account, plan, now)
    views = enforced_windows(plan, account, now)
    # The same windows the run is allowed to be stopped by: a window too small
    # to hold it must not push its cost onto the user's baht either.
    tightest = binding_window(windows_for_run(views, int(run.estimate_tokens or 0)))
    room = tightest.headroom if tightest is not None else tokens
    to_windows = min(tokens, max(0, room))
    rest = tokens - to_windows
    to_wallet_satang = 0
    allowance = max(0, int(run.reserved_wallet_satang or 0) - int(run.charged_wallet_satang or 0))
    if rest > 0 and allowance > 0:
        need = wallet.satang_for_tokens(rest)
        spare = min(allowance, await wallet.available(session, account, now))
        to_wallet_satang = await wallet.debit(session, account, min(need, spare), run_id=run.id, now=now)
        covered = rest if to_wallet_satang >= need else wallet.tokens_for_satang(to_wallet_satang)
        rest -= covered
    if rest > 0:
        to_windows += rest
    # What this charge put past EACH enforced window's own line, carried into
    # that window's own next period (owner, 2026-10-01): a weekly excess
    # opens next week, a monthly one next month. One window's excess is not
    # another's — a call can take the week to 106 % while the month is at
    # 60 %, and then only the week carries anything.
    for view in views:
        excess = to_windows - max(0, view.headroom)
        if excess <= 0:
            continue
        if view.key == "weekly":
            account.weekly_overage_tokens = _weekly_overage(account) + excess
        else:
            account.overage_tokens = int(account.overage_tokens or 0) + excess
            account.overage_window = view.key
        log.info(
            "run_overage_charged", run_id=run.id, user_id=int(run.user_id), tokens=int(tokens),
            overage=int(excess), window=view.key,
            carried=_weekly_overage(account) if view.key == "weekly" else int(account.overage_tokens or 0),
        )
    start_windows(account, now)
    for key in limits_mod.TRACKED_WINDOWS:
        setattr(account, f"{key}_used", _used_raw(account, key) + to_windows)
    run.charged_tokens = int(run.charged_tokens or 0) + to_windows
    run.charged_wallet_satang = int(run.charged_wallet_satang or 0) + to_wallet_satang
    return to_windows, to_wallet_satang


def _refund_windows(account: UsageAccount, run: AiRun, tokens: int, now: datetime) -> int:
    """Take ``tokens`` back off the windows (a run charged more as it went
    than its outcome says it owes). Never below zero."""
    if tokens <= 0:
        return 0
    roll_windows(account, now)
    for key in limits_mod.TRACKED_WINDOWS:
        setattr(account, f"{key}_used", max(0, _used_raw(account, key) - tokens))
    # A refund takes back the most recent charges first — the ones past
    # 100 %, when there were any — so the carried overage shrinks with it.
    if int(account.overage_tokens or 0) > 0:
        account.overage_tokens = max(0, int(account.overage_tokens or 0) - tokens)
        if account.overage_tokens == 0:
            account.overage_window = None
    if _weekly_overage(account) > 0:
        account.weekly_overage_tokens = max(0, _weekly_overage(account) - tokens)
    run.charged_tokens = max(0, int(run.charged_tokens or 0) - tokens)
    return tokens


async def apply_spend(
    session: AsyncSession, account: UsageAccount, run: AiRun, tokens: int, now: datetime | None = None
) -> int:
    """One recorded vendor request: accrue it on the run and charge it.

    Called by ``metering`` inside the same transaction as the usage row, with
    the account and run already locked — the money and the evidence for it
    land together or not at all.
    """
    at = now or _now()
    run.actual_tokens = int(run.actual_tokens or 0) + max(0, int(tokens))
    if run.status not in OPEN_STATUSES:
        # A usage row replayed from the outbox after the run settled: the
        # evidence is kept, but charging it now would undo the refund settle
        # already decided (and nothing would ever true it up again).
        log.warning("run_charge_after_settle", run_id=run.id, status=run.status, tokens=int(tokens))
        await session.flush()
        return 0
    if run.unlimited or tokens <= 0:
        await session.flush()
        return 0
    to_windows, to_wallet = await apply_charge(session, account, run, int(tokens), at)
    await session.flush()
    log.debug(
        "run_charged_as_spent", run_id=run.id, tokens=int(tokens),
        to_windows=to_windows, to_wallet_satang=to_wallet,
    )
    return to_windows


async def charge_as_spent(
    session: AsyncSession, run_id: str, tokens: int, now: datetime | None = None
) -> int:
    """``apply_spend`` for a caller that has not locked anything yet."""
    locked = await lock_run(session, run_id)
    if locked is None:
        return 0
    account, run = locked
    return await apply_spend(session, account, run, tokens, now)


async def settle(
    session: AsyncSession, run_id: str, outcome: str, now: datetime | None = None
) -> AiRun | None:
    """Close the run and true up what it paid as it went against what
    ``outcome`` says it owes — charging the difference, or refunding it.
    Idempotent: a run already closed is returned untouched. Flushes; the
    caller commits."""
    if outcome not in OUTCOMES:
        raise ValueError(f"unknown outcome: {outcome}")
    at = now or _now()
    locked = await lock_run(session, run_id)
    if locked is None:
        log.warning("run_settle_missing", run_id=run_id)
        return None
    account, run = locked
    if run.status not in OPEN_STATUSES:
        return run

    _drop_holds(account, run)
    charge = 0 if run.unlimited else charge_for(run, outcome)
    refund_capped = False
    if outcome == "our_failure" and not run.unlimited and int(run.actual_tokens or 0) > 0:
        from packages.core.settings import get_settings

        refunded_today = await refunds_today(session, int(run.user_id), at)
        if refunded_today >= int(get_settings().billing_free_refunds_per_day):
            refund_capped = True
            charge = paid_tokens(run)
            log.warning(
                "run_refund_cap_reached", run_id=run.id, user_id=int(run.user_id),
                refunded_today=refunded_today, charged=charge,
            )
        else:
            log.info(
                "run_refunded", run_id=run.id, user_id=int(run.user_id), kind=run.kind,
                actual=int(run.actual_tokens or 0), refunded_today=refunded_today + 1,
            )
    # What the run already paid per call as it ran (charge_as_spent) — on the
    # windows AND, at the rate card, in baht. Since 2026-10-01 nothing owes
    # MORE than that (charge_for), so the branch below that charges extra is
    # kept only for safety; settling is "keep it" or "give it all back".
    paid = paid_tokens(run)
    refunded = 0
    if charge > paid:
        await apply_charge(session, account, run, charge - paid, at)
    elif charge < paid:
        owed_back = paid - charge
        if charge == 0 and int(run.charged_wallet_satang or 0) > 0:
            # Nothing is owed: the baht go back to the lots they came from
            # FIRST, so the windows are only asked for what is left — they
            # never gave the wallet's share and must not repay it.
            back = await wallet.refund(session, account, run.id, now=at)
            run.charged_wallet_satang = max(0, int(run.charged_wallet_satang or 0) - back)
            owed_back -= wallet.tokens_for_satang(back)
        refunded = _refund_windows(account, run, min(int(run.charged_tokens or 0), owed_back), at)

    run.charged_tokens = int(run.charged_tokens or 0)
    run.charged_wallet_satang = int(run.charged_wallet_satang or 0)
    run.status = "settled" if refund_capped else _STATUS_FOR[outcome]
    run.outcome = outcome
    run.settled_at = at
    run.lease_until = None
    await session.flush()
    log.info(
        "run_settled", run_id=run.id, outcome=outcome, kind=run.kind, estimate=int(run.estimate_tokens or 0),
        actual=int(run.actual_tokens or 0), ceiling=int(run.ceiling_tokens or 0),
        charged_tokens=run.charged_tokens, charged_wallet_satang=run.charged_wallet_satang,
        refunded_tokens=refunded, unlimited=bool(run.unlimited),
    )
    return run


async def refunds_today(session: AsyncSession, user_id: int, now: datetime) -> int:
    """``our_failure`` runs refunded to ``user_id`` since 00:00 UTC that had
    burned vendor tokens (the refund cap in ``settle``)."""
    day_start = now.astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    return int(
        (
            await session.execute(
                select(func.count(AiRun.id)).where(
                    AiRun.user_id == user_id,
                    AiRun.outcome == "our_failure",
                    AiRun.status == "refunded",
                    AiRun.actual_tokens > 0,
                    AiRun.settled_at >= day_start,
                )
            )
        ).scalar_one()
        or 0
    )


# ── concurrency slots ────────────────────────────────────────────────────────

async def acquire_slot(session: AsyncSession, run_id: str, now: datetime | None = None) -> SlotResult:
    """``run``: the task may work (lease taken/renewed). ``wait``: the user
    already runs their plan's maximum — re-enqueue later. ``gone``: the run is
    closed or unknown — the task must not do paid work."""
    at = now or _now()
    locked = await lock_run(session, run_id)
    if locked is None:
        return "gone"
    account, run = locked
    if run.status == "running":
        run.lease_until = at + LEASE
        await session.flush()
        return "run"
    if run.status != "queued":
        return "gone"
    user = await session.get(User, int(run.user_id))
    cap = limits_mod.concurrency_for(user, effective_plan(user, account, at))
    busy = (
        await session.execute(
            select(func.count(AiRun.id)).where(
                AiRun.user_id == run.user_id,
                AiRun.status == "running",
                AiRun.lease_until > at,
                AiRun.id != run.id,
            )
        )
    ).scalar_one()
    if int(busy) >= cap:
        # Still wanted: the worker re-enqueues it every few seconds. The lease
        # on a QUEUED run is that heartbeat — sweep_orphans leaves a waiting
        # run alone while it keeps asking, however long the queue is.
        run.lease_until = at + LEASE
        await session.flush()
        return "wait"
    run.status = "running"
    run.started_at = run.started_at or at
    run.lease_until = at + LEASE
    await session.flush()
    return "run"


async def renew_lease(
    session: AsyncSession, run_id: str, now: datetime | None = None, *, hold: timedelta = LEASE
) -> None:
    """Extend a running run's slot lease to ``now + hold``."""
    at = now or _now()
    await session.execute(
        update(AiRun)
        .where(AiRun.id == run_id, AiRun.status == "running")
        .values(lease_until=at + hold)
        .execution_options(synchronize_session=False)
    )


async def sweep_orphans(session: AsyncSession, now: datetime | None = None) -> int:
    """Settle runs whose worker died (lapsed lease) or that never started.
    Charged nothing (``orphaned``). Worker cron; returns how many."""
    at = now or _now()
    ids = (
        await session.execute(
            select(AiRun.id).where(
                (
                    (AiRun.status == "running")
                    & (AiRun.lease_until.is_not(None))
                    & (AiRun.lease_until < at - ORPHAN_GRACE)
                )
                | (
                    (AiRun.status == "queued")
                    & (AiRun.created_at < at - QUEUED_MAX_AGE)
                    # A queued run still waiting for a slot renews its lease on
                    # every retry; only one nobody has asked about is orphaned.
                    & (AiRun.lease_until.is_(None) | (AiRun.lease_until < at - ORPHAN_GRACE))
                )
            )
        )
    ).scalars().all()
    for run_id in ids:
        await settle(session, run_id, "orphaned", now=at)
    return len(ids)


# ── views + admin actions ────────────────────────────────────────────────────

async def usage_state(session: AsyncSession, user: User, now: datetime | None = None) -> dict[str, Any]:
    """Window percentages, reset times and concurrency for ``GET /usage/me``.

    Percentages include open reservations. Never token counts.
    """
    at = now or _now()
    account = await get_account(session, int(user.id))
    unlimited = limits_mod.is_unlimited(user)
    plan = effective_plan(user, account, at)
    open_rows = (
        await session.execute(
            select(AiRun.status, func.count(AiRun.id))
            .where(AiRun.user_id == int(user.id), AiRun.status.in_(OPEN_STATUSES))
            .where((AiRun.status == "queued") | (AiRun.lease_until > at))
            .group_by(AiRun.status)
        )
    ).all()
    counts: dict[str, int] = {str(status): int(n) for status, n in open_rows}
    views = [] if unlimited else enforced_windows(plan, account, at)
    tightest = binding_window(views)
    blocked = None
    if tightest is not None and tightest.headroom <= 0:
        blocked = {
            "key": tightest.key,
            "resets_at": iso(tightest.resets_at),
            # A spent trial credit never comes back, so the client must offer
            # an upgrade instead of counting down to a reset that never runs.
            "resets": limits_mod.window_resets(tightest.key),
        }
    return {
        "plan": plan,
        "unlimited": unlimited,
        "views": views,
        "binding": tightest,
        "blocked": blocked,
        "concurrency": {
            "max": limits_mod.concurrency_for(user, plan),
            "running": int(counts.get("running", 0)),
            "queued": int(counts.get("queued", 0)),
        },
        "account": account,
    }


async def reset_windows(
    session: AsyncSession, user_id: int, windows: tuple[str, ...]
) -> dict[str, dict[str, Any]]:
    """Admin: clear ``windows`` for a user (they restart at the next use).
    Returns the before-state for the audit trail. Open reservations stay."""
    account = await lock_account(session, user_id)
    before: dict[str, dict[str, Any]] = {}
    for key in windows:
        if key not in limits_mod.TRACKED_WINDOWS:
            raise ValueError(f"unknown window: {key}")
        before[key] = {"started_at": iso(_started(account, key)), "used": _used_raw(account, key)}
        setattr(account, f"{key}_started_at", None)
        setattr(account, f"{key}_used", 0)
        if account.overage_window == key:
            # A reset by hand is a clean slate: nothing carries into it.
            before[key]["overage"] = int(account.overage_tokens or 0)
            _clear_overage(account)
        if key == "weekly" and _weekly_overage(account):
            before[key]["overage"] = _weekly_overage(account)
            account.weekly_overage_tokens = 0
    await session.flush()
    return before
