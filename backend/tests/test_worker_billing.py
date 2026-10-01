"""The worker side of a paid run (services/worker/tasks.py ``billed_task``):
slot → meter → settle, for every way a task can end."""

import math
import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import text

from packages.billing import guard, runs
from packages.billing.estimate import Estimate
from packages.db.models.core_auth import User
from packages.db.session import get_sessionmaker
from services.worker import tasks
from tests.admin_helpers import _admin_env, db, email, make_user  # noqa: F401


async def _paid_run(plan: str = "lite", tokens: int = 10_000) -> tuple[int, str, str]:
    """A user, an open paid run and its job row: (user_id, run_id, job_id)."""
    uid = await make_user(email("worker"), plan=plan)
    tid = (await db("SELECT tenant_id FROM core.memberships WHERE user_id = :u", u=uid))[0][0]
    job_id = f"test_{uuid.uuid4().hex[:12]}"
    await db("INSERT INTO core.jobs (id, tenant_id, type, status, progress) VALUES (:j, :t, 'video_edit', 'queued', 0)",
             j=job_id, t=tid)
    async with get_sessionmaker()() as s:
        await s.execute(text("SET search_path TO core, public"))
        user = await s.get(User, uid)
        est = Estimate(tokens=tokens, ceiling=math.ceil(tokens * 1.2), media_sec=10, kind="analyze_video",
                       model="gemini-3.7-flash")
        run = await runs.open_run(s, user=user, tenant_id=int(tid), estimate=est, job_id=job_id)
        await s.commit()
        return uid, str(run.id), job_id


async def _burn(run_id: str, tokens: int) -> None:
    """One recorded vendor request, charged the way metering charges it."""
    async with get_sessionmaker()() as s:
        await s.execute(text("SET search_path TO core, public"))
        await runs.charge_as_spent(s, run_id, tokens)
        await s.commit()


async def _run_row(run_id: str) -> dict:
    row = await db("SELECT status, outcome, charged_tokens FROM core.ai_runs WHERE id = :r", r=run_id)
    return {"status": row[0][0], "outcome": row[0][1], "charged": row[0][2]}


async def _job(job_id: str) -> tuple:
    row = await db("SELECT status, result FROM core.jobs WHERE id = :j", j=job_id)
    return row[0][0], row[0][1]


@pytest.fixture(autouse=True)
async def _drop_jobs():
    yield
    await db("DELETE FROM core.jobs WHERE id LIKE 'test\\_%'")


async def test_a_finished_task_settles_what_it_used():
    seen = {}

    @tasks.billed_task()
    async def work(ctx, *, job_id):
        meter = guard.current_meter()
        seen["ceiling"] = meter.ceiling
        seen["chain"] = tasks._chain_kwargs()
        await _burn(meter.run_id, 4000)
        return {"ok": True}

    uid, run_id, job_id = await _paid_run()
    out = await work({}, job_id=job_id, run_id=run_id)
    assert out == {"ok": True}
    assert seen == {"ceiling": 12_000, "chain": {"run_id": run_id}}
    assert await _run_row(run_id) == {"status": "settled", "outcome": "ok", "charged": 4000}
    assert guard.current_meter() is None and tasks._chain_kwargs() == {}
    used = await db("SELECT weekly_used, reserved_tokens FROM core.usage_accounts WHERE user_id = :u", u=uid)
    assert tuple(used[0]) == (4000, 0)


def _stt_rejected():
    from packages.video.elevenlabs_stt import ElevenLabsInputRejected

    return ElevenLabsInputRejected("Scribe returned 400: invalid audio")


@pytest.mark.parametrize(
    ("raised", "outcome", "status"),
    [
        (RuntimeError("vendor 500"), "our_failure", "refunded"),
        (tasks.UserInputError("no uploads"), "user_error", "settled"),
        # The provider refused the footage / the transcription service refused
        # the file: input the user controls, already billed — not refunded.
        (_stt_rejected(), "user_error", "settled"),
    ],
)
async def test_a_failing_task_settles_by_whose_fault_it_was(raised, outcome, status):
    @tasks.billed_task()
    async def work(ctx, *, job_id):
        await _burn(guard.current_meter().run_id, 3000)
        raise raised

    _, run_id, job_id = await _paid_run()
    with pytest.raises(type(raised)):
        await work({}, job_id=job_id, run_id=run_id)
    row = await _run_row(run_id)
    assert (row["status"], row["outcome"]) == (status, outcome)
    assert row["charged"] == (0 if outcome == "our_failure" else 3000)


async def test_a_guard_stop_ends_the_job_and_keeps_what_it_used():
    @tasks.billed_task()
    async def work(ctx, *, job_id):
        await _burn(guard.current_meter().run_id, 11500)
        raise guard.RunBudgetExceeded("x")

    _, run_id, job_id = await _paid_run(tokens=10_000)
    out = await work({}, job_id=job_id, run_id=run_id)
    assert out == {"stopped": True, "code": "limit_stop"}
    assert await _run_row(run_id) == {"status": "stopped", "outcome": "limit_stop", "charged": 11_500}
    status, result = await _job(job_id)
    assert status == "error" and result["step"] == "stopped" and result["code"] == "limit_stop"


async def test_running_out_of_quota_pauses_the_project_instead_of_failing_it():
    """A stop for QUOTA is not a crash: the project goes to ``paused_quota``
    (resumable from the stage it reached, not restarted from scratch) and the
    job row carries everything the editor needs to offer the balance."""
    from packages.db.tenancy import SHARED_DATA_SCHEMA

    resets = datetime(2026, 9, 30, 8, 0, tzinfo=UTC)

    @tasks.billed_task()
    async def work(ctx, *, job_id, project_uid, tenant_slug):
        await _burn(guard.current_meter().run_id, 6000)
        # What the task's own handler writes on its way out.
        await db(
            f"UPDATE {SHARED_DATA_SCHEMA}.video_projects SET status = 'error', error_msg = 'x' WHERE uid = :p",
            p=project_uid,
        )
        raise guard.QuotaExhausted(
            "x", window="weekly", resets_at=resets, wallet_can_cover=True, wallet_satang=4_200,
        )

    uid, run_id, job_id = await _paid_run(tokens=10_000)
    project = str(uuid.uuid4())
    await db(
        f"INSERT INTO {SHARED_DATA_SCHEMA}.video_projects (uid, user_id, tenant_slug, mode, status, job_id) "
        "VALUES (:p, :u, 'default', 'dub_first', 'processing', :j)",
        p=project, u=uid, j=job_id,
    )
    try:
        out = await work({}, job_id=job_id, run_id=run_id, project_uid=project, tenant_slug="default")
        _, result = await _job(job_id)
        proj = await db(
            f"SELECT status, error_msg FROM {SHARED_DATA_SCHEMA}.video_projects WHERE uid = :p", p=project
        )
    finally:
        await db(f"DELETE FROM {SHARED_DATA_SCHEMA}.video_projects WHERE uid = :p", p=project)
    assert out == {"stopped": True, "paused": True, "code": "limit_reached"}
    assert result["step"] == "stopped" and result["paused"] is True
    assert result["code"] == "limit_reached" and result["window"] == "weekly"
    assert result["resets_at"] == runs.iso(resets)
    assert result["wallet_can_cover"] is True and result["wallet_satang"] == 4_200
    assert proj[0][0] == "paused_quota" and proj[0][1] == result["message"]
    # Still a limit_stop for the money: charged what it burned.
    assert (await _run_row(run_id))["outcome"] == "limit_stop"


async def _project_row(uid: int, job_id: str) -> str:
    from packages.db.tenancy import SHARED_DATA_SCHEMA

    project = str(uuid.uuid4())
    await db(
        f"INSERT INTO {SHARED_DATA_SCHEMA}.video_projects (uid, user_id, tenant_slug, mode, status, job_id, "
        "resume_state) VALUES (:p, :u, 'default', 'dub_first', 'processing', :j, "
        "CAST(:s AS JSONB))",
        p=project, u=uid, j=job_id,
        s='{"v": 1, "stage": "analyze", "kind": "analyze_video", "task": "analyze_dub_video_local", '
          '"kwargs": {}, "media_sec": 10}',
    )
    return project


async def _project_state(project: str) -> tuple:
    from packages.db.tenancy import SHARED_DATA_SCHEMA

    rows = await db(
        f"SELECT status, error_msg, resume_state FROM {SHARED_DATA_SCHEMA}.video_projects WHERE uid = :p",
        p=project,
    )
    return tuple(rows[0])


async def test_the_call_in_flight_finishes_and_the_next_one_pauses_the_trial():
    """Owner, 2026-10-01, end to end through the REAL meter: a Free account
    with 10k of its credit left. The call that crosses 100 % is sent and
    charged in full (the credit ends past 100 %, the excess recorded as
    overage); the NEXT call is not sent — the project pauses, resumable, with
    the trial-credit wording (no reset to wait for: upgrade)."""
    from packages.billing import limits
    from packages.db.tenancy import SHARED_DATA_SCHEMA

    sent: list[int] = []

    @tasks.billed_task()
    async def work(ctx, *, job_id, project_uid, tenant_slug):
        meter = guard.current_meter()
        for _ in range(2):
            guard.admit(meter, 50_000)  # priced far above the 10k left: sent anyway
            sent.append(1)
            await _burn(meter.run_id, 40_000)
            guard.settle_call(meter, 50_000, 40_000)
        return {"ok": True}

    uid, run_id, job_id = await _paid_run(plan="free", tokens=60_000)
    credit = limits.window_limit("free", "lifetime")
    await db(
        "INSERT INTO core.usage_accounts (user_id, lifetime_started_at, lifetime_used, reserved_tokens) "
        "VALUES (:u, now(), :m, 0) ON CONFLICT (user_id) DO UPDATE SET lifetime_used = :m, lifetime_started_at = now()",
        u=uid, m=credit - 10_000,
    )
    project = await _project_row(uid, job_id)
    try:
        out = await work({}, job_id=job_id, run_id=run_id, project_uid=project, tenant_slug="default")
        _, result = await _job(job_id)
        status, message, state = await _project_state(project)
    finally:
        await db(f"DELETE FROM {SHARED_DATA_SCHEMA}.video_projects WHERE uid = :p", p=project)
    assert sent == [1]  # one call went out; the second was never sent
    assert out == {"stopped": True, "paused": True, "code": "limit_reached"}
    assert result["window"] == "lifetime" and result["resets"] is False
    assert status == "paused_quota" and message == result["message"] and "อัปเกรด" in message
    assert state["paused"] is True and state["task"] == "analyze_dub_video_local"
    assert await _run_row(run_id) == {"status": "stopped", "outcome": "limit_stop", "charged": 40_000}
    acct = await db(
        "SELECT lifetime_used, overage_tokens, overage_window FROM core.usage_accounts WHERE user_id = :u",
        u=uid,
    )
    assert tuple(acct[0]) == (credit + 30_000, 30_000, "lifetime")


async def test_a_safety_cap_hit_is_a_retryable_failure_that_is_billed():
    """A required answer cut off at the per-call SAFETY cap: the task's own
    handler leaves a plain error (retryable), and the run keeps what it used
    — no refund (owner, 2026-10-01)."""

    @tasks.billed_task()
    async def work(ctx, *, job_id):
        await _burn(guard.current_meter().run_id, 61_000)
        raise guard.OutputTruncated(guard.current_meter().run_id)

    _, run_id, job_id = await _paid_run()
    with pytest.raises(guard.OutputTruncated):
        await work({}, job_id=job_id, run_id=run_id)
    assert await _run_row(run_id) == {"status": "settled", "outcome": "safety_cap", "charged": 61_000}


async def test_a_cancelled_task_pays_for_what_it_used():
    @tasks.billed_task()
    async def work(ctx, *, job_id):
        await _burn(guard.current_meter().run_id, 700)
        return {"cancelled": True}

    _, run_id, job_id = await _paid_run()
    await work({}, job_id=job_id, run_id=run_id)
    assert await _run_row(run_id) == {"status": "cancelled", "outcome": "user_cancel", "charged": 700}


async def test_a_task_that_swallowed_its_error_is_still_refunded():
    @tasks.billed_task()
    async def work(ctx, *, job_id):
        await tasks._update_job(job_id, "error", 0, result={"step": "error", "message": "x"}, error="x")
        return {}

    _, run_id, job_id = await _paid_run()
    await work({}, job_id=job_id, run_id=run_id)
    assert (await _run_row(run_id))["outcome"] == "our_failure"


async def test_over_the_concurrency_cap_the_task_waits_its_turn():
    ran = AsyncMock()

    @tasks.billed_task()
    async def work(ctx, *, job_id):
        await ran()

    uid, first, _ = await _paid_run("lite")
    async with get_sessionmaker()() as s:
        await s.execute(text("SET search_path TO core, public"))
        assert await runs.acquire_slot(s, first) == "run"
        await s.commit()
    tid = (await db("SELECT tenant_id FROM core.memberships WHERE user_id = :u", u=uid))[0][0]
    job_id = f"test_{uuid.uuid4().hex[:12]}"
    await db("INSERT INTO core.jobs (id, tenant_id, type, status, progress) VALUES (:j, :t, 'video_edit', 'queued', 0)",
             j=job_id, t=tid)
    async with get_sessionmaker()() as s:
        await s.execute(text("SET search_path TO core, public"))
        user = await s.get(User, uid)
        second = await runs.open_run(s, user=user, tenant_id=int(tid), estimate=Estimate(
            tokens=1_000, ceiling=1_200, media_sec=1, kind="plan_dub", model="gemini-3.7-flash"))
        await s.commit()
        second_id = str(second.id)
    redis = AsyncMock()
    out = await work({"redis": redis}, job_id=job_id, run_id=second_id)
    assert out == {"waiting_slot": True}
    ran.assert_not_awaited()
    redis.enqueue_job.assert_awaited_once()
    args, kwargs = redis.enqueue_job.await_args
    assert args == ("work",) and kwargs["run_id"] == second_id and kwargs["_defer_by"] == tasks.SLOT_RETRY_SEC
    status, result = await _job(job_id)
    assert status == "queued" and result["step"] == "waiting_slot"
    assert (await _run_row(second_id))["status"] == "queued"


async def test_a_chain_step_hands_its_run_to_the_next():
    @tasks.billed_task(terminal=False)
    async def step(ctx, *, job_id):
        return {"next": tasks._chain_kwargs()}

    _, run_id, job_id = await _paid_run()
    out = await step({}, job_id=job_id, run_id=run_id)
    assert out == {"next": {"run_id": run_id}}
    row = await db("SELECT status, lease_until FROM core.ai_runs WHERE id = :r", r=run_id)
    assert row[0][0] == "running" and row[0][1] > datetime.now(UTC) + timedelta(minutes=20)


async def test_a_closed_run_does_no_paid_work_and_an_unbilled_task_runs_as_before():
    ran = AsyncMock(return_value={"done": 1})

    @tasks.billed_task()
    async def work(ctx, *, job_id):
        return await ran()

    _, run_id, job_id = await _paid_run()
    await db("UPDATE core.ai_runs SET status = 'released' WHERE id = :r", r=run_id)
    assert (await work({}, job_id=job_id, run_id=run_id))["cancelled"] is True
    ran.assert_not_awaited()
    assert await work({}, job_id=job_id) == {"done": 1}  # no run_id: no billing at all


async def test_a_swept_waiting_run_ends_its_job_and_project_in_error():
    """Regression: a run swept while waiting for a slot left its job on
    'รอคิว' forever and its project stuck in processing."""
    from packages.db.tenancy import SHARED_DATA_SCHEMA

    ran = AsyncMock()

    @tasks.billed_task()
    async def work(ctx, *, job_id, project_uid, tenant_slug):
        await ran()

    uid, run_id, job_id = await _paid_run()
    await tasks._update_job(job_id, "queued", 2, result={"step": "waiting_slot", "message": "รอคิว"})
    project = str(uuid.uuid4())
    await db(
        f"INSERT INTO {SHARED_DATA_SCHEMA}.video_projects (uid, user_id, tenant_slug, mode, status, job_id) "
        "VALUES (:p, :u, 'default', 'dub_first', 'processing', :j)",
        p=project, u=uid, j=job_id,
    )
    async with get_sessionmaker()() as s:
        await s.execute(text("SET search_path TO core, public"))
        await runs.settle(s, run_id, "orphaned")  # what the sweeper does to it
        await s.commit()
    try:
        out = await work({}, job_id=job_id, run_id=run_id, project_uid=project, tenant_slug="default")
        status, result = await _job(job_id)
        proj = await db(f"SELECT status, error_msg FROM {SHARED_DATA_SCHEMA}.video_projects WHERE uid = :p", p=project)
    finally:
        await db(f"DELETE FROM {SHARED_DATA_SCHEMA}.video_projects WHERE uid = :p", p=project)
    assert out["cancelled"] is True
    ran.assert_not_awaited()
    assert status == "error" and result["message"] == tasks.WAIT_EXPIRED_MESSAGE
    assert tuple(proj[0]) == ("error", tasks.WAIT_EXPIRED_MESSAGE)


async def test_a_closed_run_leaves_a_job_that_is_not_waiting_alone():
    @tasks.billed_task()
    async def work(ctx, *, job_id):
        return {}

    _, run_id, job_id = await _paid_run()
    await tasks._update_job(job_id, "error", 0, result={"step": "cancelled", "message": "x"})
    await db("UPDATE core.ai_runs SET status = 'cancelled' WHERE id = :r", r=run_id)
    await work({}, job_id=job_id, run_id=run_id)
    assert (await _job(job_id))[1]["step"] == "cancelled"


def test_every_ai_task_is_billed_and_registered_by_name():
    names = {getattr(f, "__name__", "") for f in tasks.WorkerSettings.functions}
    for name in ("ingest_video", "plan_edit", "analyze_dub_first", "plan_dub_timeline", "analyze_dub_local",
                 "analyze_dub_video_local", "plan_effects_local", "distill_style_local", "reedit_dub_scenes_local",
                 "plan_talking_local", "plan_speech_local"):
        fn = getattr(tasks, name)
        assert name in names and hasattr(fn, "__wrapped__"), name
    crons = {c.name.split(":")[-1] for c in tasks.WorkerSettings.cron_jobs}
    assert {"sweep_runs", "apply_plan_changes", "expire_wallet_lots"} <= crons


def test_every_transcription_passes_the_guard_and_the_vendor_slot():
    import inspect

    hooks = tasks._stt_hooks()
    assert hooks["before_clip"] is guard.before_stt_clip and "clip_slot" in hooks
    source = inspect.getsource(tasks)
    assert source.count("**_stt_hooks()") == 3 and "on_clip_billed=_record_stt_clip" not in source
