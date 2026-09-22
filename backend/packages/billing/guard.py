"""Guard layers 2 and 3: the per-call job ceiling and the daily circuit breaker.

Layer 2 — per-call guard (docs/token-billing-plan.md §4.2). A worker task
(or the synchronous ``/plan-dub`` route) runs its paid work inside a
``RunMeter`` (``meter_scope``). Before EVERY model request — first attempt
and each retry — the gateway asks ``before_llm_call``:

    spent + in_flight + this_call_max  must stay ≤  ceiling (= estimate × 1.2)

``this_call_max`` is the rate-card price of the input counted before sending
plus the output budget. Text is counted locally, each image part at Gemini's
flat 258, and video parts from the SECONDS of footage the call site attaches
(``billing_video_sec`` — every file of the request: source proxies, a preview,
a style reference — measured on the server, never a length the client
stated). A call that attaches video without saying how much falls back to the
run's own footage estimate. Otherwise the call is NOT sent: the meter is
stopped and ``RunBudgetExceeded`` raised, which ends the task (``limit_stop``:
the user is charged at most the reservation — runs.charge_for).

The output budget is the call's ``max_tokens`` when the call site sets one,
else the run profile's ``max_output`` (estimate.MODE_PROFILES) — the same
figure the reservation was computed from, so the guard never stops a run the
estimate allowed. A sent call cannot be stopped midway, so its OUTPUT is what
could still overrun: for a call that sets no ``max_tokens`` of its own, the
admission also returns ``max_tokens`` = the output the run can still afford
(ceiling − spent − in flight − this input, at the model's output rate). That
is at least the profile's ``max_output`` (admission already checked it fits)
and truncates only an answer that would have breached the ceiling anyway —
a runaway 25k-token thinking pass. A call cut off there (``finish_reason ==
"length"``) is a ``limit_stop`` (``output_truncated``), not our failure.
Calls running in parallel (``asyncio.gather``) are each capped at what was
left when THEY were admitted, so together they can exceed the ceiling by at
most what an earlier one wrote past its own budget.

Speech-to-text is checked the same way per file (``before_stt_clip``), priced
from the WAV's length; a WAV whose length cannot be read is priced from its
size (an upper bound), never as zero.

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
SERVICE_PAUSED_MESSAGE = "ระบบหยุดรับงาน AI ชั่วคราว กรุณาลองใหม่ภายหลัง"


class RunBudgetExceeded(Exception):
    """The next call would take the run past its ceiling — not sent."""

    code = "limit_stop"

    def __init__(self, run_id: str | None = None) -> None:
        self.run_id = run_id
        super().__init__(LIMIT_STOP_MESSAGE)


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
    #: None = unlimited account: nothing to stop at.
    ceiling: int | None
    spent: int = 0
    in_flight: int = 0
    stopped: bool = False
    #: Output + thinking budget for a call that sets no max_tokens.
    default_max_output: int = 8_000
    #: Price, in vendor input tokens, of the run's footage — used for a call
    #: that attaches video/image parts (they cannot be counted locally).
    media_input_tokens: int = 0
    kind: str | None = None
    unlimited: bool = False
    #: The in-flight budget of the speech-to-text file being transcribed.
    stt_budget: int = 0
    stops: list[str] = field(default_factory=list)


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


def meter_for_run(run: Any) -> RunMeter:
    """A meter for an ``ai_runs`` row, starting from what it already spent
    (a later step of a multi-task chain continues the same budget)."""
    from packages.core.settings import get_settings

    profile = estimator.MODE_PROFILES.get(str(run.kind))
    media = 0
    if profile is not None and profile.uses_video:
        media = estimator.video_input_tokens(float(run.media_sec or 0.0), run.precision)
    return RunMeter(
        run_id=str(run.id),
        ceiling=None if run.unlimited else int(run.ceiling_tokens or 0),
        spent=int(run.actual_tokens or 0),
        default_max_output=profile.max_output if profile else get_settings().llm_max_output_tokens,
        media_input_tokens=media,
        kind=str(run.kind),
        unlimited=bool(run.unlimited),
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
    asks for (``video_precision``). Without ``video_sec`` a call with video
    parts is priced at the run's own footage estimate."""
    images, videos = _media_blocks(messages)
    tokens = count_text_tokens(messages) + images * estimator.FRAME_TOKENS
    if video_sec is not None:
        tokens += estimator.video_input_tokens(float(video_sec), video_precision)
    elif videos:
        tokens += meter.media_input_tokens
    return tokens


def _output_cap(meter: RunMeter, model: str, input_tokens: int) -> int | None:
    """The output + thinking the run can still afford for this call, in vendor
    tokens (None: nothing to cap — unlimited run)."""
    if meter.ceiling is None:
        return None
    rate_in, rate_out = rate_card.card().llm[rate_card.family_for(model)].rates_for(input_tokens)
    room = meter.ceiling - meter.spent - meter.in_flight - input_tokens * rate_in
    return max(0, math.floor(room / rate_out)) if rate_out > 0 else None


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


def admit(meter: RunMeter, budget: int) -> None:
    """Reserve ``budget`` in flight, or refuse (the call is not sent)."""
    if meter.stopped:
        raise RunBudgetExceeded(meter.run_id)
    if meter.ceiling is not None and meter.spent + meter.in_flight + budget > meter.ceiling:
        optional = _optional.get()
        log.warning(
            "run_guard_stop", run_id=meter.run_id, kind=meter.kind, spent=meter.spent,
            in_flight=meter.in_flight, call_budget=budget, ceiling=meter.ceiling, optional=optional,
        )
        if optional:
            raise OptionalCallSkipped(meter.run_id)
        meter.stopped = True
        meter.stops.append(f"spent={meter.spent} in_flight={meter.in_flight} call={budget}")
        raise RunBudgetExceeded(meter.run_id)
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
    return Admission(
        budget=budget, input_tokens=inp, max_tokens=cap,
        input_charge=rate_card.tokens_for_llm(model, inp, 0, 0),
    )


def output_truncated() -> None:
    """The answer stopped at the output cap the guard set: the run has used
    its ceiling. Stops the run (``limit_stop``) — or, for an optional call,
    skips it and lets the run keep its earlier answer."""
    meter = current_meter()
    if meter is None:
        return
    log.warning("run_guard_output_truncated", run_id=meter.run_id, kind=meter.kind, spent=meter.spent,
                ceiling=meter.ceiling, optional=_optional.get())
    if _optional.get():
        raise OptionalCallSkipped(meter.run_id)
    meter.stopped = True
    meter.stops.append(f"output truncated at spent={meter.spent}")
    raise RunBudgetExceeded(meter.run_id)


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
