"""Durable usage recording (packages/billing/metering.py), against local Postgres.

Every vendor request becomes a row carrying BOTH the rate-card tokens the
user is charged and the real vendor cost; a row that cannot be written is
retried, then outboxed, then replayed exactly once.
"""

import types
import uuid
from decimal import Decimal

import pytest

from packages.billing import metering, rate_card
from packages.llm.usage import UsageCtx, extract_cached_tokens, extract_stream_cached_from_chunks
from tests.admin_helpers import _admin_env, db, email, make_user  # noqa: F401  (fixtures)


async def _ctx(**kw) -> UsageCtx:
    user_id = await make_user(email("meter"))
    tenant = await db("SELECT tenant_id FROM core.memberships WHERE user_id = :u", u=user_id)
    return UsageCtx(
        user_id=user_id, tenant_id=int(tenant[0][0]), feature="video_cut",
        reference_id=kw.pop("reference_id", str(uuid.uuid4())), **kw,
    )


async def _run(ctx: UsageCtx) -> str:
    run_id = uuid.uuid4().hex
    await db(
        "INSERT INTO core.ai_runs (id, user_id, tenant_id, kind) VALUES (:i, :u, :t, 'analyze_video')",
        i=run_id, u=ctx.user_id, t=ctx.tenant_id,
    )
    return run_id


async def test_an_ok_call_records_tokens_cost_and_run_accrual():
    ctx = await _ctx(job_id="vlocal_abcd1234")
    ctx.run_id = await _run(ctx)
    charged = await metering.record_llm_attempt(
        ctx, model="gemini/gemini-3.7-flash", status="ok",
        input_tokens=10_000, cached_tokens=2_000, output_tokens=1_000,
    )
    rows = await db(
        "SELECT status, input_tokens, cached_tokens, output_tokens, tokens, rate_version, cost_thb, "
        "fx_rate, run_id, job_id, idem_key FROM core.llm_usage_logs WHERE user_id = :u",
        u=ctx.user_id,
    )
    assert len(rows) == 1
    status, inp, cached, out, tokens, version, cost, fx_rate, run_id, job_id, idem = rows[0]
    assert (status, inp, cached, out) == ("ok", 10_000, 2_000, 1_000)
    assert tokens == charged == rate_card.tokens_for_llm("gemini-3.7-flash", 10_000, 2_000, 1_000)
    assert version == "v1" and run_id == ctx.run_id and job_id == "vlocal_abcd1234" and idem
    assert cost is not None and cost > 0 and fx_rate is not None and fx_rate > 0
    actual = await db("SELECT actual_tokens FROM core.ai_runs WHERE id = :r", r=ctx.run_id)
    assert actual[0][0] == tokens


async def test_a_failed_attempt_without_usage_is_recorded_unpriced():
    ctx = await _ctx()
    assert await metering.record_llm_attempt(ctx, model="gemini-3.8-flash", status="failed") == 0
    rows = await db(
        "SELECT status, tokens, cost_thb FROM core.llm_usage_logs WHERE user_id = :u", u=ctx.user_id
    )
    assert rows == [("failed", 0, None)]


async def test_no_context_writes_nothing():
    before = await db("SELECT count(*) FROM core.llm_usage_logs")
    assert await metering.record_llm_attempt(None, model="x", status="ok", input_tokens=5) == 0
    assert await metering.record_stt_clip(None, clip_index=0, billed_sec=3, model="scribe_v2", keyterms=False) == 0
    assert await db("SELECT count(*) FROM core.llm_usage_logs") == before


async def test_stt_is_one_row_per_clip_with_the_keyterms_flag():
    ctx = await _ctx()
    await metering.record_stt_clip(ctx, clip_index=0, billed_sec=60, model="scribe_v2", keyterms=True)
    await metering.record_stt_clip(ctx, clip_index=1, billed_sec=60, model="scribe_v2", keyterms=False)
    await metering.record_stt_clip(ctx, clip_index=2, billed_sec=0, model="scribe_v2", keyterms=True)
    rows = await db(
        "SELECT clip_index, audio_sec, keyterms, tokens, cost_thb, rate_version FROM core.stt_usage_logs "
        "WHERE user_id = :u ORDER BY clip_index",
        u=ctx.user_id,
    )
    assert [(r[0], r[1], r[2], r[3], r[5]) for r in rows] == [
        (0, 60.0, True, 3105, "v1"),  # 60 × 51.75 — the same with or without keyterms
        (1, 60.0, False, 3105, "v1"),
    ]
    # Keyterms change the real cost only: $0.27/h vs $0.22/h.
    assert float(rows[0][4] / rows[1][4]) == pytest.approx(0.27 / 0.22, rel=1e-3)


async def test_a_missing_run_keeps_the_usage_and_drops_the_link():
    ctx = await _ctx(run_id=uuid.uuid4().hex)
    await metering.record_llm_attempt(ctx, model="gemini-3.7-flash", status="ok", input_tokens=100)
    rows = await db("SELECT run_id, tokens FROM core.llm_usage_logs WHERE user_id = :u", u=ctx.user_id)
    assert rows == [(None, rate_card.tokens_for_llm("gemini-3.7-flash", 100, 0, 0))]


class FakeRedis:
    def __init__(self, items: list[str]) -> None:
        self.items = list(items)

    async def lpop(self, key: str):
        return self.items.pop(0) if self.items else None

    async def rpush(self, key: str, value) -> None:
        self.items.append(value)


async def test_db_down_retries_then_outboxes_then_replays_exactly_once(monkeypatch):
    ctx = await _ctx()
    real_insert = metering._insert
    attempts = 0

    async def broken(table, row):
        nonlocal attempts
        attempts += 1
        raise OSError("connection refused")

    monkeypatch.setattr(metering, "_insert", broken)
    await metering.record_llm_attempt(ctx, model="gemini-3.7-flash", status="ok", input_tokens=500, output_tokens=50)
    assert attempts == 1 + len(metering.RETRY_DELAYS)
    assert len(metering.TEST_OUTBOX) == 1
    assert await db("SELECT count(*) FROM core.llm_usage_logs WHERE user_id = :u", u=ctx.user_id) == [(0,)]

    # The DB is back: the drain writes it; a replay of the same payload is a no-op.
    monkeypatch.setattr(metering, "_insert", real_insert)
    payload = metering.TEST_OUTBOX[0]
    redis = FakeRedis([payload, payload])
    result = await metering.drain_outbox(redis)
    assert result == {"written": 1, "duplicates": 1} and redis.items == []
    rows = await db("SELECT tokens, status FROM core.llm_usage_logs WHERE user_id = :u", u=ctx.user_id)
    assert rows == [(rate_card.tokens_for_llm("gemini-3.7-flash", 500, 0, 50), "ok")]


async def test_a_stalled_drain_puts_the_row_back(monkeypatch):
    async def broken(table, row):
        raise OSError("still down")

    ctx = await _ctx()
    row = metering.llm_row(ctx, model="m", status="ok", input_tokens=1, cached_tokens=0, output_tokens=1)
    payload = metering._to_json("llm", row)
    monkeypatch.setattr(metering, "_insert", broken)
    redis = FakeRedis([payload])
    assert await metering.drain_outbox(redis) == {"written": 0, "duplicates": 0}
    assert redis.items == [payload]


def test_outbox_payload_round_trips_dates_and_decimals():
    from datetime import UTC, datetime

    row = {"created_at": datetime(2026, 9, 22, 1, 2, 3, tzinfo=UTC), "cost_thb": Decimal("1.2345"), "n": 3}
    table, back = metering._from_json(metering._to_json("stt", row))
    assert table == "stt" and back == row


def test_cached_tokens_are_read_from_either_usage_shape():
    openai_shape = types.SimpleNamespace(prompt_tokens_details=types.SimpleNamespace(cached_tokens=640))
    dict_shape = {"prompt_tokens_details": {"cached_tokens": 12}}
    anthropic_shape = types.SimpleNamespace(prompt_tokens_details=None, cache_read_input_tokens=99)
    assert extract_cached_tokens(openai_shape) == 640
    assert extract_cached_tokens(dict_shape) == 12
    assert extract_cached_tokens(anthropic_shape) == 99
    assert extract_cached_tokens(None) == 0
    chunks = [types.SimpleNamespace(usage=openai_shape), types.SimpleNamespace(usage=None)]
    assert extract_stream_cached_from_chunks(chunks) == 640


def test_the_worker_drains_the_outbox_every_minute_and_fetches_fx_daily():
    from services.worker import tasks

    names = {c.name.split(":")[-1]: c for c in tasks.WorkerSettings.cron_jobs}
    assert "drain_usage_outbox" in names and "refresh_fx_rate" in names
    assert names["drain_usage_outbox"].minute == set(range(60))
    assert (names["refresh_fx_rate"].hour, names["refresh_fx_rate"].minute) == (0, 10)


async def test_the_drain_cron_uses_the_worker_redis(monkeypatch):
    from services.worker import tasks

    seen = {}

    async def fake_drain(redis):
        seen["redis"] = redis
        return {"written": 0, "duplicates": 0}

    monkeypatch.setattr(metering, "drain_outbox", fake_drain)
    marker = object()
    assert await tasks.drain_usage_outbox({"redis": marker}) == {"written": 0, "duplicates": 0}
    assert seen["redis"] is marker
