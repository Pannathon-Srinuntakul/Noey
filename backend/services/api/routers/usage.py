"""LLM usage and plan management endpoints."""

from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from packages.core.settings import get_settings
from packages.db.models.core_auth import PLAN_VALUES, User
from packages.db.models.llm_usage import LlmUsageLog
from packages.db.models.stt_usage import SttUsageLog
from packages.video.stt_pricing import credits_for, is_rate_known
from packages.llm.usage import _period_start, build_usage_tasks, estimate_cost_usd
from services.api.deps import CurrentUser, core_session

router = APIRouter(prefix="/usage", tags=["usage"])


def _require_admin(auth: CurrentUser) -> CurrentUser:
    if not auth.user.is_admin:
        raise HTTPException(status_code=403, detail="admin only")
    return auth


# ── GET /usage/me ─────────────────────────────────────────────────────────────

@router.get("/me")
async def get_my_usage(
    auth: CurrentUser,
    db: Annotated[AsyncSession, Depends(core_session)],
) -> dict:
    """Return current period token usage + limit for the authenticated user."""
    settings = get_settings()

    await db.execute(text("SET search_path TO core, public"))
    user = (
        await db.execute(select(User).where(User.id == auth.user_id))
    ).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="user not found")

    plan = str(user.plan or "free")
    limit = settings.plan_token_limit(plan)
    since = _period_start(user.usage_reset_at)

    # Totals for the current period
    row = (
        await db.execute(
            select(
                func.coalesce(func.sum(LlmUsageLog.input_tokens), 0).label("input"),
                func.coalesce(func.sum(LlmUsageLog.output_tokens), 0).label("output"),
            )
            .where(LlmUsageLog.user_id == auth.user_id)
            .where(LlmUsageLog.created_at >= since)
        )
    ).one()
    input_total = int(row.input)
    output_total = int(row.output)
    total_tokens = input_total + output_total

    # Per-feature breakdown
    feature_rows = (
        await db.execute(
            select(
                LlmUsageLog.feature,
                func.coalesce(func.sum(LlmUsageLog.input_tokens), 0).label("input"),
                func.coalesce(func.sum(LlmUsageLog.output_tokens), 0).label("output"),
            )
            .where(LlmUsageLog.user_id == auth.user_id)
            .where(LlmUsageLog.created_at >= since)
            .group_by(LlmUsageLog.feature)
        )
    ).all()

    by_feature = [
        {
            "feature": r.feature,
            "input_tokens": int(r.input),
            "output_tokens": int(r.output),
            "total_tokens": int(r.input) + int(r.output),
        }
        for r in feature_rows
    ]

    # Grouped view for the desktop settings screen, which shows shares rather
    # than token counts.
    by_task = build_usage_tasks(
        {r.feature: int(r.input) + int(r.output) for r in feature_rows}
    )

    return {
        "user_id": auth.user_id,
        "plan": plan,
        "period_start": since.isoformat(),
        "used_tokens": total_tokens,
        "input_tokens": input_total,
        "output_tokens": output_total,
        "limit_tokens": limit,
        "unlimited": limit == 0,
        "remaining_tokens": max(0, limit - total_tokens) if limit > 0 else None,
        "usage_pct": round(total_tokens / limit * 100, 1) if limit > 0 else None,
        "by_feature": by_feature,
        "by_task": by_task,
        "estimated_cost_usd": await _estimate_period_cost_async(auth.user_id, since, db),
        "reset_at": user.usage_reset_at.isoformat() if user.usage_reset_at else None,
    }


# ── GET /usage/stt ────────────────────────────────────────────────────────────

@router.get("/stt")
async def get_stt_usage(
    auth: CurrentUser,
    db: Annotated[AsyncSession, Depends(core_session)],
) -> dict:
    """This user's speech-to-text minutes for the current period.

    Read from our own ``stt_usage_logs``, never from ElevenLabs. The API key is
    a single shared account that every user transcribes through, so its account
    totals are everybody's usage added together — returning that here would
    show one user what the others have spent.
    """
    await db.execute(text("SET search_path TO core, public"))
    user = (
        await db.execute(select(User).where(User.id == auth.user_id))
    ).scalar_one_or_none()
    since = _period_start(user.usage_reset_at if user else None)

    # Grouped by model because the credit rate differs ~12.5x between them —
    # summing seconds alone cannot be priced (packages/video/stt_pricing.py).
    rows = (
        await db.execute(
            select(
                SttUsageLog.model,
                func.coalesce(func.sum(SttUsageLog.audio_sec), 0.0).label("secs"),
            )
            .where(SttUsageLog.user_id == auth.user_id)
            .where(SttUsageLog.created_at >= since)
            .group_by(SttUsageLog.model)
        )
    ).all()

    total_sec = sum(float(r.secs) for r in rows)
    credits = sum(credits_for(float(r.secs), r.model or "") for r in rows)
    estimated = any(not is_rate_known(r.model or "") for r in rows)

    return {
        "minutes": round(total_sec / 60.0, 2),
        # This user's share of the shared account, in ElevenLabs' own unit.
        "credits": credits,
        # True when some rows used a model with no measured rate, so `credits`
        # is an upper-bound guess rather than a figure.
        "credits_estimated": estimated,
        "period_start": since.isoformat(),
        "period": "utc_day",
    }


async def _estimate_period_cost_async(user_id: int, since: datetime, db: AsyncSession) -> float:
    """Compute approximate USD cost from stored model names."""
    rows = (
        await db.execute(
            select(
                LlmUsageLog.model,
                func.sum(LlmUsageLog.input_tokens).label("inp"),
                func.sum(LlmUsageLog.output_tokens).label("out"),
            )
            .where(LlmUsageLog.user_id == user_id)
            .where(LlmUsageLog.created_at >= since)
            .group_by(LlmUsageLog.model)
        )
    ).all()
    total = 0.0
    for r in rows:
        total += estimate_cost_usd(r.model, int(r.inp or 0), int(r.out or 0))
    return round(total, 6)



# ── GET /admin/usage ──────────────────────────────────────────────────────────

@router.get("/admin/all")
async def admin_get_all_usage(
    auth: CurrentUser,
    db: Annotated[AsyncSession, Depends(core_session)],
) -> list[dict]:
    """Return usage summary for every user.  Admin only."""
    _require_admin(auth)
    settings = get_settings()

    await db.execute(text("SET search_path TO core, public"))

    users = (await db.execute(select(User).where(User.is_active.is_(True)))).scalars().all()

    result = []
    for user in users:
        plan = str(user.plan or "free")
        limit = settings.plan_token_limit(plan)
        since = _period_start(user.usage_reset_at)

        row = (
            await db.execute(
                select(
                    func.coalesce(func.sum(LlmUsageLog.input_tokens), 0).label("inp"),
                    func.coalesce(func.sum(LlmUsageLog.output_tokens), 0).label("out"),
                )
                .where(LlmUsageLog.user_id == user.id)
                .where(LlmUsageLog.created_at >= since)
            )
        ).one()
        input_total = int(row.inp)
        output_total = int(row.out)
        total = input_total + output_total

        cost = await _estimate_period_cost_async(int(user.id), since, db)
        result.append({
            "user_id": user.id,
            "email": user.email,
            "plan": plan,
            "period_start": since.isoformat(),
            "used_tokens": total,
            "input_tokens": input_total,
            "output_tokens": output_total,
            "limit_tokens": limit,
            "unlimited": limit == 0,
            "usage_pct": round(total / limit * 100, 1) if limit > 0 else None,
            "estimated_cost_usd": cost,
            "reset_at": user.usage_reset_at.isoformat() if user.usage_reset_at else None,
        })

    result.sort(key=lambda r: r["used_tokens"], reverse=True)
    return result


# ── PATCH /admin/users/{id}/plan ─────────────────────────────────────────────

@router.patch("/admin/users/{user_id}/plan")
async def admin_set_plan(
    user_id: int,
    body: dict,
    auth: CurrentUser,
    db: Annotated[AsyncSession, Depends(core_session)],
) -> dict:
    """Change a user's plan tier.  Admin only.

    Body: {"plan": "starter"}
    """
    _require_admin(auth)

    plan = str(body.get("plan", "")).strip()
    if plan not in PLAN_VALUES:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid plan '{plan}'. Must be one of: {', '.join(PLAN_VALUES)}",
        )

    await db.execute(text("SET search_path TO core, public"))
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="user not found")

    user.plan = plan
    await db.flush()
    return {"user_id": user_id, "plan": plan}


# ── POST /admin/users/{id}/usage/reset ───────────────────────────────────────

@router.post("/admin/users/{user_id}/usage/reset")
async def admin_reset_usage(
    user_id: int,
    auth: CurrentUser,
    db: Annotated[AsyncSession, Depends(core_session)],
) -> dict:
    """Manually reset a user's usage period to right now.  Admin only.

    Tokens used before this moment are excluded from the new period's quota.
    """
    _require_admin(auth)

    await db.execute(text("SET search_path TO core, public"))
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="user not found")

    now = datetime.now(tz=timezone.utc)
    user.usage_reset_at = now
    await db.flush()
    return {"user_id": user_id, "usage_reset_at": now.isoformat()}
