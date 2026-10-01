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

1. **One monthly allowance per paid plan, and from Pro up a weekly one
   beside it** (Free enforces its ``lifetime`` credit, which is the monthly
   rule with no reset). The 5-hour sub-window is gone from every plan.

   ``weekly`` (owner, 2026-10-01) = ``WEEKLY_SHARE`` (40 %) of the monthly
   budget, enforced on Pro, Studio, Agency and Max ALONGSIDE ``monthly`` —
   whichever is hit first binds. A month is ~4.3 weeks, so 40 % a week lets a
   steady user spend the whole month by week 3 (40 + 40 + 20) while stopping
   anyone from draining a big plan's month — and the vendor quota behind it —
   in a day or two; the plans that run several jobs at once (2-5 slots) are
   exactly the ones that could. Lite and Starter (one slot, small budgets)
   keep monthly alone.

   The weekly window is ROLLING from first use (``WINDOW_SECONDS``): it starts
   at the first charge after the previous week ran out and lasts 7 days —
   the "chat AI usage limit" shape the owner asked for, and the rule the
   window code already had for every non-monthly window. It is NOT tied to
   the billing anniversary: 30/31 days do not divide into weeks, so an
   anniversary-aligned week would leave a 2-3-day stub every month with a
   whole 40 % of its own. Its excess carries into ITS next week
   (``usage_accounts.weekly_overage_tokens``); the month counts every token
   once, when it was spent.

   The 5-hour window protected the vendor quota, which
   packages/billing/vendor_limits.py now does globally, and it actively hurt:
   Pro's was 369,514 tokens against a 777,572-token 30-minute High clip, so
   it only ever blocked the user's NEXT job for five hours.

   ``TRACKED_WINDOWS`` still records all four windows, so nothing about
   upgrade/downgrade accounting changes, and a Starter account that upgrades
   to Pro starts with a weekly window that already knows this week's usage.

2. **High ความละเอียด is a Pro-and-up feature** (enforced in
   packages/billing/plan_features.py:check_precision). High is 5.2x the
   per-second video rate (328.6 vs 63.4 vendor tokens/s); for a 10-minute clip
   with a voiceover that is 369,451 against 204,762 — nearly double. On the
   three cheapest plans that silently halves the clip count, so it is sold as
   a feature rather than charged as a hidden tax.

3. **Every advertised cap is runnable.** The pre-flight estimate at each
   plan's own ``footage_sec``, at the best precision that plan may pick, is
   192,510 (Free/Lite), 254,610 (Starter) and 689,310 (Pro and up) against
   budgets of 450 k / 800 k / 2 M / 5.6 M and up. Nothing can reach
   ``plan_features.check_run_size`` any more. That is the bug this table
   fixes — a cap that says 30 minutes while a 20-minute clip is refused — and
   tests/test_plan_features.py pins it per plan so it cannot come back.

   The ladder is a ตัดฉากเด่น cap (``VIDEO_CALL_MODES``). The speech modes are
   capped at ``SPEECH_FOOTAGE_SEC`` on every plan instead (owner, 2026-10-01).

── the volume discount (owner, 2026-10-01) ──

Prices did not move; budgets did, upward only. The margin floor at FULL price,
after the January-2027 vendor rise, is 60 % for the top plan and steps down
the ladder — a bigger plan buys each token cheaper. Margin is
``(P - 0.0435 P - 10 - tokens * 50 / 1e6) / P``: Stripe card 3.65 % + ฿10,
Stripe Billing 0.7 %, ฿50 per 1M rate-card tokens at 2027 prices.

    lite 0.8 M 70.5 % · starter 2 M 68.1 % · pro 5.6 M 66.4 %
    studio 12 M 65.0 % · agency 26 M 62.8 % · max 48 M 61.2 %

tests/test_plan_features.py recomputes every row, so a budget edit that
breaks the floor fails there. While the beta ladder runs (half price) the
same budgets earn roughly 27-45 % (docs/unit-economics.md §4).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Literal

WindowKey = Literal["five_hour", "weekly", "monthly", "lifetime"]

#: The weekly window's share of the monthly budget, on the plans that
#: enforce it (rule 1 in the module docstring; owner, 2026-10-01).
WEEKLY_SHARE = 0.40
#: Only the unenforced ``five_hour`` window uses these — kept so its
#: arithmetic is still defined for a tracked window that is read back.
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
#: The English labels the UI shows. ``five_hour`` is unused by every current
#: plan but stays here for the rows that still record it.
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
    #: ตัดฉากเด่น only (``VIDEO_CALL_MODES``); the speech modes share
    #: ``SPEECH_FOOTAGE_SEC`` on every plan.
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
# Free spends a lifetime credit, every paid plan a month, and Pro and up a
# week beside it (rule 1 in the module docstring) — the plan's MAIN window
# (``primary_window``) first. High precision from Pro up
# (rule 2). Budgets step up faster than prices — the volume discount above.
# What the page quotes is DERIVED from these budgets (``plan_cuts``,
# ``plan_cuts_high``, ``plan_cuts_at_cap``), never typed in beside them.
PLAN_LIMITS: dict[str, PlanLimits] = {
    # Free = a one-time credit, never reset: two 10-minute Standard cuts with
    # a voiceover (204,762 each).
    "free": PlanLimits(450_000, ("lifetime",), 1, 1,
                       footage_sec=10 * 60, max_projects=3, music=False, transcode=False,
                       high_precision=False),
    "lite": PlanLimits(800_000, ("monthly",), 1, 3,
                       footage_sec=10 * 60, max_projects=10, transcode=False,
                       high_precision=False),
    "starter": PlanLimits(2_000_000, ("monthly",), 1, 5,
                          footage_sec=20 * 60, max_projects=20,
                          high_precision=False),
    "pro": PlanLimits(5_600_000, ("monthly", "weekly"), 2, 10,
                      footage_sec=30 * 60, queue_lead_sec=QUEUE_LEAD_AHEAD_SEC),
    "studio": PlanLimits(12_000_000, ("monthly", "weekly"), 3, 30,
                         footage_sec=30 * 60, queue_lead_sec=QUEUE_LEAD_FIRST_SEC),
    "agency": PlanLimits(26_000_000, ("monthly", "weekly"), 4, 60,
                         footage_sec=30 * 60, queue_lead_sec=QUEUE_LEAD_FIRST_SEC),
    "max": PlanLimits(48_000_000, ("monthly", "weekly"), 5, 100,
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
# approximate cut count instead — "ตัดได้ราว 30 คลิป/เดือน", plus "ระดับ
# ละเอียดราว 20 คลิป" on a plan that has High, "คิดจากคลิปดิบ 5 นาที". That claim is generated here so the website and the plan screen
# cannot drift from the table, and it is the ONLY place a count is allowed:
# it carries "ราว", it states its basis, and no meter is ever drawn from it.
# The question it answers inside the app — "how many more runs do I have?" —
# is answered by pricing each run before it starts ("งานนี้ใช้ประมาณ 5 %"),
# not by counting anything.

#: Rate-card tokens per second of footage, PROMPT-EXCLUSIVE, per precision,
#: and the fixed part of a cut with a voiceover (prompt + thinking + edit
#: script, 125,390, plus the ~40,000 voiceover pass) — the fitted production
#: model in the module docstring. Every clip count the product quotes is
#: derived from these four numbers, so a re-fit moves every surface at once.
_STANDARD_TOKENS_PER_SEC = 65.6
_HIGH_TOKENS_PER_SEC = 340.1
_TOKENS_PER_SEC: dict[str, float] = {
    "standard": _STANDARD_TOKENS_PER_SEC,
    "high": _HIGH_TOKENS_PER_SEC,
}
_CUT_FIXED_TOKENS = 125_390 + 40_000
#: The basis every quoted count states: "คิดจากคลิปดิบ 5 นาที".
TYPICAL_CUT_SOURCE_SEC = 5 * 60


def cut_tokens(seconds: float, precision: str | None = "standard") -> int:
    """Rate-card tokens one cut of ``seconds`` of source costs at
    ``precision``, voiceover pass included — rounded UP, so a count divided
    from it can only err towards promising less."""
    rate = _TOKENS_PER_SEC.get(precision or "standard", _STANDARD_TOKENS_PER_SEC)
    # round() first: 65.6 * 300 is 19680.000000000004 in binary floating point,
    # and ceil() of that would charge a phantom token.
    return math.ceil(round(rate * seconds, 6)) + _CUT_FIXED_TOKENS


#: What an ordinary cut costs: 5 minutes of source at Standard with a
#: voiceover — 185,070. It is the measurement itself, not a rounded-up guess:
#: the owner asked for HONEST counts (2026-10-01), and honesty here is the
#: floor division below, which never rounds a count up.
TYPICAL_CUT_TOKENS = cut_tokens(TYPICAL_CUT_SOURCE_SEC, "standard")
#: The same 5-minute cut at High (ละเอียด) — 267,420.
TYPICAL_HIGH_CUT_TOKENS = cut_tokens(TYPICAL_CUT_SOURCE_SEC, "high")


def plan_cuts(plan: str | None) -> int:
    """Roughly how many 5-minute Standard cuts the plan's window pays for — the
    pricing page's headline, rounded DOWN. Marketing copy only: never a meter,
    never a quota, never subtracted from."""
    return int(plan_limits(plan).monthly // TYPICAL_CUT_TOKENS)


def plan_cuts_high(plan: str | None) -> int | None:
    """The same count at High (ละเอียด), rounded DOWN; None for a plan that
    cannot pick High (below Pro), which must therefore quote no such number.

    Shown beside ``plan_cuts`` on every plan that has High (owner,
    2026-10-01): a plan sold on its High setting that quotes only the
    Standard count overstates what the feature it was bought for delivers.
    """
    lim = plan_limits(plan)
    if not lim.high_precision:
        return None
    return int(lim.monthly // TYPICAL_HIGH_CUT_TOKENS)


def plan_cuts_at_cap(plan: str | None) -> int:
    """Cuts per window when every clip runs the full ``footage_sec`` at
    Standard — the arithmetic behind "length costs".

    Pro pays for about 30 five-minute cuts but only 19 thirty-minute ones.
    Not quoted on the pricing page today (the 5-minute basis and "ราว" carry
    it there); kept so the docs and tests can state and pin the long-clip
    case from the same model.
    """
    lim = plan_limits(plan)
    return int(lim.monthly // cut_tokens(lim.footage_sec, "standard"))


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
#: They are also the only modes the plan's ``footage_sec`` applies to.
VIDEO_CALL_MODES: frozenset[str] = frozenset({"dub_first", "highlight"})

#: The modes that never send footage to the model as video: speech-to-text,
#: then arithmetic (talking_head) or a transcript-only selection.
SPEECH_MODES: frozenset[str] = frozenset({"talking_head", "speech_scenes", "speech_highlights"})
#: Footage cap for a speech mode, on EVERY plan (owner, 2026-10-01). The
#: per-plan ``footage_sec`` ladder is a ตัดฉากเด่น rule — it was sized on what a
#: cut costs (rule 3 above) — and applying it to these modes was a side effect
#: of the 2026-09-30 refit, not a decision. This is the editor's own per-mode
#: cap (web/src/lib/wizardState.ts ``capSecFor``); change both together. What
#: a long run costs stays bounded by the plan: a run bigger than the whole
#: window is refused by ``plan_features.check_run_size`` (Free can run about
#: 19 minutes of speech_highlights, Lite about 76; talking_head fits every
#: plan at the full two hours).
SPEECH_FOOTAGE_SEC = 2 * 3600

UNLIMITED_PLANS = frozenset({"enterprise"})
#: Unlimited accounts still run at most this many AI jobs at once — a vendor
#: safety cap, not a plan limit.
UNLIMITED_CONCURRENCY = 5
#: Every window is tracked for every plan (a settle charges all of them), even
#: though no plan ENFORCES ``five_hour`` and only Pro and up ``weekly``: the accounting
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
    if window in ("monthly", "lifetime"):
        return limits.monthly
    if window == "weekly":
        return math.floor(limits.monthly * WEEKLY_SHARE)
    if window == "five_hour":
        return math.floor(math.floor(limits.monthly / WEEKS_PER_MONTH) * FIVE_HOUR_SHARE)
    raise KeyError(window)


def primary_window(plan: str | None) -> WindowKey | None:
    """The plan's MAIN window — ``monthly`` (paid) or ``lifetime`` (Free): the
    one ``usage_accounts.overage_tokens`` carries into, and the one a Free
    credit's overage opens after an upgrade. ``weekly`` is never primary: it
    is a pace limit inside the month. None for a plan that enforces nothing."""
    for key in plan_limits(plan).windows:
        if key != "weekly":
            return key
    return None


def enforces_weekly(plan: str | None) -> bool:
    return "weekly" in plan_limits(plan).windows
