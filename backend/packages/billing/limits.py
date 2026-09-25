"""Plan limits in rate-card tokens — one table (docs/token-billing-plan.md §2).

Owner-approved 2026-09-22. Users never see these numbers, only percentages of
them. Weekly = monthly ÷ 4.33; the 5-hour window = 40% of weekly. Free is
held to its Monthly limit; Lite/Starter to Weekly; Pro and up to Weekly +
5-hour. The monthly total is tracked for every plan but enforced for Free
only (weekly × 4.33 already bounds a paid month).

The window STATE (used / reserved / when each window started) is
``core.usage_accounts``, driven by packages/billing/runs.py; storage quotas
read ``storage_gb`` through ``Settings.plan_storage_limit``
(docs/token-billing-design.md §4, §13).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Literal

WindowKey = Literal["five_hour", "weekly", "monthly"]

WEEKS_PER_MONTH = 4.33
FIVE_HOUR_SHARE = 0.40
WINDOW_SECONDS: dict[str, int] = {
    "five_hour": 5 * 3600,
    "weekly": 7 * 86_400,
    "monthly": 30 * 86_400,
}
#: The English labels the UI shows (owner decision: English, percent only).
WINDOW_LABELS: dict[str, str] = {
    "five_hour": "5-hour limit",
    "weekly": "Weekly limit",
    "monthly": "Monthly limit",
}


@dataclass(frozen=True)
class PlanLimits:
    #: Rate-card tokens per month.
    monthly: int
    #: Windows enforced at job start.
    windows: tuple[WindowKey, ...]
    #: AI jobs that may run at once.
    concurrency: int
    storage_gb: int
    #: Total footage per project, seconds (the website's "ฟุตเทจรวมต่อโปรเจกต์").
    footage_sec: int = 2 * 3600
    #: Projects kept on the account; None = unlimited (within storage).
    max_projects: int | None = None
    #: Background music (the music track upload + beat alignment).
    music: bool = True
    #: Server conversion of files the browser cannot open.
    transcode: bool = True
    #: Queue priority — how far ahead of "now" a job is scored in the arq
    #: queue (normal 0 / Pro "ahead" / Studio+ "first").
    queue_lead_sec: int = 0


#: Queue leads: "ahead" (Pro) and "first" (Studio and up).
QUEUE_LEAD_AHEAD_SEC = 120
QUEUE_LEAD_FIRST_SEC = 600

# The feature columns mirror what the website promises per plan
# (noey-frontend/src/lib/plans.ts — the source of truth, owner 2026-09-22).
PLAN_LIMITS: dict[str, PlanLimits] = {
    "free": PlanLimits(100_000, ("monthly",), 1, 1,
                       footage_sec=5 * 60, max_projects=3, music=False, transcode=False),
    "lite": PlanLimits(800_000, ("weekly",), 1, 3,
                       footage_sec=10 * 60, max_projects=10, transcode=False),
    "starter": PlanLimits(1_600_000, ("weekly",), 1, 5,
                          footage_sec=20 * 60, max_projects=20),
    "pro": PlanLimits(4_000_000, ("weekly", "five_hour"), 2, 10, queue_lead_sec=QUEUE_LEAD_AHEAD_SEC),
    "studio": PlanLimits(8_000_000, ("weekly", "five_hour"), 3, 30, queue_lead_sec=QUEUE_LEAD_FIRST_SEC),
    "agency": PlanLimits(16_000_000, ("weekly", "five_hour"), 4, 60, queue_lead_sec=QUEUE_LEAD_FIRST_SEC),
    "max": PlanLimits(28_000_000, ("weekly", "five_hour"), 5, 100, queue_lead_sec=QUEUE_LEAD_FIRST_SEC),
}

# ── how much footage ONE model request can carry ─────────────────────────────
#
# Two different ceilings, and the owner asked for "1 hour on dub_first"
# (2026-09-26). One number cannot be right for both precisions: footage is
# priced at ``estimate.VIDEO_TOKENS_PER_SEC`` — 100 tokens/s at Standard,
# 300 at High — so an hour is 360 k tokens at Standard but 1.08 M at High,
# which is already past the model's input context. The cap is therefore
# DERIVED from those two constants instead of typed in twice.

#: The model's input context, in vendor tokens. A request larger than this
#: cannot succeed however much quota the user has — it is refused, not paused.
MODEL_INPUT_CONTEXT_TOKENS = 1_000_000
#: Share of that context the footage itself may fill. The prompt, the
#: transcript, the answer and the thinking need the rest; 80 % leaves ~200 k,
#: far above the ~14 k the dub prompt + script actually use.
FOOTAGE_CONTEXT_SHARE = 0.8
#: The owner's ceiling for one video-call project (2026-09-26). It binds at
#: Standard; at High the context ceiling binds first.
VIDEO_CALL_FOOTAGE_CAP_SEC = 3600


def footage_context_ceiling_sec(precision: str | None) -> int:
    """Longest footage that still FITS one request at ``precision``."""
    from packages.billing.estimate import VIDEO_TOKENS_PER_SEC

    per_sec = VIDEO_TOKENS_PER_SEC.get(precision or "standard", VIDEO_TOKENS_PER_SEC["standard"])
    return int(MODEL_INPUT_CONTEXT_TOKENS * FOOTAGE_CONTEXT_SHARE // per_sec)


def video_call_footage_sec(precision: str | None, *, unlimited: bool = False) -> int:
    """Footage cap for a mode that sends the WHOLE project to the model in one
    video request (dub_first / highlight): 1 h at Standard, ~44 min at High.

    Two different kinds of limit meet here, and only one of them is ours.
    ``VIDEO_CALL_FOOTAGE_CAP_SEC`` is a product decision (owner, 2026-09-26) and
    an unlimited account is exempt from it like any other plan rule. The context
    ceiling is not a decision at all — a request larger than the model's input
    window cannot be answered by anyone — so it binds even there.
    """
    ceiling = footage_context_ceiling_sec(precision)
    return ceiling if unlimited else min(VIDEO_CALL_FOOTAGE_CAP_SEC, ceiling)


#: Modes whose footage all travels in a single video request — the only ones
#: the cap above applies to. The speech modes send audio per clip instead.
VIDEO_CALL_MODES: frozenset[str] = frozenset({"dub_first", "highlight"})

UNLIMITED_PLANS = frozenset({"enterprise"})
#: Unlimited accounts still run at most this many AI jobs at once — a vendor
#: safety cap, not a plan limit.
UNLIMITED_CONCURRENCY = 5
#: Every window is tracked for every plan (a settle charges all three), so an
#: upgrade that adds a window starts from real usage, not from zero.
TRACKED_WINDOWS: tuple[WindowKey, ...] = ("five_hour", "weekly", "monthly")


def plan_limits(plan: str | None) -> PlanLimits:
    """Unknown plans get Free's limits — never an accidental unlimited."""
    return PLAN_LIMITS.get((plan or "free").lower(), PLAN_LIMITS["free"])


def is_unlimited(user: Any) -> bool:
    """Admin/internal accounts and the enterprise plan: no limits (still recorded)."""
    return bool(getattr(user, "is_admin", False)) or str(getattr(user, "plan", "") or "") in UNLIMITED_PLANS


def concurrency_for(user: Any, plan: str | None) -> int:
    return UNLIMITED_CONCURRENCY if is_unlimited(user) else plan_limits(plan).concurrency


def window_limit(plan: str | None, window: str) -> int:
    limits = plan_limits(plan)
    weekly = math.floor(limits.monthly / WEEKS_PER_MONTH)
    if window == "monthly":
        return limits.monthly
    if window == "weekly":
        return weekly
    if window == "five_hour":
        return math.floor(weekly * FIVE_HOUR_SHARE)
    raise KeyError(window)
