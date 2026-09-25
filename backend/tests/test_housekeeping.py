"""The daily housekeeping cron (services/worker/tasks.py:sweep_housekeeping).

Here: the projects it frees. A tab that dies mid-job leaves its project in
``processing``, which routers/videos_local.py refuses to start — so without a
sweeper that project is unstartable forever. Real local Postgres: the sweep is
one join across the shared tenant schema and ``core.jobs``.
"""

import uuid
from datetime import UTC, datetime, timedelta

from packages.db.tenancy import SHARED_DATA_SCHEMA
from services.worker import tasks
from tests.admin_helpers import _admin_env, db, email, make_user  # noqa: F401  (fixture)

NOW = datetime(2026, 9, 26, 12, 0, tzinfo=UTC)
OLD = NOW - timedelta(hours=3)


async def _project(user_id: int, *, status: str, job_id: str | None, updated_at: datetime) -> str:
    uid = str(uuid.uuid4())
    await db(
        f"INSERT INTO {SHARED_DATA_SCHEMA}.video_projects "
        "(uid, user_id, tenant_slug, mode, status, job_id, created_at, updated_at) "
        "VALUES (:p, :u, 'default', 'dub_first', :s, :j, :t, :t)",
        p=uid, u=user_id, s=status, j=job_id, t=updated_at,
    )
    return uid


async def _job(tenant_id: int, *, status: str, updated_at: datetime) -> str:
    job_id = f"test_{uuid.uuid4().hex[:12]}"
    await db(
        "INSERT INTO core.jobs (id, tenant_id, type, status, progress, created_at, updated_at) "
        "VALUES (:j, :t, 'video_edit', :s, 0, :u, :u)",
        j=job_id, t=tenant_id, s=status, u=updated_at,
    )
    return job_id


async def _status(uid: str) -> tuple:
    row = await db(f"SELECT status, error_msg FROM {SHARED_DATA_SCHEMA}.video_projects WHERE uid = :p", p=uid)
    return tuple(row[0])


async def test_a_project_stuck_in_processing_is_freed_and_a_live_one_is_left_alone():
    user_id = await make_user(email("sweep"))
    tenant_id = int((await db("SELECT tenant_id FROM core.memberships WHERE user_id = :u", u=user_id))[0][0])
    made: list[str] = []
    try:
        # Freed: old, and nothing is happening on the job side.
        no_job = await _project(user_id, status="processing", job_id=None, updated_at=OLD)
        finished = await _project(
            user_id, status="processing",
            job_id=await _job(tenant_id, status="error", updated_at=OLD), updated_at=OLD,
        )
        silent = await _project(
            user_id, status="processing",
            job_id=await _job(tenant_id, status="running", updated_at=OLD), updated_at=OLD,
        )
        # Left alone: a long job that is still moving, and a young project.
        working = await _project(
            user_id, status="processing",
            job_id=await _job(tenant_id, status="running", updated_at=NOW), updated_at=OLD,
        )
        recent = await _project(user_id, status="processing", job_id=None, updated_at=NOW)
        paused = await _project(user_id, status="paused_quota", job_id=None, updated_at=OLD)
        made = [no_job, finished, silent, working, recent, paused]

        # The sweep is global (it is a cron): a developer database may hold
        # its own stuck projects, which it rightly frees too.
        freed = await tasks._sweep_stuck_projects(NOW)

        assert freed >= 3
        for uid in (no_job, finished, silent):
            assert await _status(uid) == ("error", tasks.STUCK_PROCESSING_MESSAGE)
        for uid in (working, recent):
            assert (await _status(uid))[0] == "processing"
        # A paused run is waiting for quota, not stuck: the sweep leaves it.
        assert (await _status(paused))[0] == "paused_quota"
    finally:
        if made:
            await db(
                f"DELETE FROM {SHARED_DATA_SCHEMA}.video_projects WHERE uid = ANY(:ids)", ids=made
            )
        await db("DELETE FROM core.jobs WHERE id LIKE 'test\\_%'")
