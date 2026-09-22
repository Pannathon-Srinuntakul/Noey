"""Usage endpoints — what a user sees of their limits. Percentages only.

GET  /usage/me        plan limits as percentages + reset times (UTC ISO; the
                      browser formats them in the viewer's timezone),
                      concurrency, wallet balance (baht), storage — never
                      token counts (docs/token-billing-design.md §9.1)
POST /usage/estimate  what a run would use, as percentages of the plan's
                      limits — never token counts (§9.2)

The speech-to-text minutes endpoint (GET /usage/stt) was removed with the
daily quota: speech-to-text is priced into the same token unit now, and
minutes are a vendor quantity users never need to see.
"""

from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from packages.billing import estimate as estimator
from packages.billing import limits as plan_limits_mod
from packages.billing import runs, wallet
from packages.billing.accounts import get_account
from packages.db.models.core_auth import User
from packages.db.models.llm_usage import LlmUsageLog
from packages.db.models.stt_usage import SttUsageLog
from packages.db.models.wallet import WalletLedger, WalletLot
from packages.llm.usage import build_usage_tasks
from services.api import ratelimit
from services.api.deps import CurrentUser, core_session, db_session

router = APIRouter(prefix="/usage", tags=["usage"])


# ── GET /usage/me ─────────────────────────────────────────────────────────────

async def _by_task(db: AsyncSession, user_id: int, since: datetime) -> list[dict[str, object]]:
    """Each task's share of the rate-card tokens charged since ``since``.
    Speech-to-text is part of cutting (the speech modes plan from it)."""
    rows = (
        await db.execute(
            select(LlmUsageLog.feature, func.coalesce(func.sum(LlmUsageLog.tokens), 0))
            .where(LlmUsageLog.user_id == user_id, LlmUsageLog.created_at >= since)
            .group_by(LlmUsageLog.feature)
        )
    ).all()
    per_feature = {str(r[0]): int(r[1]) for r in rows}
    stt = (
        await db.execute(
            select(func.coalesce(func.sum(SttUsageLog.tokens), 0)).where(
                SttUsageLog.user_id == user_id, SttUsageLog.created_at >= since
            )
        )
    ).scalar_one()
    per_feature["video_cut"] = per_feature.get("video_cut", 0) + int(stt or 0)
    return build_usage_tasks(per_feature)


async def _wallet_view(db: AsyncSession, user_id: int, now: datetime) -> dict[str, object] | None:
    """Baht balance + the next lot expiry; None for an account that never bought any."""
    ever = (
        await db.execute(select(func.count(WalletLedger.id)).where(WalletLedger.user_id == user_id))
    ).scalar_one()
    if not ever:
        return None
    next_expiry = (
        await db.execute(
            select(func.min(WalletLot.expires_at)).where(
                WalletLot.user_id == user_id, WalletLot.expires_at > now, WalletLot.remaining_satang > 0
            )
        )
    ).scalar_one()
    return {"balance_satang": await wallet.balance(db, user_id, now), "next_expiry": runs.iso(next_expiry)}


@router.get("/me")
async def get_my_usage(
    auth: CurrentUser,
    db: Annotated[AsyncSession, Depends(core_session)],
    tenant_db: Annotated[AsyncSession, Depends(db_session)],
) -> dict:
    """The caller's limits as percentages (open reservations included), when
    each resets, how many AI jobs may run at once, the top-up balance and
    storage. Never a token count."""
    from services.api.routers.videos_local import _quota_for, storage_used_for_display

    now = datetime.now(UTC)
    await db.execute(text("SET search_path TO core, public"))
    user = (await db.execute(select(User).where(User.id == auth.user_id))).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="user not found")

    state = await runs.usage_state(db, user, now)
    views: list[runs.WindowView] = state["views"]
    binding: runs.WindowView | None = max(views, key=lambda v: v.used_pct) if views else None
    account = state["account"]
    started = getattr(account, f"{binding.key}_started_at", None) if binding and binding.active else None
    since = started or now

    measured = await storage_used_for_display(tenant_db, auth.user_id)
    used_bytes = measured[0] if measured else 0
    quota_bytes, _ = await _quota_for(tenant_db, auth.user_id)
    from sqlalchemy import func

    from packages.billing import plan_features
    from packages.db.models.video_project import VideoProject

    project_count = (
        await tenant_db.execute(
            select(func.count()).select_from(VideoProject).where(VideoProject.user_id == auth.user_id)
        )
    ).scalar_one()

    return {
        "plan": state["plan"],
        "unlimited": state["unlimited"],
        "limits": [
            {
                "key": v.key,
                "label": plan_limits_mod.WINDOW_LABELS[v.key],
                "used_pct": v.used_pct,
                "resets_at": runs.iso(v.resets_at),
                "active": v.active,
            }
            for v in views
        ],
        "blocked": state["blocked"],
        "concurrency": state["concurrency"],
        "wallet": await _wallet_view(db, auth.user_id, now),
        "storage": {"used_bytes": int(used_bytes), "quota_bytes": int(quota_bytes)},
        # What the plan includes (docs/token-billing-plan.md §8) — the clients
        # lock controls and refuse over-limit uploads before sending anything.
        "features": plan_features.features_payload(user),
        "projects": {"count": int(project_count or 0), "max": plan_features.project_limit(user)},
        "pending_plan": (
            {"plan": account.pending_plan, "at": runs.iso(account.pending_plan_at)}
            if account is not None and account.pending_plan else None
        ),
        "grace_until": runs.iso(account.grace_until) if account is not None else None,
        "by_task": await _by_task(db, auth.user_id, since if started else _week_ago(now)),
        # Compatibility for the marketing site's account pages (noey-frontend
        # reads plan / period_start / usage_pct / unlimited / reset_at /
        # by_task): the fullest enforced window.
        "usage_pct": binding.used_pct if binding else None,
        "period_start": runs.iso(since),
        "reset_at": runs.iso(binding.resets_at) if binding else None,
        # Always empty: the web/desktop settings screens still iterate it until
        # they move to ``limits`` (their token-count breakdown is gone).
        "by_feature": [],
    }


def _week_ago(now: datetime) -> datetime:
    return now - timedelta(days=7)


# ── POST /usage/estimate ──────────────────────────────────────────────────────

class EstimateClip(BaseModel):
    duration_sec: float = Field(ge=0, le=4 * 3600)
    has_audio: bool = True


class EstimateIn(BaseModel):
    #: Route-level kind (packages/billing/estimate.py MODE_PROFILES); when
    #: absent it is derived from ``mode``.
    kind: str | None = Field(default=None, max_length=32)
    mode: str | None = Field(default=None, max_length=32)
    engine: Literal["lite", "pro"] | None = None
    precision: Literal["standard", "high"] | None = None
    clips: list[EstimateClip] = Field(default_factory=list, max_length=60)
    #: Seconds of audio to transcribe, when it differs from the clips'.
    audio_sec: float | None = Field(default=None, ge=0, le=12 * 3600)


@router.post("/estimate")
async def estimate_usage(
    body: EstimateIn,
    auth: CurrentUser,
    db: Annotated[AsyncSession, Depends(core_session)],
) -> dict:
    """What a run would use, as a percentage of each of the plan's limits.

    The estimate itself is the server's (packages/billing/estimate.py), from
    the durations sent here — the start routes recompute it from durations
    the server holds. ``pct`` is this run's share of each limit; ``fits`` says
    whether it fits what is LEFT (used + open reservations counted):
    ``plan``, ``wallet`` (only with "continue with my balance"; the balance
    would pay ``wallet_satang``) or ``none``. Percentages and baht only.
    """
    await ratelimit.enforce([(ratelimit.USAGE_ESTIMATE_ACCOUNT, str(auth.user_id))])
    audio = body.audio_sec
    if audio is None:
        audio = sum(c.duration_sec for c in body.clips if c.has_audio)
    try:
        est = estimator.estimate_run(
            kind=body.kind,
            mode=body.mode,
            engine=body.engine,
            precision=body.precision,
            clip_secs=[c.duration_sec for c in body.clips],
            audio_sec=audio,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="ไม่รู้จักโหมดงานนี้") from exc

    user = auth.user
    if plan_limits_mod.is_unlimited(user):
        return {
            "fits": "plan", "pct": {}, "wallet_satang": 0, "binding": None,
            "resets_at": None, "unlimited": True,
        }

    now = datetime.now(UTC)
    await db.execute(text("SET search_path TO core, public"))
    account = await get_account(db, auth.user_id)
    plan = runs.effective_plan(user, account, now)
    views = runs.enforced_windows(plan, account, now)
    pct = {
        v.key: round(est.tokens / v.limit * 100, 1) if v.limit > 0 else 100.0 for v in views
    }
    tightest = runs.binding_window(views)
    fit = tightest.headroom if tightest is not None else est.tokens
    overflow = max(0, est.tokens - max(0, fit))
    wallet_satang = wallet.satang_for_tokens(overflow)
    fits: Literal["plan", "wallet", "none"] = "plan"
    if overflow > 0:
        spare = 0
        if account is not None:
            spare = await wallet.balance(db, auth.user_id, now) - int(account.wallet_reserved_satang or 0)
        fits = "wallet" if spare >= wallet_satang else "none"
    return {
        "fits": fits,
        "pct": pct,
        "wallet_satang": wallet_satang,
        "binding": tightest.key if tightest else None,
        "resets_at": runs.iso(tightest.resets_at) if tightest else None,
        "unlimited": False,
    }


# The admin views and actions that used to live here (/usage/admin/*, reachable
# with an ordinary user token) moved to services/api/routers/admin.py, behind
# the admin session guard with an audit trail.
