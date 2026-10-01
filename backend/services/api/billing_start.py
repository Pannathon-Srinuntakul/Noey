"""``start_paid_run`` — the one helper every route that starts AI work calls.

Guard layer 1 at the edge (docs/token-billing-design.md §6.1, §9.3). In
order:

0. footage over the cap that applies — the plan's per-project one, or, for a
   mode that sends the whole project to the model in ONE video request, what
   that request can hold at the chosen ความละเอียด → 422
   ``footage_over_limit`` (packages/billing/plan_features.py);
1. a run too big for an enforced window even when the window is EMPTY → 422
   ``run_too_large`` — about the plan's size, not about what is left (no
   advertised footage cap can reach it today). (A cut plan's answer always
   fits one model response: the requested result is capped at
   ``estimate.MAX_CUT_RESULT_SEC`` when the project is created);
1b. the STRICT START GATE (owner, 2026-10-01): the window ALREADY at 100 % →
   402 ``limit_reached`` with ``full: true`` (``guard.quota_full_refusal``),
   and a run whose estimate is bigger than what is left of the binding
   window — on Pro and up the closer-to-full of weekly / monthly — after the
   user's runs already in flight → 402 ``overage_too_large``
   (``guard.remaining_refusal``; the code keeps its old name for shipped
   clients). Each unless the user allowed a balance that covers the
   shortfall, and never for a resume. Once started, the estimate is advice
   again: a run that outgrows it pauses at 100 % and its in-flight overage
   carries into the next period;
2. circuit breaker open → 503 ``service_paused`` (admin/unlimited exempt);
3. a Free account → per-IP / per-device limits → 429 ``free_tier_limited``
   (checked here, but the run is COUNTED against them only after the row is
   opened).

**Nothing is reserved** (owner, 2026-09-26). The pre-flight estimate used to
be held against the windows, which refused work that would have fitted — it
reserves ~104 k where a real cut spends ~70 k, so a user with 90 k left was
refused a job they could afford. The run is charged per call as it goes
(packages/billing/metering.py) and pauses mid-run if the window really does
run out (``guard.QuotaExhausted``), with everything it produced kept.

The run row is committed in its own session BEFORE the worker task is
enqueued, and the ``run_id`` travels to the task as a kwarg. Anything that
fails between opening and enqueueing must close the row again —
``release_on_error`` does that around the rest of the route.

Every ``AI_ROUTES`` entry (services/api/ai_gate.py) calls this;
tests/test_billing_start.py fails when one does not.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import HTTPException, Request
from sqlalchemy import text

from packages.billing import free_tier, guard, plan_features, runs, wallet
from packages.billing import limits as limits_mod
from packages.billing.accounts import lock_account
from packages.billing.estimate import Estimate
from packages.core.logging import get_logger
from packages.db.session import get_sessionmaker
from services.api import ratelimit
from services.api.deps import AuthUser

log = get_logger(__name__)


async def start_paid_run(
    auth: AuthUser,
    request: Request | None,
    estimate: Estimate,
    *,
    allow_wallet: bool = False,
    job_id: str | None = None,
    reference_id: str | None = None,
    mode: str | None = None,
    engine: str | None = None,
    precision: str | None = None,
    resuming: bool = False,
) -> str:
    """Open a paid run for ``auth``'s user and return the ``run_id``.

    ``resuming`` — ``POST /videos/{uid}/resume`` continuing a paused stage.
    It is exempt from the 100 %-full refusal: resuming IS the way forward
    after a reset, an upgrade or a top-up, and on a window still full the
    resumed run simply pauses again before its first call, costing nothing."""
    user = auth.user
    unlimited = limits_mod.is_unlimited(user)
    free = not unlimited and str(user.plan or "free") == "free"
    ip = ratelimit.client_ip(request) if request is not None else None
    device = request.headers.get(free_tier.DEVICE_HEADER) if request is not None else None
    if estimate.kind in plan_features.FOOTAGE_KINDS:
        # Server-measured footage against the cap that applies — the client
        # already refused this before uploading; this is the guard.
        refusal = plan_features.check_footage(
            user, estimate.media_sec, mode=mode, precision=precision
        )
        if refusal is not None:
            raise HTTPException(status_code=422, detail=refusal)
    too_large = plan_features.check_run_size(user, estimate.tokens)
    if too_large is not None:
        raise HTTPException(status_code=422, detail=too_large)
    if not unlimited and not resuming:
        # Owner, 2026-10-01 — the strict start gate: a NEW run starts only
        # when its estimate fits what is left of the binding window(s), less
        # what runs already in flight still expect to spend. Checked here
        # first, so a refusal costs nothing, and again under the account lock
        # where the run is opened (``_refuse_on_quota``), so two starts at the
        # same instant cannot both see the same headroom.
        async with get_sessionmaker()() as session:
            await session.execute(text("SET search_path TO core, public"))
            await _refuse_on_quota(session, user, estimate, allow_wallet=allow_wallet)
    if not unlimited and await guard.breaker_open():
        raise HTTPException(
            status_code=503, detail={"code": "service_paused", "message": guard.SERVICE_PAUSED_MESSAGE}
        )
    if free:
        try:
            await free_tier.check_start(
                user_id=auth.user_id, ip=ip, device=device, email=str(user.email or "") or None
            )
            # Counted atomically with the cap (INCR, compare, give back): a
            # read-then-count let a burst of parallel starts all see the same
            # count and all get through.
            await free_tier.claim_run(user_id=auth.user_id, ip=ip, device=device)
        except free_tier.FreeTierLimited as exc:
            raise HTTPException(
                status_code=429, detail={"code": "free_tier_limited", "message": str(exc)}
            ) from None

    try:
        async with get_sessionmaker()() as session:
            await session.execute(text("SET search_path TO core, public"))
            if not unlimited and not resuming:
                await lock_account(session, int(user.id))
                await _refuse_on_quota(session, user, estimate, allow_wallet=allow_wallet)
            run = await runs.open_run(
                session, user=user, tenant_id=auth.tenant_id, estimate=estimate,
                allow_wallet=allow_wallet, job_id=job_id, reference_id=reference_id,
                mode=mode, engine=engine, precision=precision,
            )
            run_id = str(run.id)
            await session.commit()
    except BaseException:
        if free:
            # The run never opened: a start refused here must not use up the
            # daily free runs every other account behind the same IP shares.
            await free_tier.unclaim_run(ip=ip, device=device)
        raise
    return run_id


async def _refuse_on_quota(session: Any, user: Any, estimate: Estimate, *, allow_wallet: bool) -> None:
    """402 when the window is already at 100 %, or when the run's estimate is
    bigger than what is left for new work (guard.quota_full_refusal /
    guard.remaining_refusal)."""
    state = await runs.start_window(session, user)
    refusal = guard.quota_full_refusal(
        state, allow_wallet=allow_wallet, need_satang=wallet.satang_for_tokens(estimate.tokens),
    ) or guard.remaining_refusal(state, estimate.tokens, allow_wallet=allow_wallet)
    if refusal is not None:
        raise HTTPException(status_code=402, detail=refusal)


async def release_run(run_id: str) -> None:
    """Close a run that never got to work (nothing charged). Never raises."""
    try:
        async with get_sessionmaker()() as session:
            await session.execute(text("SET search_path TO core, public"))
            await runs.release(session, run_id)
            await session.commit()
    except Exception as exc:  # noqa: BLE001 — the sweeper settles it within minutes anyway
        log.error("run_release_failed", run_id=run_id, error=str(exc)[:200])


async def acquire_inline_slot(run_id: str) -> runs.SlotResult:
    """Take the plan's concurrency slot for a run the API works on itself
    (the synchronous ``/plan-dub``). The worker's ``billed_task`` does this for
    every queued task; without it, N parallel calls each ran against the same
    quota snapshot and together overspent the window."""
    async with get_sessionmaker()() as session:
        await session.execute(text("SET search_path TO core, public"))
        slot = await runs.acquire_slot(session, run_id)
        await session.commit()
    return slot


async def settle_run(run_id: str, outcome: str) -> None:
    """Settle a run the API itself did the work for (the synchronous
    ``/plan-dub``). Never raises."""
    try:
        async with get_sessionmaker()() as session:
            await session.execute(text("SET search_path TO core, public"))
            await runs.settle(session, run_id, outcome)
            await session.commit()
    except Exception as exc:  # noqa: BLE001
        log.error("run_settle_failed", run_id=run_id, outcome=outcome, error=str(exc)[:200])


@asynccontextmanager
async def release_on_error(run_id: str) -> AsyncIterator[None]:
    """Around everything a route does after reserving: an exception (a 4xx,
    a failed enqueue) gives the reservation back before it propagates."""
    try:
        yield
    except BaseException:
        await release_run(run_id)
        raise


async def load_run(run_id: str) -> Any:
    """The ``ai_runs`` row (detached) — for a meter in the API process."""
    from packages.db.models.ai_run import AiRun

    async with get_sessionmaker()() as session:
        await session.execute(text("SET search_path TO core, public"))
        return await session.get(AiRun, run_id)
