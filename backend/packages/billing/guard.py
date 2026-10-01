"""Guard layers 2 and 3: the per-call quota gate and the daily circuit breaker.

Layer 2 — per-call guard (docs/token-billing-plan.md §4.2), the "chat AI
usage limit" model (owner, 2026-10-01). A worker task (or the synchronous
``/plan-dub`` route) runs its paid work inside a ``RunMeter``
(``meter_scope``). Before EVERY model request — first attempt and each retry —
the gateway asks ``before_llm_call``, and the rule is one line:

    send the call while the plan's window (plus any balance the user allowed)
    still has ANYTHING left; at 100 % stop before the next call — a PAUSE.

The pre-run estimate is advice. Nothing here compares a call's or a run's
estimate with what is left, and nothing caps a call's output by it: that is
exactly what cut off run b8ad8c25 on 2026-10-01 — ``max_tokens`` set to
"what is left under estimate × 1.2" (~29.4k there) truncated a legitimate
29,464-token thinking pass, and the user paid 164,756 tokens for no cut.
The meter carries a ``runs.QuotaSnapshot`` taken when the task began, counts
down by what each call really cost, and once nothing is left the next call is
not sent: ``QuotaExhausted`` → the project goes to ``paused_quota`` with the
window, its reset time and what the balance could cover, and resumes from the
same stage. The call that crossed 100 % was already sent; its answer is kept
and its overrun is absorbed (``runs.apply_charge`` charges up to exactly 100 %).

What a call is priced at (``call_budget``) still matters for two things: the
in-flight sum parallel calls share, and the OPTIONAL calls (a quality retry
the caller can live without — ``optional_call``), which alone stay held to
the run's ``ceiling`` (= estimate × 1.2) so a retry never turns a run into
twice the advice. Text is counted locally, each image part at Gemini's flat
258, and video parts from the SECONDS of footage the call site attaches
(``billing_video_sec`` — measured on the server, never a length the client
stated) at the MEASURED vendor rate (``estimate.vendor_video_tokens``, ~66
tokens/s at Standard — the guard used to price 100/s, which made its own
arithmetic 50 % pessimistic about every video call).

Output: a call that sets no ``max_tokens`` of its own gets the run profile's
safety cap (``safety_cap`` — for the single calls a step rests on, the
MODEL's own maximum output from its metadata, 65,536 on today's Gemini 3.x;
16k for the inherently small calls), independent of the estimate and of what
is left. It exists against a runaway, never as a budget. A REQUIRED call that
still ends there (``finish_reason == "length"``) raises ``OutputTruncated``
at once — no retry (owner, 2026-10-01) — logged at error level, which ends
the task as a retryable failure (outcome ``safety_cap``), the call billed like
any other (no refund). An optional call is skipped.

Speech-to-text is admitted the same way per file (``before_stt_clip``),
priced from the WAV's length; a WAV whose length cannot be read is priced from
its size (an upper bound), never as zero.

Layer 3 — circuit breaker (§4.3). Today's (UTC) recorded vendor spend,
Σ ``cost_thb``, against the admin's daily cap (``admin_settings`` key
``circuit_breaker``). At the cap, new jobs are refused (``breaker_open``, at
start); at cap × ``hard_stop_ratio`` in-flight calls stop too
(``breaker_hard_stop``, in the gateway). Admin/unlimited accounts are never
blocked. The first trip of a day writes an audit event and emails the admins.
"""

from __future__ import annotations

import math
import time
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from datetime import time as dtime
from pathlib import Path
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from packages.billing import estimate as estimator
from packages.billing import rate_card
from packages.core.logging import get_logger

log = get_logger(__name__)

#: Characters per token when counting text locally. Deliberately on the
#: generous side for Thai (denser than English), so the guard over- rather
#: than under-prices a prompt.
CHARS_PER_TOKEN = 3.0

LIMIT_STOP_MESSAGE = "หยุดแล้ว: ถึงขีดจำกัดการใช้งานของงานนี้"
#: A required answer ran into the per-call safety cap (``OutputTruncated``).
#: Not the user's doing and not about their quota — say so, and that a retry
#: is the fix.
OUTPUT_TRUNCATED_MESSAGE = (
    "AI ตอบกลับไม่ครบ เพราะคำตอบยาวเกินที่ระบบรับได้ในครั้งเดียว — กดลองใหม่ได้ "
    "หรือขอความยาวผลลัพธ์ที่สั้นลง"
)
SERVICE_PAUSED_MESSAGE = "ระบบหยุดรับงาน AI ชั่วคราว กรุณาลองใหม่ภายหลัง"
#: A run paused because the plan's window ran out — not an error. The client
#: adds the reset time in the viewer's own timezone.
QUOTA_PAUSED_MESSAGE = "พักงานไว้ก่อน: โควตาหมดระหว่างทำงาน — งานที่ทำไปแล้วยังอยู่ ทำต่อได้เมื่อโควตากลับมา"
#: The same pause on a window that never resets (the Free trial credit): the
#: work is still kept, but waiting will not bring the quota back.
QUOTA_SPENT_MESSAGE = "พักงานไว้ก่อน: เครดิตทดลองใช้หมดแล้ว — งานที่ทำไปแล้วยังอยู่ อัปเกรดแพลนเพื่อทำต่อ"
WALLET_HINT = " — ใช้ยอดเงินคงเหลือทำงานนี้ต่อได้"


class RunBudgetExceeded(Exception):
    """The next call would take the run past its ceiling — not sent."""

    code = "limit_stop"

    def __init__(self, run_id: str | None = None) -> None:
        self.run_id = run_id
        super().__init__(LIMIT_STOP_MESSAGE)

    def payload(self) -> dict[str, Any]:
        """What the client needs to explain the stop (and offer the balance).
        The base stop has no window to name: it is this run's own ceiling."""
        return {"code": self.code, "message": str(self)}


class QuotaExhausted(RunBudgetExceeded):
    """The user's plan window (and any balance they allowed) ran out mid-run.

    A PAUSE, not a failure: everything the run produced so far is kept and the
    project resumes from the same stage. It carries what the client needs to
    offer the top-up — which window, when it resets, whether the balance
    covers the rest and how much that is — because without those the editor
    can only say "error" (web/src/lib/usageLimits.ts falls back to
    ``walletCanCover: false``, and the "ใช้ยอดเงินคงเหลือทำต่อ" button never
    appears). What is left is deliberately NOT in it as a token count: users
    never see those (docs/token-billing-plan.md §2) — the amount they act on
    is the baht figure, and the fullness bars come from ``GET /usage/me``.
    """

    code = "limit_reached"

    def __init__(
        self,
        run_id: str | None = None,
        *,
        window: str | None = None,
        resets_at: datetime | None = None,
        wallet_can_cover: bool = False,
        wallet_satang: int = 0,
    ) -> None:
        self.run_id = run_id
        self.window = window
        self.resets_at = resets_at
        self.wallet_can_cover = wallet_can_cover
        self.wallet_satang = wallet_satang
        Exception.__init__(self, QUOTA_PAUSED_MESSAGE)

    def payload(self) -> dict[str, Any]:
        """The one body for this stop, wherever it is reported from — the 402
        of a synchronous route or the paused job row of a worker task."""
        from packages.billing.limits import WINDOW_LABELS, window_resets
        from packages.billing.runs import iso

        message = str(self)
        if self.wallet_can_cover:
            message += WALLET_HINT
        resets = window_resets(self.window or "")
        if not resets:
            message = QUOTA_SPENT_MESSAGE + (WALLET_HINT if self.wallet_can_cover else "")
        return {
            "code": self.code,
            "window": self.window,
            "label": WINDOW_LABELS.get(self.window or "", "limit"),
            "resets_at": iso(self.resets_at),
            # False = this allowance never comes back (the Free trial credit):
            # the client must offer an upgrade, not a countdown.
            "resets": resets,
            "wallet_can_cover": self.wallet_can_cover,
            "wallet_satang": self.wallet_satang,
            "message": message,
        }


#: New work refused because the window is ALREADY at 100 % (``quota_full_refusal``).
QUOTA_FULL_MESSAGE = "โควตารอบนี้ใช้ครบ 100% แล้ว — เริ่มงานใหม่ได้เมื่อรอบใหม่เริ่ม หรือเพิ่มโควตา"
QUOTA_FULL_WEEKLY_MESSAGE = (
    "โควตาสัปดาห์นี้ใช้ครบ 100% แล้ว — เริ่มงานใหม่ได้เมื่อสัปดาห์ใหม่เริ่ม หรือเพิ่มโควตา"
)
QUOTA_FULL_SPENT_MESSAGE = "เครดิตทดลองใช้หมดแล้ว — อัปเกรดแพลนเพื่อเริ่มงานใหม่"


#: A new run whose estimate is bigger than what is left (``remaining_refusal``,
#: owner 2026-10-01). The suggestions are the levers that really shrink the
#: estimate — footage, the Scout engine (medium thinking), Standard precision
#: (a fifth of High's per-second rate), a shorter requested result — then
#: more quota.
REMAINING_TOO_SMALL_MESSAGE = (
    "งานนี้ใหญ่กว่าโควตาที่เหลือในรอบนี้ — ลองใช้วิดีโอที่สั้นลง ขอผลลัพธ์ที่สั้นลง เลือกเอนจิน Scout "
    "หรือความละเอียดมาตรฐาน อัปเกรดแพลน หรือเติมเงินแล้วใช้ยอดเงินคงเหลือ"
)
REMAINING_TOO_SMALL_WEEKLY_MESSAGE = (
    "งานนี้ใหญ่กว่าโควตาที่เหลือของสัปดาห์นี้ — ลองใช้วิดีโอที่สั้นลง ขอผลลัพธ์ที่สั้นลง เลือกเอนจิน Scout "
    "หรือความละเอียดมาตรฐาน รอสัปดาห์ใหม่ อัปเกรดแพลน หรือเติมเงินแล้วใช้ยอดเงินคงเหลือ"
)
REMAINING_TOO_SMALL_SPENT_MESSAGE = (
    "งานนี้ใหญ่กว่าเครดิตทดลองที่เหลือ — ลองใช้วิดีโอที่สั้นลง ขอผลลัพธ์ที่สั้นลง เลือกเอนจิน Scout "
    "หรืออัปเกรดแพลน"
)
#: The wire code of that refusal. It keeps the name it had when it meant "too
#: far past what is left" (2026-10-01, 25 % allowance): shipped web and desktop
#: builds already render it, and the meaning a client acts on — "this new run
#: is too big for what is left; shrink it, wait, or pay" — did not change.
REMAINING_REFUSAL_CODE = "overage_too_large"


def _window_body(state: Any, code: str, message: str, wallet_satang: int) -> dict[str, Any]:
    """The refusal keys every client already reads off ``QuotaExhausted``."""
    from packages.billing.limits import WINDOW_LABELS, window_resets
    from packages.billing.runs import iso

    spare = int(getattr(state, "wallet_satang", 0) or 0)
    return {
        "code": code,
        "window": state.window,
        "label": WINDOW_LABELS.get(state.window or "", "limit"),
        "resets_at": iso(state.resets_at),
        "resets": window_resets(state.window or ""),
        "wallet_can_cover": spare > 0 and spare >= wallet_satang,
        "wallet_satang": max(0, int(wallet_satang)),
        "message": message,
    }


def quota_full_refusal(
    state: Any, *, allow_wallet: bool, need_satang: int = 0
) -> dict[str, Any] | None:
    """The 402 body for new work on a window that is ALREADY at 100 % — None
    when there is nothing to refuse (not full, or the user allowed a balance
    they have to carry it). ``state`` is a ``runs.StartWindow``.

    Same keys as ``QuotaExhausted.payload`` (``code: limit_reached``), so every
    client renders it with the code it already has, plus ``full: true``."""
    from packages.billing.limits import window_resets

    if state is None or not state.full:
        return None
    spare = int(getattr(state, "wallet_satang", 0) or 0)
    if allow_wallet and spare > 0:
        return None
    if not window_resets(state.window or ""):
        message = QUOTA_FULL_SPENT_MESSAGE
    elif state.window == "weekly":
        message = QUOTA_FULL_WEEKLY_MESSAGE
    else:
        message = QUOTA_FULL_MESSAGE
    if spare > 0:
        message += WALLET_HINT
    body = _window_body(state, QuotaExhausted.code, message, min(spare, max(0, int(need_satang))))
    body["wallet_can_cover"] = spare > 0
    return {**body, "full": True}


def remaining_refusal(state: Any, estimate_tokens: int, *, allow_wallet: bool) -> dict[str, Any] | None:
    """The STRICT START GATE (owner, 2026-10-01): the 402 body for a NEW run
    whose pre-run estimate is bigger than what is left of the binding window
    — None when it fits, or when the user allowed a balance that covers the
    shortfall (the balance then pays what goes past the window). ``state`` is
    a ``runs.StartWindow``: the enforced window with the least room (on Pro
    and up the closer-to-full of weekly / monthly — the run must fit both),
    less what the user's runs already in flight still expect to spend.

    This replaced a 25 % / 300k allowance past what is left: a run is now only
    STARTED when it is expected to fit. Once running, the estimate is advice
    again — a run that turns out bigger keeps going call by call, the call in
    flight completes and is charged in full, the excess carries into the
    window's next period, and the run pauses before the next call (§24).
    Resumes never reach this (``billing_start``)."""
    from packages.billing import wallet
    from packages.billing.limits import window_resets

    if state is None:
        return None
    left = max(0, int(state.headroom) - int(getattr(state, "in_flight", 0) or 0))
    short = int(estimate_tokens) - left
    if short <= 0:
        return None
    need = wallet.satang_for_tokens(short)
    spare = int(getattr(state, "wallet_satang", 0) or 0)
    if allow_wallet and spare >= need:
        return None
    if not window_resets(state.window or ""):
        message = REMAINING_TOO_SMALL_SPENT_MESSAGE
    elif state.window == "weekly":
        message = REMAINING_TOO_SMALL_WEEKLY_MESSAGE
    else:
        message = REMAINING_TOO_SMALL_MESSAGE
    return _window_body(state, REMAINING_REFUSAL_CODE, message, need)


class OutputTruncated(Exception):
    """A REQUIRED call stopped at the per-call safety cap: no usable answer.

    Deliberately not a ``RunBudgetExceeded`` (that would read as a quota
    stop) and not a pause (waiting or topping up changes nothing — a retry
    does). It travels like any other failure of the task: the task's own
    handler marks the project ``error`` (retryable) with this message, and
    ``billed_task`` settles the run as ``safety_cap`` — charged what it used,
    like every sent call (owner, 2026-10-01: no refunds for this).
    """

    code = "output_truncated"

    def __init__(self, run_id: str | None = None) -> None:
        self.run_id = run_id
        super().__init__(OUTPUT_TRUNCATED_MESSAGE)

    def payload(self) -> dict[str, Any]:
        return {"code": self.code, "message": str(self)}


class ServicePaused(Exception):
    """The daily circuit breaker is hard-stopped — not sent."""

    code = "service_paused"

    def __init__(self) -> None:
        super().__init__(SERVICE_PAUSED_MESSAGE)


# ── layer 2: the run meter ───────────────────────────────────────────────────

@dataclass
class RunMeter:
    """What one paid run has spent, shared by every call of its task (it is a
    plain object in a ContextVar, so ``asyncio.gather``ed calls share it)."""

    run_id: str
    #: The line OPTIONAL calls are held to (estimate × 1.2). None = unlimited.
    #: Required calls are never refused by it (owner, 2026-10-01).
    ceiling: int | None
    spent: int = 0
    in_flight: int = 0
    stopped: bool = False
    #: Output + thinking a call is EXPECTED to write (the estimate's figure):
    #: what it is priced at in flight. Not what it may write — see output_cap.
    default_max_output: int = 8_000
    #: The per-call safety cap sent as ``max_tokens`` to a call that sets
    #: none (``estimate.ModeProfile.output_cap``; ``estimate.MODEL_MAX`` = the
    #: model's own maximum — ``safety_cap``).
    output_cap: int = estimator.DEFAULT_OUTPUT_CAP
    #: The exception that stopped the run, raised again for any later call
    #: (a sibling of an ``asyncio.gather``), so a quota pause is never turned
    #: into a bare stop by whichever sibling happens to raise first.
    stop_exc: BaseException | None = None
    #: Price, in vendor input tokens, of the run's footage — used for a call
    #: that attaches video/image parts (they cannot be counted locally).
    media_input_tokens: int = 0
    kind: str | None = None
    unlimited: bool = False
    #: The in-flight budget of the speech-to-text file being transcribed.
    stt_budget: int = 0
    stops: list[str] = field(default_factory=list)
    #: The plan quota left when this task started (None: nothing to stop at).
    #: Decremented locally against ``spent`` — see ``quota_left``.
    quota: Any = None
    #: ``spent`` when the snapshot was taken (a later step of a chain starts
    #: from what earlier steps already spent AND already charged).
    quota_baseline: int = 0
    #: What the run still expects to spend, for the "how much baht" figure.
    estimate: int = 0

    def quota_left(self) -> int | None:
        """Rate-card tokens left in the plan window (plus the balance the run
        may use) after what this task has really spent; None when there is no
        quota to run out of. Calls in flight are NOT subtracted: what decides
        whether a call is sent is whether anything is left, not whether its
        price fits (owner, 2026-10-01)."""
        if self.quota is None or getattr(self.quota, "unlimited", False):
            return None
        return int(self.quota.budget) - (self.spent - self.quota_baseline)


_meter: ContextVar[RunMeter | None] = ContextVar("billing_run_meter", default=None)


def current_meter() -> RunMeter | None:
    return _meter.get()


def set_meter(meter: RunMeter | None) -> Token[RunMeter | None]:
    return _meter.set(meter)


def reset_meter(token: Token[RunMeter | None]) -> None:
    _meter.reset(token)


@contextmanager
def meter_scope(meter: RunMeter | None) -> Iterator[RunMeter | None]:
    token = _meter.set(meter)
    try:
        yield meter
    finally:
        _meter.reset(token)


def meter_for_run(run: Any, quota: Any = None) -> RunMeter:
    """A meter for an ``ai_runs`` row, starting from what it already spent
    (a later step of a multi-task chain continues the same budget).

    ``quota`` — a ``runs.QuotaSnapshot`` — is what is left of the plan's
    window; without it the meter only enforces this run's own ceiling.
    """
    from packages.core.settings import get_settings

    profile = estimator.MODE_PROFILES.get(str(run.kind))
    media = 0
    if profile is not None and profile.uses_video:
        media = estimator.vendor_video_tokens(float(run.media_sec or 0.0), run.precision)
    spent = int(run.actual_tokens or 0)
    return RunMeter(
        run_id=str(run.id),
        ceiling=None if run.unlimited else int(run.ceiling_tokens or 0),
        spent=spent,
        default_max_output=profile.max_output if profile else get_settings().llm_max_output_tokens,
        output_cap=profile.output_cap if profile else estimator.DEFAULT_OUTPUT_CAP,
        media_input_tokens=media,
        kind=str(run.kind),
        unlimited=bool(run.unlimited),
        quota=None if run.unlimited else quota,
        quota_baseline=spent,
        estimate=int(run.estimate_tokens or 0),
    )


_VIDEO_MIME_HINTS = ("video/", ".mp4", ".mov", ".webm")


def _media_blocks(messages: Sequence[dict[str, Any]]) -> tuple[int, int]:
    """(image parts, video/unknown file parts) attached to ``messages``."""
    images = videos = 0
    for m in messages:
        content = m.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            kind = block.get("type")
            if kind == "image_url":
                images += 1
            elif kind in ("file", "video_url"):
                raw = block.get("file")
                sub: dict[str, Any] = raw if isinstance(raw, dict) else {}
                hint = f"{sub.get('format') or ''} {sub.get('filename') or ''}".lower()
                if hint.startswith("image/") or any(x in hint for x in (".jpg", ".jpeg", ".png", ".webp")):
                    images += 1
                else:
                    videos += 1
    return images, videos


def count_text_tokens(messages: Sequence[dict[str, Any]]) -> int:
    """Local, provider-free count of the text in ``messages``."""
    chars = 0
    for m in messages:
        content = m.get("content")
        if isinstance(content, str):
            chars += len(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    chars += len(str(block.get("text") or ""))
    return math.ceil(chars / CHARS_PER_TOKEN)


def input_budget(
    meter: RunMeter,
    messages: Sequence[dict[str, Any]],
    *,
    video_sec: float | None = None,
    video_precision: str | None = None,
) -> int:
    """Vendor input tokens a call may use: its text counted locally, each image
    at Gemini's flat 258, and its video parts from ``video_sec`` — the total
    length of every video file the call attaches, at the sampling density it
    asks for (``video_precision``), at the vendor's MEASURED per-second rate.
    Without ``video_sec`` a call with video parts is priced at the run's own
    footage."""
    images, videos = _media_blocks(messages)
    tokens = count_text_tokens(messages) + images * estimator.FRAME_TOKENS
    if video_sec is not None:
        tokens += estimator.vendor_video_tokens(float(video_sec), video_precision)
    elif videos:
        tokens += meter.media_input_tokens
    return tokens


def safety_cap(meter: RunMeter, model: str) -> int | None:
    """The per-call safety cap for ``model`` in this run: the profile's own
    number, or — for the single calls a step rests on (``MODEL_MAX``) — the
    model's maximum output from its metadata. None: the model is unknown to
    LiteLLM, so no ``max_tokens`` is sent at all."""
    if int(meter.output_cap or 0) > 0:
        return int(meter.output_cap)
    from packages.llm.config import model_max_output_tokens

    return model_max_output_tokens(model)


def _output_cap(meter: RunMeter, model: str, input_tokens: int) -> int | None:
    """``max_tokens`` for a call that sets none, in vendor tokens.

    A REQUIRED call gets the safety cap — never less because the estimate was
    smaller or the window is nearly spent: the quota is enforced BETWEEN
    calls, and cutting an answer off mid-thought only throws paid work away.
    An OPTIONAL call is also kept inside what is left under the run's
    ceiling, so a quality retry cannot overrun the advice."""
    cap = safety_cap(meter, model)
    if not _optional.get() or meter.ceiling is None:
        return cap
    rate_in, rate_out = rate_card.card().llm[rate_card.family_for(model)].rates_for(input_tokens)
    if rate_out <= 0:
        return cap
    room = max(0, math.floor((meter.ceiling - meter.spent - meter.in_flight - input_tokens * rate_in) / rate_out))
    return room if cap is None else min(cap, room)


@dataclass(frozen=True)
class Admission:
    """What ``before_llm_call`` admitted."""

    #: Rate-card tokens held in flight until ``after_llm_call``.
    budget: int = 0
    #: Vendor input tokens the call was priced at.
    input_tokens: int = 0
    #: ``max_tokens`` the gateway must send (None: leave the request as is).
    max_tokens: int | None = None
    #: Rate-card tokens for the input part alone — what a timed-out or
    #: cancelled attempt is assumed to have cost when the vendor said nothing.
    input_charge: int = 0


def call_budget(
    meter: RunMeter,
    model: str,
    messages: Sequence[dict[str, Any]],
    extra: dict[str, Any],
    *,
    input_tokens: int | None = None,
    video_sec: float | None = None,
    video_precision: str | None = None,
) -> int:
    """Rate-card tokens this call may cost at most (input counted before
    sending, output bounded by its budget). ``input_tokens`` — a call site's
    own count (``billing_input_tokens``) — wins over the local count."""
    inp = (
        int(input_tokens) if input_tokens is not None
        else input_budget(meter, messages, video_sec=video_sec, video_precision=video_precision)
    )
    max_out = extra.get("max_tokens") or extra.get("max_completion_tokens") or meter.default_max_output
    return rate_card.tokens_for_llm(model, inp, 0, int(max_out))


class OptionalCallSkipped(RunBudgetExceeded):
    """An OPTIONAL call (a quality retry the caller can live without) did not
    fit — it was skipped, the run itself goes on."""


_optional: ContextVar[bool] = ContextVar("billing_optional_call", default=False)


@contextmanager
def optional_call() -> Iterator[None]:
    """Mark the calls inside as optional: past the ceiling they raise
    ``OptionalCallSkipped`` WITHOUT stopping the run (e.g. dub_ai's second
    attempt when the first answer overran the footage — the first answer is
    still usable)."""
    token = _optional.set(True)
    try:
        yield
    finally:
        _optional.reset(token)


def _quota_stop(meter: RunMeter, budget: int) -> QuotaExhausted:
    """The pause for a call the plan's window cannot pay for, priced with what
    finishing the run would still cost (its estimate, or at least this call)."""
    from packages.billing import wallet

    left = meter.quota_left() or 0
    remaining = max(budget, meter.estimate - (meter.spent - meter.quota_baseline))
    need = wallet.satang_for_tokens(max(0, remaining - max(0, left)))
    spare = int(getattr(meter.quota, "wallet_satang", 0) or 0)
    log.warning(
        "run_quota_stop", run_id=meter.run_id, kind=meter.kind, spent=meter.spent,
        in_flight=meter.in_flight, call_budget=budget, quota_left=left,
        window=getattr(meter.quota, "window", None), need_satang=need, wallet_satang=spare,
    )
    exc = QuotaExhausted(
        meter.run_id,
        window=getattr(meter.quota, "window", None),
        resets_at=getattr(meter.quota, "resets_at", None),
        wallet_can_cover=need > 0 and spare >= need,
        wallet_satang=need,
    )
    meter.stopped = True
    meter.stop_exc = exc
    meter.stops.append(f"quota left={left} call={budget}")
    return exc


def admit(meter: RunMeter, budget: int) -> None:
    """Hold ``budget`` in flight, or refuse (the call is not sent).

    A required call is refused only when the plan's window (and any balance
    the run may use) has NOTHING left — a pause. It is never refused because
    its own price, or the run's estimate, exceeds what is left (owner,
    2026-10-01): it is sent, and ``runs.apply_charge`` stops the charge at
    exactly 100 %. An optional call is also held to the run's ceiling."""
    if meter.stopped:
        raise meter.stop_exc or RunBudgetExceeded(meter.run_id)
    optional = _optional.get()
    left = meter.quota_left()
    if left is not None and left <= 0:
        # An optional call is skipped (the run keeps the answer it has);
        # anything else pauses the run before it is sent.
        if optional:
            raise OptionalCallSkipped(meter.run_id)
        raise _quota_stop(meter, budget)
    if optional and (
        (left is not None and budget + meter.in_flight > left)
        or (meter.ceiling is not None and meter.spent + meter.in_flight + budget > meter.ceiling)
    ):
        # A nice-to-have must FIT — what is left of the window and the run's
        # ceiling — or it is not worth pushing the user toward 100 % for.
        log.warning(
            "run_guard_optional_skipped", run_id=meter.run_id, kind=meter.kind, spent=meter.spent,
            in_flight=meter.in_flight, call_budget=budget, ceiling=meter.ceiling, quota_left=left,
        )
        raise OptionalCallSkipped(meter.run_id)
    meter.in_flight += budget


def settle_call(meter: RunMeter, budget: int, charged: int) -> None:
    """The call ended: drop its in-flight budget, add what it really cost."""
    meter.in_flight = max(0, meter.in_flight - budget)
    meter.spent += max(0, int(charged))


async def before_llm_call(
    model: str,
    messages: Sequence[dict[str, Any]],
    extra: dict[str, Any],
    *,
    input_tokens: int | None = None,
    video_sec: float | None = None,
    video_precision: str | None = None,
) -> Admission:
    """Gateway hook, before each attempt. Returns what was admitted (an empty
    ``Admission`` when no paid run is active — scripts, probes).

    ``extra`` must not carry a ``max_tokens`` the guard itself set on an
    earlier attempt (the gateway removes it): it would be read as the call
    site's own output budget."""
    meter = current_meter()
    if meter is None:
        return Admission()
    inp = (
        int(input_tokens) if input_tokens is not None
        else input_budget(meter, messages, video_sec=video_sec, video_precision=video_precision)
    )
    budget = call_budget(meter, model, messages, extra, input_tokens=inp)
    if not meter.unlimited and await breaker_hard_stop():
        raise ServicePaused()
    caller_cap = extra.get("max_tokens") or extra.get("max_completion_tokens")
    cap = None if caller_cap else _output_cap(meter, model, inp)
    admit(meter, budget)
    if cap is not None and cap <= 0:
        # An optional call with no room left under the ceiling: sending it
        # with max_tokens=0 would buy an empty answer.
        meter.in_flight = max(0, meter.in_flight - budget)
        raise OptionalCallSkipped(meter.run_id)
    return Admission(
        budget=budget, input_tokens=inp, max_tokens=cap,
        input_charge=rate_card.tokens_for_llm(model, inp, 0, 0),
    )


def output_truncated() -> None:
    """The answer stopped at the ``max_tokens`` the guard set. An optional
    call is skipped (the run keeps its earlier answer). A required one hit
    the per-call SAFETY cap — which should never happen — and has no usable
    answer: ``OutputTruncated`` ends the task as a retryable failure.
    Logged at error level so it reaches monitoring: if this fires, the cap
    for that kind is too low or the model ran away."""
    meter = current_meter()
    if meter is None:
        return
    if _optional.get():
        log.warning("run_guard_optional_truncated", run_id=meter.run_id, kind=meter.kind, spent=meter.spent)
        raise OptionalCallSkipped(meter.run_id)
    log.error("run_guard_safety_cap_hit", run_id=meter.run_id, kind=meter.kind, spent=meter.spent,
              output_cap=meter.output_cap)
    meter.stops.append(f"safety cap {meter.output_cap} hit at spent={meter.spent}")
    raise OutputTruncated(meter.run_id)


def after_llm_call(budget: int, charged: int) -> None:
    meter = current_meter()
    if meter is not None:
        settle_call(meter, budget, charged)


#: The lowest PCM byte rate there is (8 kHz, 8-bit, mono): a file's size
#: divided by it can only OVER-state how long the audio is.
MIN_PCM_BYTES_PER_SEC = 8_000


def stt_clip_seconds(wav: Path) -> float:
    """How long ``wav`` is, for pricing — measured, or, when the file cannot be
    measured, an upper bound from its size. Never zero for a non-empty file:
    an unreadable length used to price the file at nothing and send it anyway."""
    from packages.video.ffmpeg_bin import MediaUnmeasurable, measure_media

    try:
        return measure_media(wav).duration_sec
    except MediaUnmeasurable:
        try:
            size = wav.stat().st_size
        except OSError:
            size = 0
        bound = size / MIN_PCM_BYTES_PER_SEC
        log.warning("stt_clip_length_bounded", file=wav.name, bytes=size, seconds=round(bound, 1))
        return bound


async def before_stt_clip(clip_index: int, wav: Path) -> None:
    """``run_transcription`` hook, before each file is sent: its length is
    known, so its price is exact. Raises instead of sending."""
    meter = current_meter()
    if meter is None:
        return
    budget = rate_card.tokens_for_stt(stt_clip_seconds(wav))
    if not meter.unlimited and await breaker_hard_stop():
        raise ServicePaused()
    admit(meter, budget)
    # STT is sequential: the clip's budget stays in flight until its row is
    # recorded (``after_stt_clip``), which settles the real billed seconds.
    meter.stt_budget = budget


def after_stt_clip(charged: int) -> None:
    meter = current_meter()
    if meter is not None:
        budget, meter.stt_budget = meter.stt_budget, 0
        settle_call(meter, budget, charged)


# ── layer 3: the circuit breaker ─────────────────────────────────────────────

BREAKER_KEY = "circuit_breaker"
DEFAULT_BREAKER: dict[str, Any] = {
    "enabled": True,
    "daily_cap_thb": 3000.0,
    "hard_stop_ratio": 1.25,
    "alert_email": None,
}
SPEND_CACHE_SEC = 30.0
_spend_cache: tuple[float, date, float] | None = None  # (expires, day, thb)
_config_cache: tuple[float, dict[str, Any]] | None = None
_alerted_days: set[date] = set()


def invalidate_cache() -> None:
    global _spend_cache, _config_cache
    _spend_cache = None
    _config_cache = None


def _today() -> date:
    return datetime.now(UTC).date()


async def _session() -> AsyncSession:
    from packages.db.session import get_sessionmaker

    session = get_sessionmaker()()
    await session.execute(text("SET search_path TO core, public"))
    return session


def normalize_breaker(value: dict[str, Any] | None) -> dict[str, Any]:
    out = dict(DEFAULT_BREAKER)
    for key in DEFAULT_BREAKER:
        if isinstance(value, dict) and key in value:
            out[key] = value[key]
    out["enabled"] = bool(out["enabled"])
    out["daily_cap_thb"] = max(0.0, float(out["daily_cap_thb"] or 0.0))
    out["hard_stop_ratio"] = max(1.0, float(out["hard_stop_ratio"] or 1.0))
    return out


async def load_breaker(session: AsyncSession) -> dict[str, Any]:
    from packages.db.models.admin import AdminSetting

    row = (
        await session.execute(select(AdminSetting.value).where(AdminSetting.key == BREAKER_KEY))
    ).scalar_one_or_none()
    return normalize_breaker(row)


async def save_breaker(session: AsyncSession, value: dict[str, Any], actor_id: int | None) -> dict[str, Any]:
    from packages.db.models.admin import AdminSetting

    clean = normalize_breaker(value)
    row = (
        await session.execute(select(AdminSetting).where(AdminSetting.key == BREAKER_KEY).with_for_update())
    ).scalar_one_or_none()
    if row is None:
        session.add(AdminSetting(key=BREAKER_KEY, value=clean, updated_by=actor_id))
    else:
        row.value = clean
        row.updated_by = actor_id
    await session.flush()
    invalidate_cache()
    return clean


async def spend_on(session: AsyncSession, day: date) -> float:
    """Σ recorded vendor cost (THB) on a UTC day, every account included."""
    from packages.db.models.llm_usage import LlmUsageLog
    from packages.db.models.stt_usage import SttUsageLog

    start = datetime.combine(day, dtime.min, tzinfo=UTC)
    end = datetime.combine(date.fromordinal(day.toordinal() + 1), dtime.min, tzinfo=UTC)
    llm = (
        await session.execute(
            select(func.coalesce(func.sum(LlmUsageLog.cost_thb), 0)).where(
                LlmUsageLog.created_at >= start, LlmUsageLog.created_at < end
            )
        )
    ).scalar_one()
    stt = (
        await session.execute(
            select(func.coalesce(func.sum(SttUsageLog.cost_thb), 0)).where(
                SttUsageLog.created_at >= start, SttUsageLog.created_at < end
            )
        )
    ).scalar_one()
    return float(llm or 0) + float(stt or 0)


async def _state() -> tuple[dict[str, Any], float]:
    """(config, today's spend) — each cached for ``SPEND_CACHE_SEC`` per
    process, so the gateway's per-call check costs no query most of the time."""
    global _spend_cache, _config_cache
    now = time.monotonic()
    day = _today()
    config = _config_cache[1] if _config_cache and _config_cache[0] > now else None
    spend = _spend_cache[2] if _spend_cache and _spend_cache[0] > now and _spend_cache[1] == day else None
    if config is None or spend is None:
        session = await _session()
        try:
            if config is None:
                config = await load_breaker(session)
                _config_cache = (now + SPEND_CACHE_SEC, config)
            if spend is None:
                spend = await spend_on(session, day)
                _spend_cache = (now + SPEND_CACHE_SEC, day, spend)
        finally:
            await session.close()
    return config, spend


async def breaker_open() -> bool:
    """New jobs are refused (checked at job start)."""
    try:
        config, spend = await _state()
    except Exception as exc:  # noqa: BLE001 — the breaker must not take the product down
        log.warning("circuit_breaker_unreadable", error=str(exc)[:200])
        return False
    tripped = bool(config["enabled"]) and config["daily_cap_thb"] > 0 and spend >= config["daily_cap_thb"]
    if tripped:
        await _alert_once(config, spend)
    return tripped


async def breaker_hard_stop() -> bool:
    """In-flight calls stop too (checked per call in the gateway)."""
    try:
        config, spend = await _state()
    except Exception as exc:  # noqa: BLE001
        log.warning("circuit_breaker_unreadable", error=str(exc)[:200])
        return False
    cap = config["daily_cap_thb"]
    return bool(config["enabled"]) and cap > 0 and spend >= cap * config["hard_stop_ratio"]


async def status() -> dict[str, Any]:
    """The admin view: settings + today's spend + whether it tripped."""
    invalidate_cache()
    config, spend = await _state()
    cap = config["daily_cap_thb"]
    return {
        **config,
        "day": _today().isoformat(),
        "spend_today_thb": round(spend, 2),
        "tripped": bool(config["enabled"]) and cap > 0 and spend >= cap,
        "hard_stopped": bool(config["enabled"]) and cap > 0 and spend >= cap * config["hard_stop_ratio"],
    }


async def _claim_alert(day: date) -> bool:
    """True exactly once per UTC day across processes (Redis SETNX; an
    in-process set when Redis is down)."""
    if day in _alerted_days:
        return False
    _alerted_days.add(day)
    try:
        import redis.asyncio as aioredis

        from packages.core.settings import get_settings

        client = aioredis.from_url(get_settings().redis_url, socket_timeout=1, socket_connect_timeout=1)
        try:
            return bool(await client.set(f"noey:cb:alerted:{day.isoformat()}", "1", nx=True, ex=2 * 86_400))
        finally:
            await client.aclose()
    except Exception as exc:  # noqa: BLE001 — fall back to this process's memory
        log.warning("circuit_breaker_alert_claim_failed", error=str(exc)[:200])
        return True


async def _alert_once(config: dict[str, Any], spend: float) -> None:
    day = _today()
    if not await _claim_alert(day):
        return
    log.error("circuit_breaker_tripped", day=day.isoformat(), spend_thb=round(spend, 2),
              cap_thb=config["daily_cap_thb"])
    try:
        from packages.admin import auth as admin_auth
        from packages.db.models.core_auth import User

        session = await _session()
        try:
            await admin_auth.audit(
                session, "circuit_breaker_tripped",
                detail={"day": day.isoformat(), "spend_thb": round(spend, 2), "cap_thb": config["daily_cap_thb"]},
            )
            recipients = [str(config["alert_email"])] if config.get("alert_email") else list(
                (
                    await session.execute(
                        select(User.email).where(User.is_admin.is_(True), User.is_active.is_(True))
                    )
                ).scalars().all()
            )
            await session.commit()
        finally:
            await session.close()
        await _email_admins(recipients, day, spend, float(config["daily_cap_thb"]))
    except Exception as exc:  # noqa: BLE001 — an alert problem must not block anything
        log.warning("circuit_breaker_alert_failed", error=str(exc)[:200])


async def _email_admins(recipients: list[str], day: date, spend: float, cap: float) -> None:
    from packages.core.settings import get_settings
    from packages.email import templates
    from packages.email.client import get_mailer
    from packages.email.message import Address, OutgoingEmail

    mailer = get_mailer()
    if mailer is None or not recipients:
        log.warning("circuit_breaker_alert_not_emailed", reason="email not configured" if mailer is None else "no admins")
        return
    brand = get_settings().email_from_name.strip() or "Noey Studio"
    content = templates.circuit_breaker_tripped(brand=brand, day=day.isoformat(), spend_thb=spend, cap_thb=cap)
    for address in recipients:
        try:
            await mailer.send(OutgoingEmail(to=Address(address), content=content, category="circuit_breaker"))
        except Exception as exc:  # noqa: BLE001
            log.warning("circuit_breaker_alert_send_failed", error=str(exc)[:200])
