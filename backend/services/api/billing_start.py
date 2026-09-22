"""``start_paid_run`` — the one helper every route that starts AI work calls.

Guard layer 1 at the edge (docs/token-billing-design.md §6.1, §9.3). In
order:

0. footage over the plan's per-project cap (footage kinds) → 422
   ``footage_over_limit`` (packages/billing/plan_features.py);
1. circuit breaker open → 503 ``service_paused`` (admin/unlimited exempt);
2. a Free account → per-IP / per-device limits → 429 ``free_tier_limited``
   (checked here, but the run is COUNTED against them only after step 3);
3. reserve the SERVER-side estimate against the rolling windows (and, with
   ``allow_wallet``, the top-up balance) under the account row lock, commit
   → 402 ``limit_reached`` when it does not fit.

The reservation is committed in its own session BEFORE the worker task is
enqueued, and the ``run_id`` travels to the task as a kwarg. Anything that
fails between reserving and enqueueing must give the hold back —
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

LIMIT_REACHED_MESSAGE = "ใช้งานครบ {label} แล้ว"
LIMIT_REACHED_WALLET_HINT = " — ใช้ยอดเงินคงเหลือทำงานนี้ต่อได้"


def limit_reached_detail(exc: runs.LimitReached) -> dict[str, Any]:
    """The 402 body. Percent/label/time only — the client formats
    ``resets_at`` (UTC ISO) in the viewer's timezone."""
    label = limits_mod.WINDOW_LABELS.get(exc.window or "", "limit")
    message = LIMIT_REACHED_MESSAGE.format(label=label)
    if exc.wallet_can_cover:
        message += LIMIT_REACHED_WALLET_HINT
    return {
        "code": "limit_reached",
        "window": exc.window,
        "label": label,
        "resets_at": runs.iso(exc.resets_at),
        "wallet_can_cover": exc.wallet_can_cover,
        "wallet_satang": exc.wallet_need_satang,
        "message": message,
    }


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
    """Reserve ``estimate`` for ``auth``'s user and return the ``run_id``."""
    user = auth.user
    unlimited = limits_mod.is_unlimited(user)
    free = not unlimited and str(user.plan or "free") == "free"
    ip = ratelimit.client_ip(request) if request is not None else None
    device = request.headers.get(free_tier.DEVICE_HEADER) if request is not None else None
    if estimate.kind in plan_features.FOOTAGE_KINDS:
        # Server-measured footage against the plan's per-project cap — the
        # client already refused this before uploading; this is the guard.
        refusal = plan_features.check_footage(user, estimate.media_sec)
        if refusal is not None:
            raise HTTPException(status_code=422, detail=refusal)
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
        try:
            run = await runs.reserve(
                session, user=user, tenant_id=auth.tenant_id, estimate=estimate,
                allow_wallet=allow_wallet, job_id=job_id, reference_id=reference_id,
                mode=mode, engine=engine, precision=precision,
            )
        except runs.LimitReached as exc:
            await session.rollback()
            raise HTTPException(status_code=402, detail=limit_reached_detail(exc)) from None
        run_id = str(run.id)
        await session.commit()
    if free:
        # Counted only now: a start refused above (402) must not use up the
        # daily free runs every other account behind the same IP shares.
        await free_tier.count_run(ip=ip, device=device)
    return run_id


async def release_run(run_id: str) -> None:
    """Give a reservation back (nothing charged). Never raises."""
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
