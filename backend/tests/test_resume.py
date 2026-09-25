"""Resuming a run the plan's window paused.

Pausing was already there (the project parks in ``paused_quota`` and keeps what
it produced); what these tests pin is the other half — that starting again
continues from the boundary it stopped at instead of from zero, charges only
for that boundary, survives a double click, and pauses again cleanly when the
window has not rolled yet.
"""

from __future__ import annotations

import json
import shutil
from datetime import UTC, datetime

import pytest

from packages.billing import guard, limits
from packages.billing import resume as resume_mod
from packages.core.settings import get_settings
from packages.db.models.video_project import (
    advance_stage,
    next_stage,
    stage_order,
)
from packages.db.tenancy import SHARED_DATA_SCHEMA
from packages.video.storage import data_root
from services.api.routers import videos_local
from services.worker import tasks
from tests.admin_helpers import (  # noqa: F401
    _admin_env,
    bearer,
    client,
    db,
    email,
    make_user,
    user_token,
)
from tests.media_helpers import video_bytes

RESETS = datetime(2026, 9, 30, 8, 0, tzinfo=UTC)


# ── the stage machine (no DB) ────────────────────────────────────────────────

def test_a_stage_only_ever_moves_forward():
    """``stage`` means "the furthest boundary this project reached". A late
    report from a client repeating an earlier step must not drag it back and
    make a resume redo work the project already has."""
    assert advance_stage("proxy", "analyze", "dub_first") == "analyze"
    assert advance_stage("plan", "analyze", "dub_first") == "plan"
    assert advance_stage(None, "imported", "dub_first") == "imported"
    # A stage the mode does not have, and a value that is not a stage at all.
    assert advance_stage("analyze", "transcribe", "dub_first") == "analyze"
    assert advance_stage("analyze", "reedit", "dub_first") == "analyze"
    assert advance_stage("analyze", None, "dub_first") == "analyze"


def test_each_mode_knows_which_boundary_comes_next():
    assert next_stage("dub_first", "analyze") == "render_silent"
    assert next_stage("dub_first", "voiceover") == "plan"
    assert next_stage("dub_first", "done") is None
    # No voiceover in highlight: the silent cut is the result.
    assert "voiceover" not in stage_order("highlight")
    assert next_stage("highlight", "analyze") == "render_silent"
    assert next_stage("talking_head", "extract_audio") == "transcribe"
    assert next_stage("speech_highlights", "transcribe") == "select"
    # An unknown mode follows dub_first rather than losing its order entirely.
    assert next_stage("something_new", "analyze") == "render_silent"


# ── the ticket (no DB) ───────────────────────────────────────────────────────

def test_the_ticket_prices_the_interrupted_stage_and_not_the_pipeline():
    """The whole point of resuming: a run paused after the analyze is charged
    for the planning call only, not for reading 5 minutes of video again."""
    analyze = resume_mod.ticket(stage="analyze", kind="analyze_video", media_sec=300.0)
    plan = resume_mod.ticket(stage="plan", kind="plan_dub")
    analyze_est = resume_mod.estimate_for(analyze, engine="lite", precision="standard")
    plan_est = resume_mod.estimate_for(plan, engine="lite", precision="standard")
    assert analyze_est is not None and plan_est is not None
    assert analyze_est.kind == "analyze_video" and analyze_est.media_sec == 300.0
    assert plan_est.kind == "plan_dub" and plan_est.media_sec == 0.0
    assert plan_est.tokens < analyze_est.tokens / 2


def test_a_frames_ticket_keeps_the_image_count_it_was_priced_on():
    state = resume_mod.ticket(stage="analyze", kind="analyze_frames", frame_count=40)
    est = resume_mod.estimate_for(state)
    bigger = resume_mod.estimate_for(
        resume_mod.ticket(stage="analyze", kind="analyze_frames", frame_count=80)
    )
    assert est is not None and bigger is not None and bigger.tokens > est.tokens


def test_pausing_stamps_the_ticket_without_losing_how_to_redo_the_stage():
    state = resume_mod.ticket(
        stage="analyze", kind="analyze_video", media_sec=12.0,
        task="analyze_dub_video_local", kwargs={"project_uid": "p", "tenant_slug": "t"},
        job_id="vlocal_abcd1234",
    )
    paused = resume_mod.mark_paused(
        state, window="weekly", resets_at=RESETS, wallet_can_cover=True,
        wallet_satang=4_200, run_id="r" * 32, message="หมดโควตา",
    )
    assert paused["task"] == "analyze_dub_video_local"
    assert paused["kwargs"] == {"project_uid": "p", "tenant_slug": "t"}
    assert paused["window"] == "weekly" and paused["resets_at"].endswith("Z")
    assert paused["wallet_can_cover"] is True and paused["wallet_satang"] == 4_200
    assert paused["paused"] is True and paused["reason"] == "quota"


def test_a_pause_with_no_ticket_still_produces_a_usable_one():
    """A project paused by a build from before tickets existed: the pause facts
    alone still tell the client when the window rolls."""
    paused = resume_mod.mark_paused(None, stage="analyze", window="five_hour")
    assert resume_mod.is_current(paused) and paused["stage"] == "analyze"
    assert resume_mod.estimate_for(paused) is None  # no kind — nothing to price


def test_a_ticket_from_another_version_is_ignored_rather_than_guessed_at():
    assert not resume_mod.is_current({"v": 99, "stage": "analyze", "kind": "analyze_video"})
    assert resume_mod.estimate_for({"v": 99, "kind": "analyze_video"}) is None
    assert resume_mod.estimate_for({"v": 1, "kind": "not_a_kind"}) is None


# ── through the API ──────────────────────────────────────────────────────────

@pytest.fixture
def captured(monkeypatch):
    monkeypatch.setenv("REQUIRE_VERIFIED_EMAIL_FOR_AI", "false")
    get_settings.cache_clear()
    calls: list[dict] = []

    async def fake_enqueue(job_id, fn, **kwargs):
        calls.append({"job_id": job_id, "fn": fn, **kwargs})

    monkeypatch.setattr(videos_local, "_enqueue", fake_enqueue)
    yield calls


async def _project(c, token: str, seconds: float = 30, mode: str = "dub_first") -> str:
    r = await c.post(
        "/videos/local",
        json={"mode": mode, "clips": [{"id": "c1", "durationSec": seconds}], "engine": "lite"},
        headers=bearer(token),
    )
    assert r.status_code == 201, r.text
    return r.json()["uid"]


async def _analyze(c, token: str, uid: str, *, seconds: float = 10, **form):
    manifest = json.dumps([{"clip_id": "c1", "file": "p.mp4", "durationSec": seconds}])
    return await c.post(
        f"/videos/{uid}/analyze-video",
        data={"manifest": manifest, **form},
        files=[("files", ("p.mp4", video_bytes(seconds), "video/mp4"))],
        headers=bearer(token),
    )


def _cleanup(uid: str) -> None:
    shutil.rmtree(data_root() / "video_outputs" / uid, ignore_errors=True)


async def _row(uid: str) -> dict:
    rows = await db(
        f"SELECT status, stage, resume_state, job_id FROM {SHARED_DATA_SCHEMA}.video_projects "
        "WHERE uid = :p",
        p=uid,
    )
    status, stage, state, job_id = rows[0]
    return {"status": status, "stage": stage, "resume_state": state, "job_id": job_id}


async def _pause(uid: str, job_id: str, run_id: str | None = None) -> None:
    """What the worker does when the window runs out mid-run."""
    await db(
        f"UPDATE {SHARED_DATA_SCHEMA}.video_projects SET status = 'error', error_msg = 'x' "
        "WHERE uid = :p",
        p=uid,
    )
    await tasks._mark_stopped(
        job_id,
        guard.QuotaExhausted(
            run_id, window="weekly", resets_at=RESETS, wallet_can_cover=True, wallet_satang=4_200,
        ),
        kwargs={"project_uid": uid, "tenant_slug": "default"},
        paused=True,
        run_id=run_id,
    )


async def _fill_the_window(user_id: int, plan: str) -> None:
    await db(
        "INSERT INTO core.usage_accounts (user_id, monthly_started_at, monthly_used, reserved_tokens) "
        "VALUES (:u, now(), :m, 0) ON CONFLICT (user_id) DO UPDATE SET monthly_used = :m, "
        "monthly_started_at = now()",
        u=user_id, m=limits.window_limit(plan, "monthly"),
    )


async def _runs(user_id: int) -> list[tuple]:
    return [tuple(r) for r in await db(
        "SELECT kind, status, estimate_tokens FROM core.ai_runs WHERE user_id = :u ORDER BY created_at",
        u=user_id,
    )]


async def test_the_server_records_where_the_work_got_to(captured):
    """Requirement 1: the boundary and the ticket live on the row, not in a
    project.json that only one browser has."""
    user = await make_user(email("resume"), plan="pro")
    token = await user_token(user)
    async with client() as c:
        uid = await _project(c, token)
        try:
            assert (await _row(uid))["stage"] == "imported"
            assert (await _analyze(c, token, uid)).status_code == 202
            row = await _row(uid)
        finally:
            _cleanup(uid)
    assert row["status"] == "processing" and row["stage"] == "proxy"
    state = row["resume_state"]
    assert state["stage"] == "analyze" and state["task"] == "analyze_dub_video_local"
    assert state["kwargs"]["project_uid"] == uid
    assert state["kind"] == "analyze_video" and state["media_sec"] > 0


async def test_a_paused_project_says_where_it_stopped_and_what_finishing_costs(captured):
    """Requirement 5, read side: paused, which window, when it rolls, and
    whether the balance covers the rest."""
    user = await make_user(email("resume"), plan="pro")
    token = await user_token(user)
    async with client() as c:
        uid = await _project(c, token)
        try:
            await _analyze(c, token, uid)
            await _pause(uid, f"vlocal_{uid[:8]}")
            r = await c.get(f"/videos/{uid}/resume", headers=bearer(token))
        finally:
            _cleanup(uid)
    assert r.status_code == 200, r.text
    view = r.json()
    assert view["paused"] is True and view["reason"] == "quota"
    assert view["stage"] == "proxy" and view["next_stage"] == "analyze"
    assert view["runs_on"] == "server" and view["resumable"] is True
    assert view["window"] == "weekly" and view["window_resets_at"].endswith("Z")
    assert view["charges"] is True and view["estimate_source"] == "ticket"
    assert view["quota"]["fits"] in ("plan", "wallet", "none")
    assert set(view["quota"]) >= {"fits", "pct", "wallet_satang", "balance_satang", "resets_at"}
    # Percentages and baht only — never a token count (token-billing-plan §2).
    assert not any("token" in k for k in view["quota"])


async def test_resuming_re_runs_the_paused_stage_and_nothing_before_it(captured):
    """Requirement 2: the same worker task, the same already-uploaded files,
    one new run priced on that stage alone."""
    user = await make_user(email("resume"), plan="pro")
    token = await user_token(user)
    async with client() as c:
        uid = await _project(c, token)
        try:
            await _analyze(c, token, uid)
            started = list(captured)
            await _pause(uid, f"vlocal_{uid[:8]}")
            r = await c.post(f"/videos/{uid}/resume", json={}, headers=bearer(token))
            row = await _row(uid)
        finally:
            _cleanup(uid)
    assert r.status_code == 200, r.text
    view = r.json()
    assert view["action"] == "server_job" and view["resumed"] is True
    assert view["job_id"] == f"vlocal_{uid[:8]}" and len(view["run_id"]) == 32
    # Exactly the job the pause interrupted, with the kwargs it was given.
    assert len(captured) == len(started) + 1
    again = captured[-1]
    assert again["fn"] == "analyze_dub_video_local" and again["project_uid"] == uid
    assert again["run_id"] == view["run_id"]
    # Two runs of the SAME stage — never the pipeline re-priced from the start.
    opened = await _runs(user)
    assert [k for k, _s, _t in opened] == ["analyze_video", "analyze_video"]
    assert opened[0][2] == opened[1][2]
    assert row["status"] == "processing" and row["resume_state"]["resumes"] == 1


async def test_resuming_twice_neither_duplicates_the_work_nor_charges_twice(captured):
    """Requirement 3: a double click, or a retry after a dropped response."""
    user = await make_user(email("resume"), plan="pro")
    token = await user_token(user)
    async with client() as c:
        uid = await _project(c, token)
        try:
            await _analyze(c, token, uid)
            await _pause(uid, f"vlocal_{uid[:8]}")
            first = await c.post(f"/videos/{uid}/resume", json={}, headers=bearer(token))
            enqueued = len(captured)
            second = await c.post(f"/videos/{uid}/resume", json={}, headers=bearer(token))
        finally:
            _cleanup(uid)
    assert first.json()["action"] == "server_job"
    assert second.status_code == 200 and second.json()["action"] == "already_running"
    assert second.json()["job_id"] == first.json()["job_id"]
    # Every answer carries the same keys, so the client never branches on
    # whether a field happens to be there.
    assert set(first.json()) == set(second.json())
    assert len(captured) == enqueued  # nothing enqueued a second time
    assert len(await _runs(user)) == 2  # the original run and the one resume


async def test_two_resumes_at_once_still_start_the_work_once(captured):
    """The same double click, but genuinely simultaneous. The project row is
    locked for the whole decision, so the second request waits for the first
    one's answer instead of opening a second billed copy of the stage."""
    import asyncio

    user = await make_user(email("resume"), plan="pro")
    token = await user_token(user)
    async with client() as c:
        uid = await _project(c, token)
        try:
            await _analyze(c, token, uid)
            enqueued = len(captured)
            await _pause(uid, f"vlocal_{uid[:8]}")
            a, b = await asyncio.gather(
                c.post(f"/videos/{uid}/resume", json={}, headers=bearer(token)),
                c.post(f"/videos/{uid}/resume", json={}, headers=bearer(token)),
            )
        finally:
            _cleanup(uid)
    actions = sorted(r.json()["action"] for r in (a, b))
    assert actions == ["already_running", "server_job"]
    assert len(captured) == enqueued + 1
    assert len(await _runs(user)) == 2  # the original run and ONE resume


async def test_a_resume_that_still_does_not_fit_pauses_again_instead_of_erroring(captured):
    """Requirement 4: resuming before the window rolls is not an error. The run
    starts, the guard stops it at the first call, and the project parks again
    with its ticket intact."""
    user = await make_user(email("resume"), plan="free")
    token = await user_token(user)
    async with client() as c:
        uid = await _project(c, token, seconds=10)
        try:
            await _analyze(c, token, uid)
            await _pause(uid, f"vlocal_{uid[:8]}")
            await _fill_the_window(user, "free")
            view = await c.get(f"/videos/{uid}/resume", headers=bearer(token))
            r = await c.post(f"/videos/{uid}/resume", json={}, headers=bearer(token))
            # …and the worker runs straight into the same empty window.
            await _pause(uid, f"vlocal_{uid[:8]}")
            row = await _row(uid)
        finally:
            _cleanup(uid)
    # The read says up front that the plan cannot pay for it.
    assert view.json()["quota"]["fits"] in ("wallet", "none")
    assert r.status_code == 200 and r.json()["action"] == "server_job"
    assert row["status"] == "paused_quota"
    state = row["resume_state"]
    assert state["paused"] is True and state["stage"] == "analyze"
    assert state["task"] == "analyze_dub_video_local" and state["resumes"] == 1


async def test_a_paused_planning_call_is_handed_back_to_the_client(captured):
    """The one paid stage the client drives itself: the numbers it needs live
    on the user's machine, so the ticket names the call to repeat instead of a
    worker task — and the project stops reading as paused."""
    user = await make_user(email("resume"), plan="pro")
    token = await user_token(user)
    body = {"voDurationSec": 21.5, "clipDurations": [10.0, 12.0]}
    async with client() as c:
        uid = await _project(c, token)
        try:
            await db(
                f"UPDATE {SHARED_DATA_SCHEMA}.video_projects SET status = 'paused_quota', "
                "stage = 'voiceover', edit_script_path = 'video_outputs/x/edit_script.json', "
                "resume_state = CAST(:s AS jsonb) WHERE uid = :p",
                p=uid,
                s=json.dumps(resume_mod.mark_paused(
                    resume_mod.ticket(
                        stage="plan", kind="plan_dub",
                        client_step={"method": "POST", "path": f"/videos/{uid}/plan-dub", "body": body},
                    ),
                    window="five_hour", resets_at=RESETS,
                )),
            )
            view = await c.get(f"/videos/{uid}/resume", headers=bearer(token))
            r = await c.post(f"/videos/{uid}/resume", json={}, headers=bearer(token))
            row = await _row(uid)
            again = await c.post(f"/videos/{uid}/resume", json={}, headers=bearer(token))
        finally:
            _cleanup(uid)
    assert view.json()["runs_on"] == "client"
    out = r.json()
    assert out["action"] == "client_step" and out["client_step"]["body"] == body
    assert out["client_step"]["path"] == f"/videos/{uid}/plan-dub"
    assert captured == []  # nothing enqueued, nothing charged
    assert await _runs(user) == []
    # The pause is cleared: a free step must not leave every screen saying
    # "out of quota". Asking again gives the same answer, not an error.
    assert row["status"] == "waiting_vo"
    assert again.status_code == 200 and again.json()["action"] == "client_step"


async def test_a_paused_re_cut_resumes_as_itself_without_moving_the_boundary(captured):
    """An AI re-cut redoes the analyze boundary instead of advancing one. It
    still gets a ticket, so a pause in the middle of it is resumable like any
    other — and resuming re-runs the re-cut, not the pipeline."""
    user = await make_user(email("resume"), plan="pro")
    token = await user_token(user)
    async with client() as c:
        uid = await _project(c, token)
        try:
            await db(
                f"UPDATE {SHARED_DATA_SCHEMA}.video_projects SET status = 'paused_quota', "
                "stage = 'analyze', edit_script_path = 'video_outputs/x/edit_script.json', "
                "resume_state = CAST(:s AS jsonb) WHERE uid = :p",
                p=uid,
                s=json.dumps(resume_mod.mark_paused(
                    resume_mod.ticket(
                        stage="reedit", kind="reedit", media_sec=24.0,
                        task="reedit_dub_scenes_local", job_id=f"vlocal_{uid[:8]}",
                        kwargs={"project_uid": uid, "tenant_slug": "default", "style_uid": ""},
                    ),
                    window="weekly", resets_at=RESETS,
                )),
            )
            r = await c.post(f"/videos/{uid}/resume", json={}, headers=bearer(token))
            row = await _row(uid)
        finally:
            _cleanup(uid)
    assert r.json()["action"] == "server_job" and r.json()["next_stage"] == "reedit"
    assert captured[-1]["fn"] == "reedit_dub_scenes_local"
    assert captured[-1]["style_uid"] == ""
    assert [k for k, _s, _t in await _runs(user)] == ["reedit"]
    assert row["stage"] == "analyze"  # a re-cut never advances the boundary


async def test_another_device_can_ask_the_server_where_the_work_got_to(captured):
    """Requirement 1: no project.json involved. A client that has never seen
    this project still learns the boundary and what comes next."""
    user = await make_user(email("resume"), plan="pro")
    token = await user_token(user)
    async with client() as c:
        uid = await _project(c, token, mode="talking_head")
        try:
            r = await c.get(f"/videos/{uid}/resume", headers=bearer(token))
        finally:
            _cleanup(uid)
    view = r.json()
    assert view["paused"] is False and view["stage"] == "imported"
    assert view["next_stage"] == "extract_audio" and view["runs_on"] == "client"
    assert view["stages"][:3] == ["imported", "extract_audio", "transcribe"]
    assert view["charges"] is False  # extracting audio runs on the user's machine


async def test_reporting_a_finished_stage_retires_the_ticket(captured):
    """The client got past the pause on its own — there is nothing left to
    resume, and a ticket left behind would let a later resume pay again."""
    user = await make_user(email("resume"), plan="pro")
    token = await user_token(user)
    async with client() as c:
        uid = await _project(c, token)
        try:
            await _analyze(c, token, uid)
            await _pause(uid, f"vlocal_{uid[:8]}")
            r = await c.patch(
                f"/videos/{uid}/local-status",
                json={"status": "waiting_vo", "stage": "analyze"},
                headers=bearer(token),
            )
            row = await _row(uid)
            enqueued = len(captured)
            after = await c.post(f"/videos/{uid}/resume", json={}, headers=bearer(token))
        finally:
            _cleanup(uid)
    assert r.status_code == 200 and r.json()["stage"] == "analyze"
    assert row["resume_state"] is None and row["stage"] == "analyze"
    # What is left is the client's own silent render — free, and nothing to enqueue.
    assert after.json()["action"] == "client_step" and after.json()["next_stage"] == "render_silent"
    assert len(captured) == enqueued
    assert len(await _runs(user)) == 1  # the analyze only — the resume paid nothing


async def test_an_unknown_stage_is_refused_rather_than_stored(captured):
    user = await make_user(email("resume"), plan="pro")
    token = await user_token(user)
    async with client() as c:
        uid = await _project(c, token)
        try:
            r = await c.patch(
                f"/videos/{uid}/local-status",
                json={"status": "processing", "stage": "not_a_stage"},
                headers=bearer(token),
            )
        finally:
            _cleanup(uid)
    assert r.status_code == 422


async def test_a_finished_project_has_nothing_to_resume(captured):
    user = await make_user(email("resume"), plan="pro")
    token = await user_token(user)
    async with client() as c:
        uid = await _project(c, token)
        try:
            await c.patch(
                f"/videos/{uid}/local-status", json={"status": "done"}, headers=bearer(token)
            )
            r = await c.post(f"/videos/{uid}/resume", json={}, headers=bearer(token))
        finally:
            _cleanup(uid)
    assert r.status_code == 200 and r.json()["action"] == "nothing_to_resume"
    assert r.json()["stage"] == "done" and captured == []


async def test_resume_reads_the_project_of_the_caller_only(captured):
    mine = await make_user(email("resume"), plan="pro")
    other = await make_user(email("resume"), plan="pro")
    token, stranger = await user_token(mine), await user_token(other)
    async with client() as c:
        uid = await _project(c, token)
        try:
            get = await c.get(f"/videos/{uid}/resume", headers=bearer(stranger))
            post = await c.post(f"/videos/{uid}/resume", json={}, headers=bearer(stranger))
        finally:
            _cleanup(uid)
    assert get.status_code == 404 and post.status_code == 404
