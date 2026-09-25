"""Durable usage recording: one row per vendor request, never lost silently.

Called from the two gateway paths (every attempt that reached the model —
successful, failed, retried) and from speech-to-text once per billed file.
Each row carries both figures (see packages/db/models/llm_usage.py):
rate-card ``tokens`` at ``rate_version`` (what the user is charged) and the
real ``cost_thb`` at ``fx_rate`` (what we paid).

Durability, in order:

1. awaited insert — row + ``ai_runs.actual_tokens`` accrual + the charge on
   the user's windows/balance, all in ONE transaction — retried
   ``len(RETRY_DELAYS)`` times;
2. then the row goes to the Redis list ``OUTBOX_KEY``, which the worker cron
   ``drain_usage_outbox`` replays every minute (``idem_key`` makes a replay
   insert once);
3. then, as a last resort, ``usage_record_lost`` is logged at ERROR with the
   whole row so it can be re-entered by hand.

Nothing here ever raises into the AI path: a recording problem must not fail
a user's job that already cost us money.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any, Literal

from sqlalchemy import text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError

from packages.billing import rate_card
from packages.core.logging import get_logger

if TYPE_CHECKING:
    from packages.llm.usage import UsageCtx

log = get_logger(__name__)

OUTBOX_KEY = "noey:usage_outbox"
RETRY_DELAYS: tuple[float, ...] = (0.2, 0.5, 1.0)
DRAIN_BATCH = 500

LlmStatus = Literal["ok", "failed", "retry", "cancelled"]
Table = Literal["llm", "stt"]


# ── row building ─────────────────────────────────────────────────────────────

def _base_row(ctx: UsageCtx) -> dict[str, Any]:
    return {
        "user_id": int(ctx.user_id),
        "tenant_id": int(ctx.tenant_id),
        "reference_id": ctx.reference_id,
        "run_id": getattr(ctx, "run_id", None),
        "job_id": getattr(ctx, "job_id", None),
        "rate_version": rate_card.CURRENT_RATE_VERSION,
        "idem_key": str(uuid.uuid4()),
        "created_at": datetime.now(UTC),
    }


def llm_row(
    ctx: UsageCtx,
    *,
    model: str,
    status: LlmStatus,
    input_tokens: int,
    cached_tokens: int,
    output_tokens: int,
) -> dict[str, Any]:
    inp = max(0, int(input_tokens or 0))
    cached = min(max(0, int(cached_tokens or 0)), inp)
    out = max(0, int(output_tokens or 0))
    return {
        **_base_row(ctx),
        "feature": ctx.feature,
        "model": (model or "")[:128],
        "status": status,
        "input_tokens": inp,
        "cached_tokens": cached,
        "output_tokens": out,
        "tokens": rate_card.tokens_for_llm(model, inp, cached, out),
    }


def stt_row(
    ctx: UsageCtx,
    *,
    clip_index: int | None,
    billed_sec: float,
    model: str,
    keyterms: bool,
    status: str = "ok",
) -> dict[str, Any]:
    sec = max(0.0, float(billed_sec or 0.0))
    return {
        **_base_row(ctx),
        "audio_sec": sec,
        "model": (model or "")[:64],
        "keyterms": bool(keyterms),
        "clip_index": clip_index,
        "status": status,
        "tokens": rate_card.tokens_for_stt(sec),
    }


async def _price(session: Any, table: Table, row: dict[str, Any]) -> None:
    """Fill ``cost_thb`` / ``fx_rate`` in place; leave them null on any problem.

    Null (not zero) when there is nothing to price: a failed attempt with no
    reported usage proves the request happened without claiming a cost.
    """
    if row.get("cost_thb") is not None:
        return  # replayed from the outbox — priced when it first happened
    try:
        from packages.billing import vendor_cost

        pricing = await vendor_cost.current_pricing(session)
        if table == "llm":
            if not (row["input_tokens"] or row["output_tokens"]):
                return
            cost = vendor_cost.cost_thb_for_llm(
                pricing, row["model"], row["input_tokens"], row["cached_tokens"],
                row["output_tokens"], row["created_at"].date(),
            )
        else:
            if row["audio_sec"] <= 0:
                return
            cost = vendor_cost.cost_thb_for_stt(pricing, row["model"], row["audio_sec"], row["keyterms"])
        row["cost_thb"] = cost
        row["fx_rate"] = Decimal(str(round(pricing.usd_thb, 4)))
    except Exception as exc:  # noqa: BLE001 — cost is for the admin; the row matters more
        log.warning("usage_cost_unpriced", table=table, error=str(exc)[:200])


# ── writing ──────────────────────────────────────────────────────────────────

def _model_for(table: Table) -> Any:
    if table == "llm":
        from packages.db.models.llm_usage import LlmUsageLog

        return LlmUsageLog
    from packages.db.models.stt_usage import SttUsageLog

    return SttUsageLog


async def _insert(table: Table, row: dict[str, Any]) -> bool:
    """One transaction: the row (once per idem_key), the run's actual_tokens,
    and the CHARGE for it — the user is billed as the run spends, not from an
    estimate held at start (packages/billing/runs.py, owner 2026-09-26). The
    money and the evidence for it land together or not at all.

    Returns True when the row was new. Raises on a DB problem.
    """
    from packages.billing import runs
    from packages.db.session import get_sessionmaker

    async with get_sessionmaker()() as session:
        await session.execute(text("SET search_path TO core, public"))
        await _price(session, table, row)
        # Account first, then the run — the one lock order (accounts.py) —
        # and BEFORE the insert, whose foreign key locks the run row too.
        locked = None
        if row.get("run_id") and row.get("tokens"):
            locked = await runs.lock_run(session, str(row["run_id"]))
        model = _model_for(table)
        stmt = (
            pg_insert(model)
            .values(**row)
            .on_conflict_do_nothing(index_elements=["idem_key"])
            .returning(model.id)
        )
        inserted = (await session.execute(stmt)).first() is not None
        if inserted and locked is not None:
            await runs.apply_spend(session, *locked, int(row["tokens"]))
        await session.commit()
        return inserted


async def _insert_tolerant(table: Table, row: dict[str, Any]) -> bool:
    try:
        return await _insert(table, row)
    except IntegrityError as exc:
        # A run_id whose ai_runs row is gone (or never committed) must not
        # lose the usage: keep the row, drop the link.
        if row.get("run_id") and "ai_runs" in str(exc):
            log.warning("usage_run_missing", run_id=row["run_id"], table=table)
            return await _insert(table, {**row, "run_id": None})
        raise


def _to_json(table: Table, row: dict[str, Any]) -> str:
    def enc(value: Any) -> Any:
        if isinstance(value, datetime):
            return {"__dt__": value.isoformat()}
        if isinstance(value, Decimal):
            return {"__dec__": str(value)}
        return value

    return json.dumps({"table": table, "row": {k: enc(v) for k, v in row.items()}})


def _from_json(raw: str | bytes) -> tuple[Table, dict[str, Any]]:
    data = json.loads(raw)

    def dec(value: Any) -> Any:
        if isinstance(value, dict) and "__dt__" in value:
            return datetime.fromisoformat(value["__dt__"])
        if isinstance(value, dict) and "__dec__" in value:
            return Decimal(value["__dec__"])
        return value

    return data["table"], {k: dec(v) for k, v in data["row"].items()}


async def _outbox_client() -> Any:
    import redis.asyncio as aioredis

    from packages.core.settings import get_settings

    return aioredis.from_url(get_settings().redis_url, socket_timeout=2, socket_connect_timeout=2)


async def _push_outbox(table: Table, row: dict[str, Any]) -> bool:
    client = None
    try:
        client = await _outbox_client()
        await client.rpush(OUTBOX_KEY, _to_json(table, row))
        return True
    except Exception as exc:  # noqa: BLE001
        log.warning("usage_outbox_unavailable", error=str(exc)[:200])
        return False
    finally:
        if client is not None:
            try:
                await client.aclose()
            except Exception as exc:  # noqa: BLE001 — closing must not mask the push result
                log.debug("usage_outbox_close_failed", error=str(exc)[:200])


async def write_durably(table: Table, row: dict[str, Any]) -> None:
    """Insert with retries → outbox → loud log. Never raises."""
    last: BaseException | None = None
    for attempt, delay in enumerate((0.0, *RETRY_DELAYS)):
        if delay:
            await asyncio.sleep(delay)
        try:
            await _insert_tolerant(table, row)
            return
        except Exception as exc:  # noqa: BLE001
            last = exc
            log.warning("usage_record_retry", table=table, attempt=attempt + 1, error=str(exc)[:200])
    if await _push_outbox(table, row):
        log.warning("usage_record_outboxed", table=table, idem_key=row.get("idem_key"))
        return
    log.error(
        "usage_record_lost",
        table=table,
        error=str(last)[:200] if last else None,
        payload=_to_json(table, row),
    )


# ── public API ───────────────────────────────────────────────────────────────

async def record_llm_attempt(
    ctx: UsageCtx | None,
    *,
    model: str,
    status: LlmStatus,
    input_tokens: int = 0,
    cached_tokens: int = 0,
    output_tokens: int = 0,
) -> int:
    """Record one model request. Returns the rate-card tokens it was charged
    (0 when there is no usage context — scripts and probes are unattributed)."""
    if ctx is None:
        return 0
    try:
        row = llm_row(
            ctx, model=model, status=status, input_tokens=input_tokens,
            cached_tokens=cached_tokens, output_tokens=output_tokens,
        )
    except Exception as exc:  # noqa: BLE001
        log.error("usage_row_build_failed", table="llm", error=str(exc)[:200])
        return 0
    await write_durably("llm", row)
    return int(row["tokens"])


async def record_stt_clip(
    ctx: UsageCtx | None,
    *,
    clip_index: int | None,
    billed_sec: float,
    model: str,
    keyterms: bool,
) -> int:
    """Record one transcribed file as soon as the vendor billed it."""
    if ctx is None or float(billed_sec or 0.0) <= 0:
        return 0
    try:
        row = stt_row(ctx, clip_index=clip_index, billed_sec=billed_sec, model=model, keyterms=keyterms)
    except Exception as exc:  # noqa: BLE001
        log.error("usage_row_build_failed", table="stt", error=str(exc)[:200])
        return 0
    await write_durably("stt", row)
    return int(row["tokens"])


async def drain_outbox(redis: Any, *, limit: int = DRAIN_BATCH) -> dict[str, int]:
    """Replay up to ``limit`` outboxed rows. A row that still cannot be written
    goes back on the list and the drain stops (the DB is likely down)."""
    written = duplicates = 0
    for _ in range(limit):
        raw = await redis.lpop(OUTBOX_KEY)
        if raw is None:
            break
        try:
            table, row = _from_json(raw)
        except Exception as exc:  # noqa: BLE001 — unparseable: log it whole, drop it
            log.error("usage_outbox_corrupt", error=str(exc)[:200], raw=str(raw)[:2000])
            continue
        try:
            if await _insert_tolerant(table, row):
                written += 1
            else:
                duplicates += 1
        except Exception as exc:  # noqa: BLE001
            await redis.rpush(OUTBOX_KEY, raw)
            log.warning("usage_outbox_drain_stalled", error=str(exc)[:200])
            break
    if written or duplicates:
        log.info("usage_outbox_drained", written=written, duplicates=duplicates)
    return {"written": written, "duplicates": duplicates}
