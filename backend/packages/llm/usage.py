"""Per-user LLM usage tracking, limit enforcement, and cost estimation.

Usage context is propagated via a ContextVar so callers don't need to thread it
through every function signature.  Set it once before a user-triggered LLM flow:

    from packages.llm.usage import UsageCtx, set_usage_ctx
    token = set_usage_ctx(UsageCtx(user_id=42, tenant_id=1, feature="chat", reference_id="session-abc"))

gateway.acompletion() reads it automatically.
"""

from __future__ import annotations

from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any

from packages.core.logging import get_logger
from packages.core.settings import get_settings
from packages.db.session import get_sessionmaker

log = get_logger(__name__)

# ---------------------------------------------------------------------------
# Context propagation
# ---------------------------------------------------------------------------

_ctx_var: ContextVar["UsageCtx | None"] = ContextVar("llm_usage_ctx", default=None)


@dataclass
class UsageCtx:
    user_id: int
    tenant_id: int
    feature: str              # chat | video | prompt_cron
    reference_id: str | None = field(default=None)


def set_usage_ctx(ctx: UsageCtx) -> "Token[UsageCtx | None]":
    """Set the current usage context; returns a token to restore the previous one."""
    return _ctx_var.set(ctx)


def get_usage_ctx() -> UsageCtx | None:
    return _ctx_var.get()


def reset_usage_ctx(token: "Token[UsageCtx | None]") -> None:
    _ctx_var.reset(token)


# ---------------------------------------------------------------------------
# Model price table  (input, output) USD per 1 million tokens
# ---------------------------------------------------------------------------

MODEL_PRICES: dict[str, tuple[float, float]] = {
    # Haiku family
    "claude-haiku-4-5":                       (0.80,  4.00),
    "claude-haiku-4-5-20251001":              (0.80,  4.00),
    "anthropic/claude-haiku-4-5":             (0.80,  4.00),
    "anthropic/claude-haiku-4-5-20251001":    (0.80,  4.00),
    # Sonnet family
    "claude-sonnet-4-6":                      (3.00, 15.00),
    "anthropic/claude-sonnet-4-6":            (3.00, 15.00),
    # Opus family
    "claude-opus-4-8":                        (15.00, 75.00),
    "anthropic/claude-opus-4-8":              (15.00, 75.00),
    # OpenAI
    "gpt-4o":                                 (2.50, 10.00),
    "openai/gpt-4o":                          (2.50, 10.00),
    # Gemini
    "gemini/gemini-1.5-pro":                  (3.50, 10.50),
    "gemini/gemini-1.5-flash":                (0.075, 0.30),
}

_DEFAULT_PRICE = (3.00, 15.00)  # fallback — Sonnet rate


def estimate_cost_usd(model: str, input_tokens: int, output_tokens: int) -> float:
    """Compute approximate USD cost for a single call."""
    in_price, out_price = MODEL_PRICES.get(model, _DEFAULT_PRICE)
    return (input_tokens * in_price + output_tokens * out_price) / 1_000_000


# ---------------------------------------------------------------------------
# Custom exception
# ---------------------------------------------------------------------------

class UsageLimitExceeded(Exception):
    def __init__(self, used: int, limit: int, plan: str) -> None:
        self.used = used
        self.limit = limit
        self.plan = plan
        super().__init__(
            f"Token limit exceeded for plan '{plan}': used {used:,} / {limit:,}"
        )


# ---------------------------------------------------------------------------
# DB helpers (lazy import to avoid circular deps at module load time)
# ---------------------------------------------------------------------------

def _period_start(reset_at: datetime | None) -> datetime:
    """Return the start of the current usage period.

    If ``reset_at`` is set (manual admin reset), use it directly.
    Otherwise fall back to the first second of the current calendar month (UTC).
    """
    if reset_at is not None:
        return reset_at
    today = date.today()
    return datetime(today.year, today.month, 1, tzinfo=timezone.utc)


async def sum_tokens_since(
    user_id: int,
    since: datetime,
    session: Any,
) -> int:
    """Sum input + output tokens for a user from ``since`` to now."""
    from sqlalchemy import func, select
    from packages.db.models.llm_usage import LlmUsageLog

    result = await session.execute(
        select(func.coalesce(func.sum(LlmUsageLog.input_tokens + LlmUsageLog.output_tokens), 0))
        .where(LlmUsageLog.user_id == user_id)
        .where(LlmUsageLog.created_at >= since)
    )
    return int(result.scalar() or 0)


async def check_limit(ctx: UsageCtx) -> None:
    """Raise UsageLimitExceeded if the user has exceeded their plan quota.

    Opens its own short-lived session so it can be called from gateway.py
    without requiring the caller to manage session lifetime.
    """
    from packages.db.models.core_auth import User

    settings = get_settings()

    maker = get_sessionmaker()
    async with maker() as session:
        from sqlalchemy import select, text
        await session.execute(text("SET search_path TO core, public"))

        user = (
            await session.execute(select(User).where(User.id == ctx.user_id))
        ).scalar_one_or_none()
        if user is None:
            return  # no user → don't block (can't check plan)

        plan = str(user.plan or "free")
        limit = settings.plan_token_limit(plan)
        if limit == 0:
            return  # unlimited plan

        since = _period_start(user.usage_reset_at)
        used = await sum_tokens_since(ctx.user_id, since, session)

        if used >= limit:
            raise UsageLimitExceeded(used, limit, plan)


async def record_usage(
    ctx: UsageCtx,
    model: str,
    input_tokens: int,
    output_tokens: int,
) -> None:
    """Insert one LlmUsageLog row.  Failures are logged but never re-raised."""
    from packages.db.models.llm_usage import LlmUsageLog

    if input_tokens == 0 and output_tokens == 0:
        return  # nothing to record (e.g. local model without usage reporting)

    try:
        maker = get_sessionmaker()
        async with maker() as session:
            from sqlalchemy import text
            await session.execute(text("SET search_path TO core, public"))
            session.add(
                LlmUsageLog(
                    user_id=ctx.user_id,
                    tenant_id=ctx.tenant_id,
                    feature=ctx.feature,
                    reference_id=ctx.reference_id,
                    model=model,
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                )
            )
            await session.commit()
    except Exception as exc:  # noqa: BLE001
        log.warning("llm_usage_record_failed", error=str(exc)[:200])
