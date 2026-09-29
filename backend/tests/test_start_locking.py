"""Starting AI work exactly once.

Every start route read ``status``, opened a paid run, and wrote
``processing`` — with nothing between the read and the write, so two copies
of the same request (a double click, a retry after a dropped response) both
started and both charged. Three things close that:

* the project row is locked for the request (``_get_local_project(...,
  for_update=True)``), so a simultaneous second start waits and then sees
  ``processing``;
* an ``Idempotency-Key`` header makes a RETRIED start answer with the 202 the
  first one got, instead of starting again once the first has finished;
* a start whose enqueue fails is put back to ``error`` instead of being left
  on ``processing`` for a job no worker will ever run.
"""

from __future__ import annotations

import asyncio
import json
import shutil

import pytest

from packages.core.settings import get_settings
from packages.db.tenancy import SHARED_DATA_SCHEMA
from packages.video.storage import data_root
from services.api.routers import videos_local
from tests.admin_helpers import (  # noqa: F401  (fixtures)
    _admin_env,
    bearer,
    client,
    db,
    email,
    make_user,
    user_token,
)
from tests.media_helpers import video_bytes, wav_bytes


@pytest.fixture
def captured(monkeypatch):
    monkeypatch.setenv("REQUIRE_VERIFIED_EMAIL_FOR_AI", "false")
    get_settings.cache_clear()
    calls: list[dict] = []

    async def fake_enqueue(job_id, fn, **kwargs):
        calls.append({"job_id": job_id, "fn": fn, **kwargs})

    monkeypatch.setattr(videos_local, "_enqueue", fake_enqueue)
    yield calls


async def _project(c, token: str, mode: str = "dub_first") -> str:
    r = await c.post(
        "/videos/local",
        json={"mode": mode, "clips": [{"id": "c1", "durationSec": 30}], "engine": "lite"},
        headers=bearer(token),
    )
    assert r.status_code == 201, r.text
    return r.json()["uid"]


async def _analyze(c, token: str, uid: str, *, seconds: float = 10, key: str | None = None):
    manifest = json.dumps([{"clip_id": "c1", "file": "p.mp4", "durationSec": seconds}])
    headers = bearer(token)
    if key:
        headers[videos_local.IDEMPOTENCY_HEADER] = key
    return await c.post(
        f"/videos/{uid}/analyze-video",
        data={"manifest": manifest},
        files=[("files", ("p.mp4", video_bytes(seconds), "video/mp4"))],
        headers=headers,
    )


async def _transcribe(c, token: str, uid: str, *, key: str | None = None):
    headers = bearer(token)
    if key:
        headers[videos_local.IDEMPOTENCY_HEADER] = key
    return await c.post(
        f"/videos/{uid}/transcribe-audio",
        files=[("files", ("audio_000.wav", wav_bytes(3), "audio/wav"))],
        headers=headers,
    )


def _cleanup(uid: str) -> None:
    shutil.rmtree(data_root() / "video_outputs" / uid, ignore_errors=True)


async def _row(uid: str) -> dict:
    rows = await db(
        f"SELECT status, error_msg, job_id, local_meta FROM {SHARED_DATA_SCHEMA}.video_projects WHERE uid = :p",
        p=uid,
    )
    status, error_msg, job_id, meta = rows[0]
    return {"status": status, "error_msg": error_msg, "job_id": job_id, "local_meta": meta}


async def _runs(user_id: int) -> list[tuple]:
    return [tuple(r) for r in await db(
        "SELECT kind, status FROM core.ai_runs WHERE user_id = :u ORDER BY created_at", u=user_id,
    )]


async def _finish(uid: str) -> None:
    """What the worker leaves behind when the analyze completes."""
    await db(
        f"UPDATE {SHARED_DATA_SCHEMA}.video_projects SET status = 'waiting_vo' WHERE uid = :p", p=uid,
    )


# ── the lock ─────────────────────────────────────────────────────────────────

async def test_two_simultaneous_starts_open_one_run_and_one_job(captured):
    """The row is locked for the whole request: the second start waits for
    the first one's commit, reads ``processing``, and is refused — instead of
    both reading ``pending`` and both charging."""
    user = await make_user(email("lock"), plan="pro")
    token = await user_token(user)
    async with client() as c:
        uid = await _project(c, token)
        try:
            a, b = await asyncio.gather(_analyze(c, token, uid), _analyze(c, token, uid))
        finally:
            _cleanup(uid)
    assert sorted((a.status_code, b.status_code)) == [202, 400], (a.text, b.text)
    refused = a if a.status_code == 400 else b
    assert "ยังทำงานอยู่" in refused.json()["detail"]
    assert len(captured) == 1
    assert [k for k, _s in await _runs(user)] == ["analyze_video"]


async def test_two_simultaneous_speech_starts_open_one_run(captured):
    """Same guarantee on the other start route family."""
    user = await make_user(email("lock"), plan="pro")
    token = await user_token(user)
    async with client() as c:
        uid = await _project(c, token, mode="talking_head")
        try:
            a, b = await asyncio.gather(_transcribe(c, token, uid), _transcribe(c, token, uid))
        finally:
            _cleanup(uid)
    assert sorted((a.status_code, b.status_code)) == [202, 400], (a.text, b.text)
    assert len(captured) == 1
    assert [k for k, _s in await _runs(user)] == ["transcribe_only"]


# ── the idempotency key ──────────────────────────────────────────────────────

async def test_a_retried_start_with_the_same_key_replays_the_202(captured):
    """The first run finished; the retry (same key) must not start a second,
    billed one. It gets the same job_id back."""
    user = await make_user(email("idem"), plan="pro")
    token = await user_token(user)
    async with client() as c:
        uid = await _project(c, token)
        try:
            first = await _analyze(c, token, uid, key="req-1")
            assert first.status_code == 202, first.text
            await _finish(uid)
            again = await _analyze(c, token, uid, key="req-1")
            row = await _row(uid)
        finally:
            _cleanup(uid)
    assert again.status_code == 202 and again.json() == first.json()
    assert len(captured) == 1
    assert len(await _runs(user)) == 1
    # The key is on the row, with the job it was accepted for.
    assert row["local_meta"]["idempotency"]["key"] == "req-1"
    assert row["local_meta"]["idempotency"]["job_id"] == first.json()["job_id"]
    assert row["status"] == "waiting_vo"  # the replay did not touch the project


async def test_a_retry_while_the_first_is_still_running_also_replays(captured):
    """Without a key this is the 400 the lock produces; with the key the
    client meant "the same request", and gets the same answer."""
    user = await make_user(email("idem"), plan="pro")
    token = await user_token(user)
    async with client() as c:
        uid = await _project(c, token)
        try:
            first = await _analyze(c, token, uid, key="req-2")
            again = await _analyze(c, token, uid, key="req-2")
            other = await _analyze(c, token, uid, key="req-3")
        finally:
            _cleanup(uid)
    assert first.status_code == 202 and again.status_code == 202
    assert again.json() == first.json()
    assert other.status_code == 400  # a DIFFERENT request while it runs
    assert len(captured) == 1


async def test_a_different_key_or_no_key_starts_again(captured):
    user = await make_user(email("idem"), plan="pro")
    token = await user_token(user)
    async with client() as c:
        uid = await _project(c, token)
        try:
            assert (await _analyze(c, token, uid, key="req-4")).status_code == 202
            await _finish(uid)
            assert (await _analyze(c, token, uid, key="req-5")).status_code == 202
            await _finish(uid)
            assert (await _analyze(c, token, uid)).status_code == 202
            row = await _row(uid)
        finally:
            _cleanup(uid)
    assert len(captured) == 3
    # A start without a key forgets the previous one: a late retry of req-5
    # must not replay over a newer start.
    assert "idempotency" not in (row["local_meta"] or {})


async def test_a_key_is_per_route(captured):
    """The same key on another route is another operation, not a replay."""
    user = await make_user(email("idem"), plan="pro")
    token = await user_token(user)
    async with client() as c:
        uid = await _project(c, token)
        try:
            assert (await _analyze(c, token, uid, key="shared")).status_code == 202
            await _finish(uid)
            headers = {**bearer(token), videos_local.IDEMPOTENCY_HEADER: "shared"}
            r = await c.post(
                f"/videos/{uid}/reedit-dub-scenes",
                data={"manifest": json.dumps({"instruction": "x"})},
                files=[("preview", ("p.mp4", video_bytes(2), "video/mp4"))],
                headers=headers,
            )
        finally:
            _cleanup(uid)
    # Not a replay (it would have been a 202 with the analyze job): the
    # re-edit ran its own checks and refused on its own terms.
    assert r.status_code != 202 or len(captured) == 2


async def test_an_expired_key_is_forgotten(captured, monkeypatch):
    user = await make_user(email("idem"), plan="pro")
    token = await user_token(user)
    async with client() as c:
        uid = await _project(c, token)
        try:
            assert (await _analyze(c, token, uid, key="old")).status_code == 202
            await _finish(uid)
            monkeypatch.setattr(videos_local, "IDEMPOTENCY_TTL_SEC", -1)
            r = await _analyze(c, token, uid, key="old")
        finally:
            _cleanup(uid)
    assert r.status_code == 202 and len(captured) == 2


async def test_a_malformed_key_is_refused_rather_than_stored(captured):
    user = await make_user(email("idem"), plan="pro")
    token = await user_token(user)
    async with client() as c:
        uid = await _project(c, token)
        try:
            r = await _analyze(c, token, uid, key="x" * 129)
            bad = await _analyze(c, token, uid, key="has space")
        finally:
            _cleanup(uid)
    assert r.status_code == 422 and bad.status_code == 422
    assert captured == []


# ── enqueue failure ──────────────────────────────────────────────────────────

async def test_a_start_whose_enqueue_fails_is_restartable_at_once(captured, monkeypatch):
    """Before: the run was released but the row stayed ``processing`` — the
    one status a start refuses — until the stale reaper or a manual stop."""
    from fastapi import HTTPException

    async def broken(job_id, fn, **kwargs):
        raise HTTPException(503, "queue down")

    monkeypatch.setattr(videos_local, "_enqueue", broken)
    user = await make_user(email("enq"), plan="pro")
    token = await user_token(user)
    async with client() as c:
        uid = await _project(c, token)
        try:
            r = await _analyze(c, token, uid)
            row = await _row(uid)
            job = await db("SELECT status, error FROM core.jobs WHERE id = :j", j=row["job_id"])
            # The queue is back: the same start goes through without a stop.
            monkeypatch.setattr(videos_local, "_enqueue", captured_enqueue := _recorder(captured))
            retry = await _analyze(c, token, uid)
        finally:
            _cleanup(uid)
    assert r.status_code == 503, r.text
    assert row["status"] == "error" and "คิว" in row["error_msg"]
    assert job[0][0] == "error"
    assert retry.status_code == 202, retry.text
    assert len(captured) == 1
    runs = await _runs(user)
    # The failed start's run was released (not left open); the retry's is open.
    assert next(s for _k, s in runs) != "open" and len(runs) == 2
    _ = captured_enqueue


def _recorder(calls: list[dict]):
    async def fake_enqueue(job_id, fn, **kwargs):
        calls.append({"job_id": job_id, "fn": fn, **kwargs})

    return fake_enqueue
