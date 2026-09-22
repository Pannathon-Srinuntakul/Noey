"""Paid runs: rolling windows, reservation at start, settle at end, slots.

Guard layer 1 of docs/token-billing-plan.md §4, and the state behind
``GET /usage/me`` (docs/token-billing-design.md §4, §6.1, §10).

Windows (``core.usage_accounts``). A window is ACTIVE while
``now < started_at + length`` (5 h / 7 d / 30 d); an inactive window reads as
unused and restarts — ``started_at = now`` — at the next reservation, so a
window starts at first use (rolling), never on a calendar boundary. A plan
ENFORCES some windows (limits.PLAN_LIMITS) but all three are TRACKED: every
settle charges all of them.

Reservation. A route that starts AI work reserves the server-side estimate
first (``reserve``), under the account row lock, so N parallel starts of one
user can never together spend more headroom than there is:

    headroom(w) = limit(w) − used(w) − reserved_tokens    (every enforced w)
    fit         = min headroom
    estimate ≤ fit                 → hold it all on the windows
    else, allow_wallet and the balance covers the overflow at ฿350/1M
                                   → hold fit on the windows + the rest in baht
    else                           → LimitReached (402 at the route)

Settle (``settle``) charges by outcome, releases the holds, and puts the
charge on the windows first (up to the headroom), then the wallet (only for a
run that held wallet money), then — anything left — on the windows anyway:
a started run finishes, and its overshoot counts, even past 100 %.

    ok / user_cancel / user_error   min(actual, ceiling)
    limit_stop (guard layer 2)      min(actual, estimate) — never more than
                                    was reserved
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

Unlimited accounts (admin / enterprise) reserve nothing and are charged
nothing; their runs and usage rows are still recorded.

Concurrency. A worker task takes a SLOT before its first model call
(``acquire_slot``): at most ``limits.concurrency_for`` runs per user are
``running`` with a live lease. The lease is renewed while the task runs and
lapses after ``LEASE`` if the worker dies; ``sweep_orphans`` settles those.
"""

from __future__ import annotations

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

Outcome = Literal["ok", "limit_stop", "our_failure", "user_cancel", "user_error", "orphaned"]
OUTCOMES: frozenset[str] = frozenset(
    {"ok", "limit_stop", "our_failure", "user_cancel", "user_error", "orphaned"}
)
#: The run status each outcome settles into.
_STATUS_FOR: dict[str, str] = {
    "ok": "settled",
    "user_error": "settled",
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


class LimitReached(Exception):
    """The run does not fit the plan's windows (nor, if allowed, the wallet)."""

    def __init__(
        self,
        *,
        window: str | None,
        resets_at: datetime | None,
        wallet_can_cover: bool,
        wallet_need_satang: int,
    ) -> None:
        self.window = window
        self.resets_at = resets_at
        self.wallet_can_cover = wallet_can_cover
        self.wallet_need_satang = wallet_need_satang
        super().__init__(f"limit reached ({window})")


# ── window math ──────────────────────────────────────────────────────────────

def _started(account: UsageAccount | None, key: str) -> datetime | None:
    return getattr(account, f"{key}_started_at", None) if account is not None else None


def _used_raw(account: UsageAccount | None, key: str) -> int:
    return int(getattr(account, f"{key}_used", 0) or 0) if account is not None else 0


def window_active(started_at: datetime | None, key: str, now: datetime) -> bool:
    return started_at is not None and now < started_at + timedelta(seconds=limits_mod.WINDOW_SECONDS[key])


def window_used(account: UsageAccount | None, key: str, now: datetime) -> int:
    """Charged tokens in the window — 0 once it has run out."""
    return _used_raw(account, key) if window_active(_started(account, key), key, now) else 0


def window_resets_at(account: UsageAccount | None, key: str, now: datetime) -> datetime | None:
    """When an active window runs out; None for an inactive one ("5 h after next use")."""
    started = _started(account, key)
    if not window_active(started, key, now):
        return None
    assert started is not None
    return started + timedelta(seconds=limits_mod.WINDOW_SECONDS[key])


def roll_windows(account: UsageAccount, now: datetime) -> None:
    """Clear every window that has run out (it restarts at the next use)."""
    for key in limits_mod.TRACKED_WINDOWS:
        if _started(account, key) is not None and not window_active(_started(account, key), key, now):
            setattr(account, f"{key}_started_at", None)
            setattr(account, f"{key}_used", 0)


def start_windows(account: UsageAccount, now: datetime) -> None:
    """Start every inactive window now — the "first use" of a rolling window."""
    roll_windows(account, now)
    for key in limits_mod.TRACKED_WINDOWS:
        if _started(account, key) is None:
            setattr(account, f"{key}_started_at", now)
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


def enforced_windows(plan: str, account: UsageAccount | None, now: datetime) -> list[WindowView]:
    reserved = int(account.reserved_tokens or 0) if account is not None else 0
    out = []
    for key in limits_mod.plan_limits(plan).windows:
        started = _started(account, key)
        out.append(
            WindowView(
                key=key,
                limit=limits_mod.window_limit(plan, key),
                used=window_used(account, key, now),
                reserved=reserved,
                resets_at=window_resets_at(account, key, now),
                active=window_active(started, key, now),
            )
        )
    return out


def binding_window(views: list[WindowView]) -> WindowView | None:
    """The window with the least headroom (the one a start would hit first)."""
    return min(views, key=lambda v: v.headroom) if views else None


# ── reserve / release / settle ───────────────────────────────────────────────

async def reserve(
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
    """Hold ``estimate`` against the user's windows (and, if allowed, wallet).

    Flushes the run; the CALLER commits (before enqueueing the worker task).
    Raises ``LimitReached`` without touching anything.
    """
    at = now or _now()
    account = await lock_account(session, int(user.id))
    roll_windows(account, at)
    unlimited = limits_mod.is_unlimited(user)
    hold_tokens = hold_satang = 0

    if not unlimited:
        plan = effective_plan(user, account, at)
        views = enforced_windows(plan, account, at)
        tightest = binding_window(views)
        fit = tightest.headroom if tightest is not None else estimate.tokens
        if estimate.tokens <= fit:
            hold_tokens = estimate.tokens
        else:
            hold_tokens = max(0, fit)
            need = wallet.satang_for_tokens(estimate.tokens - hold_tokens)
            spare = await wallet.available(session, account, at)
            if not (allow_wallet and spare >= need):
                raise LimitReached(
                    window=tightest.key if tightest else None,
                    resets_at=tightest.resets_at if tightest else None,
                    wallet_can_cover=spare >= need,
                    wallet_need_satang=need,
                )
            hold_satang = need
        start_windows(account, at)
        account.reserved_tokens = int(account.reserved_tokens or 0) + hold_tokens
        account.wallet_reserved_satang = int(account.wallet_reserved_satang or 0) + hold_satang

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
        reserved_tokens=hold_tokens,
        reserved_wallet_satang=hold_satang,
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
        "run_reserved", run_id=run.id, user_id=int(user.id), kind=estimate.kind, estimate=estimate.tokens,
        hold_tokens=hold_tokens, hold_satang=hold_satang, unlimited=unlimited,
    )
    return run


async def _lock_run(session: AsyncSession, run_id: str) -> tuple[UsageAccount, AiRun] | None:
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
    account.reserved_tokens = max(0, int(account.reserved_tokens or 0) - int(run.reserved_tokens or 0))
    account.wallet_reserved_satang = max(
        0, int(account.wallet_reserved_satang or 0) - int(run.reserved_wallet_satang or 0)
    )


async def release(session: AsyncSession, run_id: str, now: datetime | None = None) -> None:
    """Drop a run that never got to work (enqueue failed, the route errored
    after reserving). Nothing is charged. Idempotent."""
    locked = await _lock_run(session, run_id)
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


def charge_for(run: AiRun, outcome: str) -> int:
    """Tokens the user owes for a run that ended with ``outcome``."""
    actual = int(run.actual_tokens or 0)
    if outcome in ("ok", "user_cancel", "user_error"):
        return min(actual, int(run.ceiling_tokens or 0))
    if outcome == "limit_stop":
        return min(actual, int(run.estimate_tokens or 0))
    return 0  # our_failure / orphaned


async def settle(
    session: AsyncSession, run_id: str, outcome: str, now: datetime | None = None
) -> AiRun | None:
    """Charge the run by ``outcome``, release its holds, close it. Idempotent:
    a run already closed is returned untouched. Flushes; the caller commits."""
    if outcome not in OUTCOMES:
        raise ValueError(f"unknown outcome: {outcome}")
    at = now or _now()
    locked = await _lock_run(session, run_id)
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
            charge = min(int(run.actual_tokens or 0), int(run.ceiling_tokens or 0))
            log.warning(
                "run_refund_cap_reached", run_id=run.id, user_id=int(run.user_id),
                refunded_today=refunded_today, charged=charge,
            )
        else:
            log.info(
                "run_refunded", run_id=run.id, user_id=int(run.user_id), kind=run.kind,
                actual=int(run.actual_tokens or 0), refunded_today=refunded_today + 1,
            )
    to_windows = to_wallet_satang = 0

    if charge > 0:
        roll_windows(account, at)
        user = await session.get(User, int(run.user_id))
        plan = effective_plan(user, account, at)
        tightest = binding_window(enforced_windows(plan, account, at))
        room = max(int(run.reserved_tokens or 0), tightest.headroom if tightest else charge)
        to_windows = min(charge, max(0, room))
        rest = charge - to_windows
        if rest > 0 and int(run.reserved_wallet_satang or 0) > 0:
            need = wallet.satang_for_tokens(rest)
            spare = await wallet.available(session, account, at)
            to_wallet_satang = await wallet.debit(
                session, account, min(need, spare), run_id=run.id, now=at
            )
            covered = rest if to_wallet_satang >= need else wallet.tokens_for_satang(to_wallet_satang)
            rest -= covered
        # A started run finishes and its overshoot counts (plan §2).
        to_windows += rest
        start_windows(account, at)
        for key in limits_mod.TRACKED_WINDOWS:
            setattr(account, f"{key}_used", _used_raw(account, key) + to_windows)

    run.charged_tokens = to_windows
    run.charged_wallet_satang = to_wallet_satang
    run.status = "settled" if refund_capped else _STATUS_FOR[outcome]
    run.outcome = outcome
    run.settled_at = at
    run.lease_until = None
    await session.flush()
    log.info(
        "run_settled", run_id=run.id, outcome=outcome, kind=run.kind, estimate=int(run.estimate_tokens or 0),
        actual=int(run.actual_tokens or 0), ceiling=int(run.ceiling_tokens or 0), charged_tokens=to_windows,
        charged_wallet_satang=to_wallet_satang, unlimited=bool(run.unlimited),
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
    locked = await _lock_run(session, run_id)
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


async def run_status(session: AsyncSession, run_id: str) -> str | None:
    return (await session.execute(select(AiRun.status).where(AiRun.id == run_id))).scalar_one_or_none()


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
        blocked = {"key": tightest.key, "resets_at": iso(tightest.resets_at)}
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
    await session.flush()
    return before
