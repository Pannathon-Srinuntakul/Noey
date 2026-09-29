"""Plan limits in rate-card tokens — one table (docs/token-billing-plan.md §2).

Users never see these numbers. The window STATE (used / reserved / when each
window started) is ``core.usage_accounts``, driven by packages/billing/runs.py;
storage quotas read ``storage_gb`` through ``Settings.plan_storage_limit``
(docs/token-billing-design.md §4, §13).

Free is a **one-time trial credit, not a monthly allowance** (owner,
2026-09-29). Its window is ``lifetime`` — it never rolls over and never
resets, so a free account spends its credit once and then upgrades. A
recurring free allowance costs us its vendor bill every month forever; the
same credit given once costs it once.

── what one clip costs, and therefore where every number below comes from ──

Refitted 2026-09-29 against the three measured production ``analyze_video``
runs (docs/unit-economics.md §4.1). A cut is a fixed cost plus a per-second
one, and the two must be kept apart or the fixed part gets counted twice:

  * FIXED, ~125,390 rate-card tokens: the prompt, the model's thinking and the
    edit script it writes. It does **not** scale with the source — the
    shortest of the three measured runs was the second most expensive.
  * PER SECOND: the footage alone, PROMPT-EXCLUSIVE — 63.4 vendor tokens/s at
    Standard and 328.6 at High. (The ~84 / ~348 figures in
    packages/video/quality.py are prompt-INCLUSIVE, measured as whole
    requests; subtracting the prompt from the three runs gives 328.62 /
    328.17 / 328.99 at High, a 0.25 % spread.)

So one cut costs, in rate-card tokens::

    standard = 65.6 * seconds + 125_390
    high     = 340.1 * seconds + 125_390

Aggregate error against the three measured runs: -0.01 %. Per run: +16.8 %,
-11.2 %, -2.8 % — that spread is thinking variance, not model error.

A voiceover/transcript pass adds roughly **40,000** tokens on top. That figure
is a PLANNING ESTIMATE, not a measurement: production ``stt_usage_logs`` has
three rows and all of them carry zero tokens. Re-derive it once real rows
exist. Every "with voiceover" number below carries it.

(The pre-flight estimator is deliberately rounder — ``VIDEO_TOKENS_PER_SEC``
in packages/billing/estimate.py prices footage at a flat 100 / 300 per second,
above the measurement at Standard and below it at High — so a plan's own
arithmetic and what a user is quoted for a run will not agree to the token.
The table is sized on the measurement; the estimate only has to be safe.)

── the three structural rules in the table ──

1. **Every paid plan enforces ``monthly`` and nothing else** (Free enforces
   its ``lifetime`` credit, which is the same rule with no reset). The 5-hour
   and weekly sub-windows are gone from every plan.

   They were there to protect the vendor quota, and that protection already
   exists elsewhere and works better: packages/billing/vendor_limits.py
   enforces the real daily Gemini cap globally, and ``concurrency`` bounds how
   many jobs one account can have in flight. Measured: a Max account burning
   its whole month in one day is ~600 Flash calls against a 10,000/day Tier-1
   cap — not close.

   And they actively hurt. Pro's 5-hour window was 369,514 tokens against a
   777,572-token 30-minute High clip: it could not hold one run, so
   ``runs.windows_for_run`` skipped it for the big job and it only ever
   blocked the user's NEXT, smaller job for five hours. Studio's 739,030 was
   short of that same clip too. Four different window rules across seven plans
   is also unlearnable; one rule per account is the UX fix.

   ``TRACKED_WINDOWS`` still records all four windows, so nothing about
   upgrade/downgrade accounting changes.

2. **High ความละเอียด is a Pro-and-up feature** (enforced in
   packages/billing/plan_features.py:check_precision). High is 5.2x the
   per-second video rate (328.6 vs 63.4 vendor tokens/s); for a 10-minute clip
   with a voiceover that is 369,451 against 204,762 — nearly double. On the
   three cheapest plans that silently halves the clip count, so it is sold as
   a feature rather than charged as a hidden tax.

3. **Every advertised cap is runnable.** The pre-flight estimate at each
   plan's own ``footage_sec``, at the best precision that plan may pick, is
   192,510 (Free/Lite), 254,610 (Starter) and 689,310 (Pro and up) against
   monthly budgets of 450 k / 800 k / 1.8 M / 4.4 M and up. Nothing can reach
   ``plan_features.check_run_size`` any more. That is the bug this table
   fixes — a cap that says 30 minutes while a 20-minute clip is refused — and
   tests/test_plan_features.py pins it per plan so it cannot come back.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Literal

WindowKey = Literal["five_hour", "weekly", "monthly", "lifetime"]

#: Only ``window_limit`` uses these, and only for windows no plan enforces
#: today (rule 1 in the module docstring). Kept so the arithmetic is still
#: defined for a tracked window and for anything that reads one back.
WEEKS_PER_MONTH = 4.33
FIVE_HOUR_SHARE = 0.40
#: How long each window lasts. ``None`` = it never runs out: once started it
#: keeps accumulating for the life of the account, and nothing resets it.
WINDOW_SECONDS: dict[str, int | None] = {
    "five_hour": 5 * 3600,
    "weekly": 7 * 86_400,
    "monthly": 30 * 86_400,
    "lifetime": None,
}
#: The English labels the UI shows. ``five_hour``/``weekly`` are unused by
#: every current plan but stay here for the rows that still record them.
WINDOW_LABELS: dict[str, str] = {
    "five_hour": "5-hour limit",
    "weekly": "Weekly limit",
    "monthly": "Monthly limit",
    "lifetime": "Trial credit",
}


def window_resets(window: str) -> bool:
    """False for a window that never comes back (``lifetime``). The UI must
    not offer a reset time for one — "resets in 0s" forever is the bug."""
    return WINDOW_SECONDS.get(window) is not None


@dataclass(frozen=True)
class PlanLimits:
    #: Rate-card tokens per month — or, for a plan whose window is
    #: ``lifetime`` (Free), the one-time credit the account ever gets.
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
    #: May this plan pick ความละเอียด "high"? False below Pro, whose budget
    #: cannot pay 5.2x per second (see rule 2 in the module docstring).
    high_precision: bool = True
    #: Queue priority — how far ahead of "now" a job is scored in the arq
    #: queue (normal 0 / Pro "ahead" / Studio+ "first").
    queue_lead_sec: int = 0


#: Queue leads: "ahead" (Pro) and "first" (Studio and up).
QUEUE_LEAD_AHEAD_SEC = 120
QUEUE_LEAD_FIRST_SEC = 600

# The feature columns mirror what the website promises per plan
# (noey-frontend/src/lib/plans.ts — the source of truth, owner 2026-09-22).
# One window rule per account: Free spends a lifetime credit, every paid plan
# a month (rule 1 in the module docstring). High precision from Pro up
# (rule 2). Budgets in whole credits: 2 / 4 / 9 / 22 / 45 / 90 / 160 — see
# ``plan_cuts`` and ``plan_cuts_at_cap``, the two counts the page quotes.
PLAN_LIMITS: dict[str, PlanLimits] = {
    # Free = a one-time credit, never reset: two 10-minute Standard cuts with
    # a voiceover (204,762 each).
    "free": PlanLimits(450_000, ("lifetime",), 1, 1,
                       footage_sec=10 * 60, max_projects=3, music=False, transcode=False,
                       high_precision=False),
    "lite": PlanLimits(800_000, ("monthly",), 1, 3,
                       footage_sec=10 * 60, max_projects=10, transcode=False,
                       high_precision=False),
    "starter": PlanLimits(1_600_000, ("monthly",), 1, 5,
                          footage_sec=20 * 60, max_projects=20,
                          high_precision=False),
    "pro": PlanLimits(4_000_000, ("monthly",), 2, 10,
                      footage_sec=30 * 60, queue_lead_sec=QUEUE_LEAD_AHEAD_SEC),
    "studio": PlanLimits(8_000_000, ("monthly",), 3, 30,
                         footage_sec=30 * 60, queue_lead_sec=QUEUE_LEAD_FIRST_SEC),
    "agency": PlanLimits(16_000_000, ("monthly",), 4, 60,
                         footage_sec=30 * 60, queue_lead_sec=QUEUE_LEAD_FIRST_SEC),
    "max": PlanLimits(28_000_000, ("monthly",), 5, 100,
                      footage_sec=30 * 60, queue_lead_sec=QUEUE_LEAD_FIRST_SEC),
}

# ── what the pricing page may claim, and what the meter shows ────────────────
#
# The METER is a percentage of the plan's window and nothing else (owner,
# 2026-09-22, re-confirmed 2026-09-29). Percent cannot contradict itself: one
# cut takes 5 % and a longer one takes 12 %, and nobody expected them to be
# equal. A countable unit can — a "clip" that a single clip spends four of
# reads as a broken meter, and the word is already taken in this codebase
# (``local_meta["clips"]``, ``clip_secs``) for a source video file.
#
# What a percentage cannot do is sell a plan, so the PRICING PAGE quotes an
# approximate cut count instead — "ตัดได้ราว 22 คลิป/เดือน · คิดจากคลิปดิบ
# 5 นาที". That claim is generated here so the website and the plan screen
# cannot drift from the table, and it is the ONLY place a count is allowed:
# it carries "ราว", it states its basis, and no meter is ever drawn from it.
# The question it answers inside the app — "how many more runs do I have?" —
# is answered by pricing each run before it starts ("งานนี้ใช้ประมาณ 5 %"),
# not by counting anything.

#: What an ordinary cut costs: 5 minutes of source at Standard with a
#: voiceover measures ~185,000 rate-card tokens (module docstring), rounded up
#: so the claim is never optimistic. Longer footage and high precision cost
#: more, which is what "ราว" and the stated basis are carrying.
TYPICAL_CUT_TOKENS = 200_000


def plan_cuts(plan: str | None) -> int:
    """Roughly how many ordinary cuts the plan's window pays for — the
    pricing page's first number, rounded DOWN. Marketing copy only: never a
    meter, never a quota, never subtracted from."""
    return int(plan_limits(plan).monthly // TYPICAL_CUT_TOKENS)


#: Rate-card tokens per second of footage at Standard, and the fixed part of a
#: cut with a voiceover — the same model as the module docstring, kept here so
#: ``plan_cuts_at_cap`` cannot drift from it.
_STANDARD_TOKENS_PER_SEC = 65.6
_CUT_FIXED_TOKENS = 125_390 + 40_000


def plan_cuts_at_cap(plan: str | None) -> int:
    """The pricing page's SECOND number: cuts per window when every clip runs
    the full ``footage_sec`` at Standard.

    One number cannot describe this plan. Pro pays for about 20 five-minute
    cuts but only 14 thirty-minute ones, and quoting just the 20 next to a
    "30 นาที" cap invites exactly the wrong arithmetic. Quoting both says the
    true thing — length costs — in the place where the user is choosing a
    plan, instead of leaving them to discover it from a falling meter.

    High precision is deliberately NOT a third number: it is priced as a
    percentage before every run, and a third figure on a card nobody finishes
    reading buys less than that does.
    """
    lim = plan_limits(plan)
    per_cut = _STANDARD_TOKENS_PER_SEC * lim.footage_sec + _CUT_FIXED_TOKENS
    return int(lim.monthly // per_cut)


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

    Both sit above what any plan now allows (30 minutes at most), so for a
    paying account the plan's own ``footage_sec`` is what binds and this only
    ever catches an unlimited one.

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
#: Every window is tracked for every plan (a settle charges all of them), even
#: though no plan ENFORCES ``five_hour`` or ``weekly`` any more: the accounting
#: has to already be there if one is ever switched back on, or the first
#: account to get it would start from zero. ``lifetime`` is tracked for paid
#: plans for a live reason — a user who upgrades and later returns to Free must
#: not find their trial credit refilled.
TRACKED_WINDOWS: tuple[WindowKey, ...] = ("five_hour", "weekly", "monthly", "lifetime")


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
    if window in ("monthly", "lifetime"):
        return limits.monthly
    if window == "weekly":
        return weekly
    if window == "five_hour":
        return math.floor(weekly * FIVE_HOUR_SHARE)
    raise KeyError(window)
