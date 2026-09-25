"""``start_paid_run`` — the one helper every route that starts AI work calls.

Guard layer 1 at the edge (docs/token-billing-design.md §6.1, §9.3). In
order:

0. footage over the cap that applies — the plan's per-project one, or, for a
   mode that sends the whole project to the model in ONE video request, what
   that request can hold at the chosen ความละเอียด → 422
   ``footage_over_limit`` (packages/billing/plan_features.py);
1. a run too big for an enforced window even when the window is EMPTY → 422
   ``run_too_large``. This is the only quota check left before starting, and
   it is about impossibility, not about having enough left: waiting for the
   reset or topping up would not make it work;
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

from packages.billing import free_tier, guard, plan_features, runs
from packages.billing import limits as limits_mod
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
) -> str:
    """Open a paid run for ``auth``'s user and return the ``run_id``."""
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
    if not unlimited and await guard.breaker_open():
        raise HTTPException(
            status_code=503, detail={"code": "service_paused", "message": guard.SERVICE_PAUSED_MESSAGE}
        )
    if free:
        try:
            await free_tier.check_start(user_id=auth.user_id, ip=ip, device=device)
        except free_tier.FreeTierLimited as exc:
            raise HTTPException(
                status_code=429, detail={"code": "free_tier_limited", "message": str(exc)}
            ) from None

    async with get_sessionmaker()() as session:
        await session.execute(text("SET search_path TO core, public"))
        run = await runs.open_run(
            session, user=user, tenant_id=auth.tenant_id, estimate=estimate,
            allow_wallet=allow_wallet, job_id=job_id, reference_id=reference_id,
            mode=mode, engine=engine, precision=precision,
        )
        run_id = str(run.id)
        await session.commit()
    if free:
        # Counted only now: a start refused above must not use up the daily
        # free runs every other account behind the same IP shares.
        await free_tier.count_run(ip=ip, device=device)
    return run_id


async def release_run(run_id: str) -> None:
    """Close a run that never got to work (nothing charged). Never raises."""
    try:
        async with get_sessionmaker()() as session:
            await session.execute(text("SET search_path TO core, public"))
            await runs.release(session, run_id)
            await session.commit()
    except Exception as exc:  # noqa: BLE001 — the sweeper settles it within minutes anyway
        log.error("run_release_failed", run_id=run_id, error=str(exc)[:200])


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
