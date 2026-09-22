"""Per-user LLM usage attribution: the usage context, token extraction, access gate.

Plan limits are NOT enforced here any more: they are rolling windows checked
once at job start with a reservation (packages/billing/runs.py), and a
per-call job ceiling in the gateway (packages/billing/guard.py). Vendor cost
is priced when a row is recorded (packages/billing/vendor_cost.py).

Usage context is propagated via a ContextVar so callers don't need to thread it
through every function signature.  Set it once before a user-triggered LLM flow:

    from packages.llm.usage import UsageCtx, set_usage_ctx
    token = set_usage_ctx(UsageCtx(user_id=42, tenant_id=1, feature="chat", reference_id="session-abc"))

gateway.acompletion() reads it automatically.
"""

from __future__ import annotations

from contextvars import ContextVar, Token
from dataclasses import dataclass, field
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
    # The paid run (core.ai_runs.id) this work is charged to, and the
    # core.jobs id it runs under. Stamped on every usage row; null until the
    # caller has started a run (scripts never do).
    run_id: str | None = field(default=None)
    job_id: str | None = field(default=None)


def set_usage_ctx(ctx: UsageCtx) -> "Token[UsageCtx | None]":
    """Set the current usage context; returns a token to restore the previous one."""
    return _ctx_var.set(ctx)


def get_usage_ctx() -> UsageCtx | None:
    return _ctx_var.get()


def reset_usage_ctx(token: "Token[UsageCtx | None]") -> None:
    _ctx_var.reset(token)


def _usage_from_stream_chunk(chunk: Any) -> Any | None:
    """Return a provider ``usage`` object attached to one streaming chunk."""
    if chunk is None:
        return None
    if isinstance(chunk, dict):
        usage = chunk.get("usage")
        if usage is not None:
            return usage
        hidden = chunk.get("_hidden_params")
        if isinstance(hidden, dict):
            return hidden.get("usage")
        return None
    usage = getattr(chunk, "usage", None)
    if usage is not None:
        return usage
    hidden = getattr(chunk, "_hidden_params", None)
    if isinstance(hidden, dict):
        return hidden.get("usage")
    return None


def extract_stream_usage_from_chunks(chunks: Any) -> tuple[int, int]:
    """Best provider-reported usage from streaming chunks (no local estimates).

    Gemini often reports ``promptTokenCount`` only on the final stream chunk;
    scan all chunks and keep the usage object with the highest prompt count,
    falling back to the highest total when prompt is still zero.
    """
    best_with_prompt: Any | None = None
    best_prompt = 0
    best_any: Any | None = None
    best_total = 0

    for chunk in chunks or []:
        usage = _usage_from_stream_chunk(chunk)
        if usage is None:
            continue
        prompt = int(getattr(usage, "prompt_tokens", 0) or 0)
        total = int(getattr(usage, "total_tokens", 0) or 0)
        if total > best_total:
            best_total = total
            best_any = usage
        if prompt > best_prompt:
            best_prompt = prompt
            best_with_prompt = usage

    chosen = best_with_prompt or best_any
    if chosen is None:
        return 0, 0
    return extract_usage_tokens(chosen)


def extract_usage_tokens(usage: Any) -> tuple[int, int]:
    """Normalize LiteLLM usage → (input_tokens, output_tokens).

    Some providers (notably Gemini with thinking) report ``completion_tokens``
    as visible output only while ``total_tokens - prompt_tokens`` includes
    thinking/reasoning billed as output. Prefer the provider total when it
    exceeds prompt + completion.
    """
    if usage is None:
        return 0, 0
    inp = int(getattr(usage, "prompt_tokens", 0) or 0)
    out = int(getattr(usage, "completion_tokens", 0) or 0)
    total = int(getattr(usage, "total_tokens", 0) or 0)
    if total > 0 and inp + out < total:
        out = max(out, total - inp)
    return inp, out


def _get(obj: Any, name: str) -> Any:
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def extract_cached_tokens(usage: Any) -> int:
    """Prompt tokens the vendor served from its context cache (0 when unknown).

    LiteLLM maps Gemini's ``cachedContentTokenCount`` onto the OpenAI shape
    ``usage.prompt_tokens_details.cached_tokens``; Anthropic-style usage
    reports ``cache_read_input_tokens`` instead.
    """
    if usage is None:
        return 0
    details = _get(usage, "prompt_tokens_details")
    cached = _get(details, "cached_tokens")
    if not isinstance(cached, (int, float)) or cached <= 0:
        cached = _get(usage, "cache_read_input_tokens")
    try:
        return max(0, int(cached or 0))
    except (TypeError, ValueError):
        return 0


def extract_stream_cached_from_chunks(chunks: Any) -> int:
    """Highest cached-token count reported on any streaming chunk."""
    best = 0
    for chunk in chunks or []:
        best = max(best, extract_cached_tokens(_usage_from_stream_chunk(chunk)))
    return best


def merge_provider_usage(
    *pairs: tuple[int, int],
) -> tuple[int, int]:
    """Merge multiple provider-reported (input, output) pairs — never estimate."""
    best_in = 0
    best_out = 0
    for inp, out in pairs:
        best_in = max(best_in, inp)
        best_out = max(best_out, out)
    return best_in, best_out


# ---------------------------------------------------------------------------
# Verified-email gate for paid AI work
# ---------------------------------------------------------------------------

EMAIL_NOT_VERIFIED_DETAIL = (
    "ยืนยันอีเมลก่อนใช้งาน AI — เปิดลิงก์ในอีเมลที่เราส่งให้ หรือกดส่งใหม่ได้ที่หน้าบัญชี"
)


class EmailNotVerified(Exception):
    """The account must verify its email before it may start paid AI work."""

    def __init__(self) -> None:
        super().__init__(EMAIL_NOT_VERIFIED_DETAIL)


def ai_access_problem(user: Any) -> str | None:
    """Why this user may not START paid AI work, or None.

    THE policy, read by the request-time gate (services/api/ai_gate.py) and by
    `check_ai_access` before every model call. REQUIRE_VERIFIED_EMAIL_FOR_AI off,
    an admin, or a verified email → allowed.
    """
    if not get_settings().require_verified_email_for_ai:
        return None
    if getattr(user, "is_admin", False) or getattr(user, "email_verified_at", None) is not None:
        return None
    return EMAIL_NOT_VERIFIED_DETAIL


# ---------------------------------------------------------------------------
# Task grouping
# ---------------------------------------------------------------------------

# The four buckets the desktop settings screen reports. They are groups of LLM
# *calls*, not stages of the pipeline: one dub call writes the voiceover script
# and picks the scenes in the same response, so those cannot be separated
# without inventing a split. Speech-to-text is absent on purpose — ElevenLabs
# Scribe is not token-billed and never writes a row here.
USAGE_TASKS: tuple[str, ...] = ("cut", "effects", "style", "other")

_TASK_BY_FEATURE: dict[str, str] = {
    "video_cut": "cut",
    "video_effects": "effects",
    "video_style": "style",
    "chat": "other",
    "prompt_cron": "other",
    # Rows written before the feature names were split. Video work was
    # overwhelmingly cut planning back then, so they land there rather than in
    # a bucket that pretends to know better.
    "video": "cut",
    "video_edit": "cut",
}


def task_for_feature(feature: str | None) -> str:
    """Group a usage row's ``feature`` into one of ``USAGE_TASKS``."""
    return _TASK_BY_FEATURE.get(feature or "", "other")


def build_usage_tasks(per_feature: dict[str, int]) -> list[dict[str, object]]:
    """Roll per-feature token totals up into the four reported tasks.

    Always returns every task, zeros included, so the client never has to
    decide whether a missing row means "none" or "not reported". Percentages
    are of the period total, which is the sum of the input. Shares only —
    users never see token counts (docs/token-billing-plan.md §1).
    """
    totals: dict[str, int] = {task: 0 for task in USAGE_TASKS}
    for feature, tokens in per_feature.items():
        totals[task_for_feature(feature)] += tokens
    grand = sum(totals.values())
    return [
        {"task": task, "pct": round(tokens / grand * 100, 1) if grand > 0 else 0.0}
        for task, tokens in totals.items()
    ]


# ---------------------------------------------------------------------------
# DB helpers (lazy import to avoid circular deps at module load time)
# ---------------------------------------------------------------------------

async def record_stt_usage(
    ctx: UsageCtx, audio_sec: float, model: str = "", *, keyterms: bool = False,
    clip_index: int | None = None,
) -> None:
    """Record one transcribed file. Durable; never raises.

    Attribution lives here because the ElevenLabs key is one shared account —
    its own totals are every user's usage combined, so they can never be shown
    to an individual user. Thin wrapper over packages/billing/metering.py.
    """
    from packages.billing.metering import record_stt_clip

    await record_stt_clip(
        ctx, clip_index=clip_index, billed_sec=audio_sec, model=model, keyterms=keyterms
    )


async def check_ai_access(ctx: UsageCtx) -> None:
    """Raise ``EmailNotVerified`` if the account may not use paid AI.

    Defense in depth behind the request-time gate: work enqueued before the
    gate, or by a route missing from its list, still stops here. Opens its own
    short-lived session so the gateway can call it before every model call.
    """
    from sqlalchemy import select, text

    from packages.db.models.core_auth import User

    async with get_sessionmaker()() as session:
        await session.execute(text("SET search_path TO core, public"))
        user = (
            await session.execute(select(User).where(User.id == ctx.user_id))
        ).scalar_one_or_none()
        if user is not None and ai_access_problem(user):
            raise EmailNotVerified()


async def record_usage(
    ctx: UsageCtx,
    model: str,
    input_tokens: int,
    output_tokens: int,
    cached_tokens: int = 0,
) -> None:
    """Record one successful model call. Durable; never raises.

    Kept for callers outside the gateway; the gateway records every attempt
    itself via packages/billing/metering.py (``record_llm_attempt``).
    """
    from packages.billing.metering import record_llm_attempt

    await record_llm_attempt(
        ctx, model=model, status="ok", input_tokens=input_tokens,
        cached_tokens=cached_tokens, output_tokens=output_tokens,
    )
