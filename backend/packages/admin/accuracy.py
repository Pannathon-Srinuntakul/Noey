"""Estimate vs actual per paid run — the admin's check on the estimator.

Owner decision (docs/token-billing-plan.md §6): store estimate vs actual per
job and show it per user and in aggregate. Every closed ``ai_runs`` row
carries both (``estimate_tokens`` from packages/billing/estimate.py at start,
``actual_tokens`` accrued from its usage rows), so this is pure aggregation:
per kind × precision, the median / p90 of actual ÷ estimate, how many runs
went past their ceiling, and how many the per-call guard stopped.

Runs that did no work (released before starting, or actual = 0 because the
job failed before its first call) say nothing about the estimator and are
left out.
"""

from __future__ import annotations

import math
from collections import defaultdict
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.db.models.ai_run import AiRun
from packages.db.models.llm_usage import LlmUsageLog
from packages.db.models.stt_usage import SttUsageLog

CLOSED = ("settled", "stopped", "cancelled", "refunded")


def _percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    k = (len(ordered) - 1) * q
    lo, hi = math.floor(k), math.ceil(k)
    if lo == hi:
        return round(ordered[lo], 3)
    return round(ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo), 3)


def _summarise(rows: list[Any]) -> dict[str, Any]:
    ratios = [r.actual_tokens / r.estimate_tokens for r in rows if r.estimate_tokens]
    return {
        "runs": len(rows),
        "median_ratio": _percentile(ratios, 0.5),
        "p90_ratio": _percentile(ratios, 0.9),
        "over_ceiling": sum(1 for r in rows if r.ceiling_tokens and r.actual_tokens > r.ceiling_tokens),
        "limit_stops": sum(1 for r in rows if r.outcome == "limit_stop"),
        "estimate_tokens": sum(int(r.estimate_tokens or 0) for r in rows),
        "actual_tokens": sum(int(r.actual_tokens or 0) for r in rows),
    }


async def estimate_accuracy(
    session: AsyncSession, start: datetime, end: datetime, user_id: int | None = None
) -> dict[str, Any]:
    stmt = select(
        AiRun.kind, AiRun.precision, AiRun.estimate_tokens, AiRun.actual_tokens, AiRun.ceiling_tokens,
        AiRun.outcome, AiRun.estimator_version,
    ).where(
        AiRun.status.in_(CLOSED),
        AiRun.actual_tokens > 0,
        AiRun.created_at >= start,
        AiRun.created_at < end,
    )
    if user_id is not None:
        stmt = stmt.where(AiRun.user_id == user_id)
    rows = (await session.execute(stmt)).all()
    groups: dict[tuple[str, str], list[Any]] = defaultdict(list)
    for r in rows:
        groups[(str(r.kind), str(r.precision or "standard"))].append(r)
    return {
        "from": start.isoformat(),
        "to": end.isoformat(),
        "user_id": user_id,
        "overall": _summarise(list(rows)),
        "by_kind": [
            {"kind": kind, "precision": precision, **_summarise(items)}
            for (kind, precision), items in sorted(groups.items())
        ],
        "estimator_versions": sorted({str(r.estimator_version) for r in rows if r.estimator_version}),
    }


async def recent_runs(session: AsyncSession, user_id: int, limit: int = 50) -> list[dict[str, Any]]:
    """A user's last runs with estimate / actual / charged and real cost (THB)."""
    runs = (
        await session.execute(
            select(AiRun).where(AiRun.user_id == user_id).order_by(AiRun.created_at.desc()).limit(limit)
        )
    ).scalars().all()
    ids = [r.id for r in runs]
    cost: dict[str, float] = defaultdict(float)
    if ids:
        for model in (LlmUsageLog, SttUsageLog):
            for run_id, thb in (
                await session.execute(
                    select(model.run_id, func.coalesce(func.sum(model.cost_thb), 0))
                    .where(model.run_id.in_(ids))
                    .group_by(model.run_id)
                )
            ).all():
                cost[str(run_id)] += float(thb or 0)
    return [
        {
            "id": r.id,
            "kind": r.kind,
            "mode": r.mode,
            "engine": r.engine,
            "precision": r.precision,
            "reference_id": r.reference_id,
            "status": r.status,
            "outcome": r.outcome,
            "unlimited": bool(r.unlimited),
            "media_sec": float(r.media_sec or 0),
            "estimate_tokens": int(r.estimate_tokens or 0),
            "ceiling_tokens": int(r.ceiling_tokens or 0),
            "actual_tokens": int(r.actual_tokens or 0),
            "charged_tokens": r.charged_tokens,
            "charged_wallet_satang": r.charged_wallet_satang,
            "cost_thb": round(cost.get(r.id, 0.0), 4),
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "settled_at": r.settled_at.isoformat() if r.settled_at else None,
        }
        for r in runs
    ]


async def refunded_summary(session: AsyncSession, user_id: int, start: datetime) -> dict[str, Any]:
    """What ``user_id``'s failed runs cost US since ``start``: runs that ended
    ``our_failure`` (refunded, or charged once the daily refund cap was
    reached — packages/billing/runs.py), with their rate-card tokens and real
    vendor cost. A high figure is how the admin spots someone burning vendor
    spend through failures."""
    rows = (
        await session.execute(
            select(AiRun.id, AiRun.actual_tokens, AiRun.status).where(
                AiRun.user_id == user_id,
                AiRun.outcome == "our_failure",
                AiRun.created_at >= start,
            )
        )
    ).all()
    ids = [r.id for r in rows]
    cost = 0.0
    if ids:
        for model in (LlmUsageLog, SttUsageLog):
            cost += float(
                (
                    await session.execute(
                        select(func.coalesce(func.sum(model.cost_thb), 0)).where(model.run_id.in_(ids))
                    )
                ).scalar_one()
                or 0
            )
    refunded = [r for r in rows if r.status == "refunded"]
    return {
        "since": start.isoformat(),
        "runs": len(rows),
        "refunded_runs": len(refunded),
        "charged_after_cap_runs": len(rows) - len(refunded),
        "refunded_tokens": sum(int(r.actual_tokens or 0) for r in refunded),
        "cost_thb": round(cost, 4),
    }
