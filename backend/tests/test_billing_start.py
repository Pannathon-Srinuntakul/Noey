"""Every route that starts AI work reserves first (services/api/billing_start.py).

The structural test walks the app: each ``AI_ROUTES`` endpoint must call
``start_paid_run``. The behaviour tests drive ``POST /videos/{uid}/analyze-video``
end to end (the worker enqueue is captured, nothing is sent anywhere).
"""

import inspect
import json
import shutil
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from packages.billing import free_tier, guard, limits
from packages.core.settings import get_settings
from packages.video.storage import data_root
from services.api.ai_gate import AI_ROUTES
from services.api.main import app
from services.api.routers import videos_local
from tests.admin_helpers import (  # noqa: F401
    _admin_env,
    bearer,
    client,
    db,
    email,
    make_user,
    user_token,
)
from tests.media_helpers import video_bytes, wav_bytes


def _endpoint(method: str, path: str):
    """Walk the app like tests/test_admin_security.py does (routers may nest)."""
    found = []

    def walk(routes) -> None:
        for r in routes:
            inner = getattr(r, "original_router", None) or getattr(r, "routes", None)
            if inner is not None:
                walk(getattr(inner, "routes", inner))
                continue
            if getattr(r, "path", None) == path and method in (getattr(r, "methods", None) or set()):
                found.append(r.endpoint)

    walk(app.routes)
    assert found, f"no route {method} {path}"
    return found[0]


@pytest.mark.parametrize(("method", "path"), sorted(AI_ROUTES))
def test_every_ai_route_reserves_before_it_starts_work(method, path):
    fn = _endpoint(method, path)
    source = inspect.getsource(fn)
    # A route may reach it through one small helper of its own module.
    module = inspect.getmodule(fn)
    helpers = [
        inspect.getsource(obj) for name, obj in vars(module).items()
        if inspect.isfunction(obj) and name.startswith("_") and name in source
    ]
    assert any("start_paid_run" in s for s in (source, *helpers)), f"{method} {path} does not reserve"
    assert "allow_wallet" in source, f"{method} {path} cannot continue on the wallet"


# ── behaviour, through analyze-video ─────────────────────────────────────────

@pytest.fixture
def captured(monkeypatch):
    monkeypatch.setenv("REQUIRE_VERIFIED_EMAIL_FOR_AI", "false")
    get_settings.cache_clear()
    calls: list[dict] = []

    async def fake_enqueue(job_id, fn, **kwargs):
        calls.append({"job_id": job_id, "fn": fn, **kwargs})

    monkeypatch.setattr(videos_local, "_enqueue", fake_enqueue)
    yield calls


async def _project(c, token: str, seconds: float, engine: str = "lite") -> str:
    r = await c.post(
        "/videos/local",
        json={"mode": "dub_first", "clips": [{"id": "c1", "durationSec": seconds}], "engine": engine},
        headers=bearer(token),
    )
    assert r.status_code == 201, r.text
    return r.json()["uid"]


async def _analyze(c, token: str, uid: str, *, seconds: float = 10, body: bytes | None = None,
                   name: str = "p.mp4", declared: float = 10, **form):
    manifest = json.dumps([{"clip_id": "c1", "file": name, "durationSec": declared}])
    return await c.post(
        f"/videos/{uid}/analyze-video",
        data={"manifest": manifest, **form},
        files=[("files", (name, video_bytes(seconds) if body is None else body, "video/mp4"))],
        headers=bearer(token),
    )


def _cleanup(uid: str) -> None:
    shutil.rmtree(data_root() / "video_outputs" / uid, ignore_errors=True)


async def _open_runs(user_id: int) -> list[tuple]:
    return [tuple(r) for r in await db(
        "SELECT kind, status, estimate_tokens, reserved_tokens, job_id FROM core.ai_runs WHERE user_id = :u", u=user_id
    )]


async def test_a_start_opens_the_run_and_hands_it_to_the_worker(captured):
    """Nothing is held any more (owner, 2026-09-26): the row is opened with a
    zero reservation and the run is charged per call as it goes."""
    uid_user = await make_user(email("start"), plan="pro")
    token = await user_token(uid_user)
    async with client() as c:
        project = await _project(c, token, 30)
        try:
            r = await _analyze(c, token, project)
        finally:
            _cleanup(project)
    assert r.status_code == 202, r.text
    [call] = captured
    runs = await _open_runs(uid_user)
    assert call["fn"] == "analyze_dub_video_local" and len(call["run_id"]) == 32
    assert runs == [("analyze_video", "queued", runs[0][2], 0, videos_local.local_job_id(project))]
    held = await db("SELECT reserved_tokens FROM core.usage_accounts WHERE user_id = :u", u=uid_user)
    assert held == [] or held[0][0] == 0


async def _fill_lifetime(user_id: int, left: int) -> None:
    """Free's enforced window is its one-time lifetime credit; leave ``left``."""
    await db(
        "INSERT INTO core.usage_accounts (user_id, lifetime_started_at, lifetime_used, reserved_tokens) "
        "VALUES (:u, now(), :m, 0) ON CONFLICT (user_id) DO UPDATE SET lifetime_used = :m, lifetime_started_at = now()",
        u=user_id, m=limits.window_limit("free", "lifetime") - left,
    )


async def test_a_nearly_spent_window_does_not_refuse_the_start(captured):
    """The estimate is ADVICE (owner, 2026-10-01): with far less left than the
    run is estimated at — but within the allowed overage — the start goes
    ahead; the run is sent call by call and pauses at 100 %."""
    uid_user = await make_user(email("start"), plan="free")
    token = await user_token(uid_user)
    await _fill_lifetime(uid_user, left=50_000)  # a 60 s cut is estimated at ~137k
    async with client() as c:
        project = await _project(c, token, 10)
        try:
            r = await _analyze(c, token, project, seconds=60)
        finally:
            _cleanup(project)
    assert r.status_code == 202, r.text
    assert [(k, s) for k, s, *_ in await _open_runs(uid_user)] == [("analyze_video", "queued")]


async def test_concurrent_starts_cannot_each_take_the_whole_overage(captured, monkeypatch):
    """Pro runs two jobs at once. Each new start counts what the runs already
    in flight still expect to spend as gone, and the check is repeated under
    the account lock where the run opens — so two starts fired together
    cannot both see the same headroom. Ratio shrunk to 1 % (56k of Pro's
    5.6M) so a 10 s Scout cut (~85k) is enough to show it."""
    import asyncio

    monkeypatch.setenv("BILLING_MAX_OVERAGE_RATIO", "0.01")
    get_settings.cache_clear()
    uid_user = await make_user(email("start"), plan="pro")
    token = await user_token(uid_user)
    month = limits.window_limit("pro", "monthly")
    await db(
        "INSERT INTO core.usage_accounts (user_id, monthly_started_at, monthly_used, monthly_anchor_day, "
        "reserved_tokens) VALUES (:u, date_trunc('day', now()), :m, EXTRACT(DAY FROM now()), 0) "
        "ON CONFLICT (user_id) DO UPDATE SET monthly_used = :m, monthly_started_at = date_trunc('day', now()), "
        "monthly_anchor_day = EXTRACT(DAY FROM now())",
        u=uid_user, m=month - 100_000,
    )
    async with client() as c:
        first, second = await _project(c, token, 10), await _project(c, token, 10)
        try:
            a, b = await asyncio.gather(_analyze(c, token, first), _analyze(c, token, second))
        finally:
            _cleanup(first)
            _cleanup(second)
    get_settings.cache_clear()
    codes = sorted([a.status_code, b.status_code])
    assert codes == [202, 402], (a.text, b.text)
    refused = a if a.status_code == 402 else b
    assert refused.json()["detail"]["code"] == "overage_too_large"
    assert [(k, s) for k, s, *_ in await _open_runs(uid_user)] == [("analyze_video", "queued")]


async def test_a_run_far_bigger_than_what_is_left_is_refused_at_start(captured):
    """Run c3c2e938 (2026-10-01): 31k of the 450k Free credit left, a 5.5-min
    cut estimated at 164,756 — 133,756 past what is left, more than 25 % of
    the credit (112,500). Refused BEFORE anything uploads into place or any
    run opens, and the message says what to do."""
    uid_user = await make_user(email("start"), plan="free")
    token = await user_token(uid_user)
    await _fill_lifetime(uid_user, left=31_000)
    async with client() as c:
        project = await _project(c, token, 10, engine="pro")
        scout = await _project(c, token, 10, engine="lite")
        try:
            refused = await _analyze(c, token, project, seconds=331.8, declared=331.8)
            stored = (data_root() / "video_outputs" / project / "proxy").exists()
            # The suggestion is real: Scout's estimate (118k, e3) is within it.
            on_scout = await _analyze(c, token, scout, seconds=331.8, declared=331.8)
        finally:
            _cleanup(project)
            _cleanup(scout)
    assert on_scout.status_code == 202, on_scout.text
    assert refused.status_code == 402, refused.text
    detail = refused.json()["detail"]
    assert detail["code"] == "overage_too_large" and detail["window"] == "lifetime"
    assert detail["resets"] is False and "Scout" in detail["message"]
    assert not any("token" in k for k in detail)
    assert not stored and len(captured) == 1
    assert [(k, s) for k, s, *_ in await _open_runs(uid_user)] == [("analyze_video", "queued")]


async def test_a_full_window_refuses_new_projects_and_new_runs(captured):
    """At exactly 100 % nothing NEW starts — not a project (its footage would
    upload only to be refused) and not a run on an existing one — and the
    refusal is the trial-credit one, with no reset to wait for."""
    uid_user = await make_user(email("start"), plan="free")
    token = await user_token(uid_user)
    async with client() as c:
        project = await _project(c, token, 10)  # made while there was credit
        await _fill_lifetime(uid_user, left=0)
        try:
            refused_run = await _analyze(c, token, project, seconds=10)
            stored = (data_root() / "video_outputs" / project / "proxy").exists()
            refused_project = await c.post(
                "/videos/local",
                json={"mode": "dub_first", "clips": [{"id": "c1", "durationSec": 10}], "engine": "lite"},
                headers=bearer(token),
            )
        finally:
            _cleanup(project)
    for r in (refused_run, refused_project):
        assert r.status_code == 402, r.text
        detail = r.json()["detail"]
        assert detail["code"] == "limit_reached" and detail["full"] is True
        assert detail["window"] == "lifetime" and detail["resets"] is False
        assert detail["wallet_can_cover"] is False and "อัปเกรด" in detail["message"]
        assert not any("token" in k for k in detail)
    assert not stored and captured == [] and await _open_runs(uid_user) == []


def _window(headroom: int, *, limit: int = 800_000, wallet_satang: int = 0):
    from datetime import UTC, datetime

    from packages.billing.runs import StartWindow

    return StartWindow(
        window="monthly", limit=limit, headroom=headroom,
        resets_at=datetime(2026, 11, 1, tzinfo=UTC), wallet_satang=wallet_satang,
    )


def test_a_full_window_lets_a_balance_the_user_allowed_carry_new_work():
    full = _window(0, wallet_satang=5_000)
    assert guard.quota_full_refusal(None, allow_wallet=False) is None
    assert guard.quota_full_refusal(_window(1), allow_wallet=False) is None
    assert guard.quota_full_refusal(full, allow_wallet=True) is None
    asked = guard.quota_full_refusal(full, allow_wallet=False, need_satang=8_000)
    assert asked is not None and asked["wallet_can_cover"] is True and asked["wallet_satang"] == 5_000
    assert asked["resets"] is True and asked["resets_at"] == "2026-11-01T00:00:00Z"
    broke = guard.quota_full_refusal(_window(-50), allow_wallet=True)  # past 100 %: full too
    assert broke is not None and broke["wallet_can_cover"] is False


def test_the_overage_a_new_run_may_be_expected_to_take_is_a_setting(monkeypatch):
    from packages.billing import wallet

    # 25 % of an 800k window = 200k past what is left.
    assert guard.overage_refusal(_window(10_000), 210_000, allow_wallet=False) is None
    refused = guard.overage_refusal(_window(10_000), 210_001, allow_wallet=False)
    assert refused is not None and refused["code"] == "overage_too_large"
    assert refused["wallet_satang"] == wallet.satang_for_tokens(200_001)
    # A balance the user allows and that covers everything past what is left.
    rich = _window(10_000, wallet_satang=wallet.satang_for_tokens(200_001))
    assert guard.overage_refusal(rich, 210_001, allow_wallet=True) is None
    assert guard.overage_refusal(rich, 210_001, allow_wallet=False) is not None
    monkeypatch.setenv("BILLING_MAX_OVERAGE_RATIO", "0.5")
    monkeypatch.setenv("BILLING_MAX_OVERAGE_TOKENS", "1000000")
    get_settings.cache_clear()
    try:
        assert guard.overage_refusal(_window(10_000), 410_000, allow_wallet=False) is None
    finally:
        monkeypatch.delenv("BILLING_MAX_OVERAGE_RATIO")
        monkeypatch.delenv("BILLING_MAX_OVERAGE_TOKENS")
        get_settings.cache_clear()


def test_a_big_plan_overage_is_capped_in_tokens_not_just_by_ratio():
    # Max (48M): 25 % would allow 12M past what is left; the absolute cap
    # (300k by default) is what bounds it — a few baht at most.
    big = _window(10_000, limit=48_000_000)
    assert guard.overage_refusal(big, 310_000, allow_wallet=False) is None
    refused = guard.overage_refusal(big, 310_001, allow_wallet=False)
    assert refused is not None and refused["code"] == "overage_too_large"


def test_runs_in_flight_share_the_absolute_overage_cap():
    from dataclasses import replace

    big = replace(_window(10_000, limit=48_000_000), in_flight=200_000)
    # 10k left − 200k already expected by running work → nothing left; a new
    # 300k run would be 300k past, at the cap; 300,001 is past it.
    assert guard.overage_refusal(big, 300_000, allow_wallet=False) is None
    assert guard.overage_refusal(big, 300_001, allow_wallet=False) is not None


async def test_a_run_too_big_for_the_whole_window_is_refused_up_front(captured, monkeypatch):
    """The one pre-flight quota check left: not "is there enough left" but
    "could this ever fit".

    No production plan can reach it any more — every plan's footage cap now
    prices below its own largest window (tests/test_plan_features.py
    ``test_the_longest_footage_each_plan_allows_can_actually_be_started``),
    which is the point of the table. So the budget is shrunk here rather than
    the footage stretched: this test is about the guard, not about the table.
    """
    from dataclasses import replace

    monkeypatch.setitem(
        limits.PLAN_LIMITS, "free", replace(limits.PLAN_LIMITS["free"], monthly=1_000)
    )
    uid_user = await make_user(email("start"), plan="free")
    token = await user_token(uid_user)
    async with client() as c:
        project = await _project(c, token, 30)
        try:
            refused = await _analyze(c, token, project, seconds=30)
            stored = (data_root() / "video_outputs" / project / "proxy").exists()
            status = (await c.get(f"/videos/{project}", headers=bearer(token))).json()["status"]
        finally:
            _cleanup(project)
    assert refused.status_code == 422, refused.text
    detail = refused.json()["detail"]
    assert detail["code"] == "run_too_large" and detail["window"] == "lifetime"
    assert not any("token" in k for k in detail)
    assert not stored and status == "pending" and captured == []
    assert await _open_runs(uid_user) == []


async def test_high_precision_is_refused_before_a_free_project_exists(captured):
    """Free and Lite are Standard only (packages/billing/limits.py): the tier
    is refused where it is chosen, so no project is created carrying a tier it
    could never afford to run, and no vendor is named in the message."""
    uid_user = await make_user(email("start"), plan="free")
    token = await user_token(uid_user)
    async with client() as c:
        r = await c.post(
            "/videos/local",
            json={"mode": "dub_first", "clips": [{"id": "c1", "durationSec": 30}],
                  "engine": "pro", "precision": "high"},
            headers=bearer(token),
        )
    assert r.status_code == 403, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "plan_feature" and detail["feature"] == "high_precision"
    assert "Pro" in detail["message"] and "uid" not in r.json()
    assert not any(v in detail["message"].lower() for v in ("gemini", "claude", "elevenlabs"))
    assert await db("SELECT count(*) FROM core.ai_runs WHERE user_id = :u", u=uid_user) == [(0,)]


async def test_a_started_project_cannot_be_switched_to_a_tier_the_plan_lacks(captured):
    """The tier can also arrive on the start route (a re-analyze sends it), and
    a plan downgrade can leave "high" sitting in the row — so the EFFECTIVE
    tier is checked there too, before anything is written."""
    uid_user = await make_user(email("start"), plan="free")
    token = await user_token(uid_user)
    async with client() as c:
        project = await _project(c, token, 30)
        try:
            refused = await _analyze(c, token, project, seconds=30, precision="high")
            # Refused before the row was touched: Standard still starts.
            ok = await _analyze(c, token, project, seconds=30)
        finally:
            _cleanup(project)
    assert refused.status_code == 403 and refused.json()["detail"]["code"] == "plan_feature"
    assert ok.status_code == 202, ok.text


async def test_footage_longer_than_one_request_is_refused_by_precision(captured):
    """1 hour fits a Standard request but not a High one (1.08 M tokens past
    a 1 M context) — the cap follows ความละเอียด, and the message says so.

    Every plan now caps footage at 30 minutes or less, so the plan's own cap
    is always the tighter of the two and this branch is only reachable by an
    account with no plan cap at all. It still has to work there: a context
    ceiling is physics, not a plan rule (limits.video_call_footage_sec).
    """
    from packages.billing import plan_features

    user = SimpleNamespace(plan="max", is_admin=True)
    assert plan_features.check_footage(user, 3_000, mode="dub_first", precision="standard") is None
    refusal = plan_features.check_footage(user, 3_000, mode="dub_first", precision="high")
    assert refusal is not None and refusal["by_precision"] is True
    assert refusal["limit_sec"] == limits.video_call_footage_sec("high") == 2_666
    assert "Standard" in refusal["message"]
    # An hour is the owner's cap at Standard; the context ceiling is higher.
    assert limits.video_call_footage_sec("standard") == 3_600
    # A speech mode sends audio per clip, not one video request: no such cap.
    assert plan_features.check_footage(user, 3_000, mode="talking_head", precision="high") is None
    # And on a real plan the 30-minute cap is what binds first.
    on_plan = SimpleNamespace(plan="max", is_admin=False)
    plan_cap = plan_features.check_footage(on_plan, 3_000, mode="dub_first", precision="high")
    assert plan_cap["limit_sec"] == limits.plan_limits("max").footage_sec
    assert plan_cap["by_precision"] is False


async def test_a_failed_enqueue_closes_the_run_row(monkeypatch, captured):
    async def broken(*a, **k):
        raise HTTPException(503, "Redis unavailable")

    monkeypatch.setattr(videos_local, "_enqueue", broken)
    uid_user = await make_user(email("start"), plan="lite")
    token = await user_token(uid_user)
    async with client() as c:
        project = await _project(c, token, 30)
        try:
            r = await _analyze(c, token, project)
        finally:
            _cleanup(project)
    assert r.status_code == 503
    assert [(k, s) for k, s, *_ in await _open_runs(uid_user)] == [("analyze_video", "released")]
    acct = await db("SELECT reserved_tokens FROM core.usage_accounts WHERE user_id = :u", u=uid_user)
    assert acct[0][0] == 0


async def test_the_circuit_breaker_and_the_free_tier_refuse_at_start(monkeypatch, captured):
    uid_user = await make_user(email("start"), plan="free")
    admin_user = await make_user(email("start"), plan="free", admin=True)
    token, admin_token = await user_token(uid_user), await user_token(admin_user)

    async def limited(**kw):
        raise free_tier.FreeTierLimited("ip_accounts")

    async with client() as c:
        project = await _project(c, token, 10)
        admin_project = await _project(c, admin_token, 10)
        try:
            monkeypatch.setattr(guard, "breaker_open", lambda: _true())
            paused = await _analyze(c, token, project)
            admin_ok = await _analyze(c, admin_token, admin_project)  # never blocked
            monkeypatch.setattr(guard, "breaker_open", lambda: _false())
            monkeypatch.setattr(free_tier, "check_start", limited)
            free = await _analyze(c, token, project)
        finally:
            _cleanup(project)
            _cleanup(admin_project)
    assert paused.status_code == 503 and paused.json()["detail"]["code"] == "service_paused"
    assert admin_ok.status_code == 202
    assert free.status_code == 429 and free.json()["detail"]["code"] == "free_tier_limited"


async def test_consenting_to_the_wallet_records_what_the_run_may_spend(captured):
    """``allow_wallet`` no longer holds baht — it records how much of the
    balance the run may take once its windows are full. The account's own
    money stays spendable while the run works."""
    from packages.billing import wallet as wallet_mod
    from packages.db.session import get_sessionmaker

    uid_user = await make_user(email("start"), plan="free")
    async with get_sessionmaker()() as s:
        from sqlalchemy import text

        await s.execute(text("SET search_path TO core, public"))
        await wallet_mod.credit(s, uid_user, 100_000, source="mock")
        await s.commit()
    await db(
        "INSERT INTO core.usage_accounts (user_id, monthly_started_at, monthly_used, reserved_tokens) "
        "VALUES (:u, now(), :m, 0) ON CONFLICT (user_id) DO UPDATE SET monthly_used = :m, "
        "monthly_started_at = now()",
        u=uid_user, m=limits.window_limit("free", "monthly"),
    )
    token = await user_token(uid_user)
    async with client() as c:
        # A separate project each: a started one is `processing` and the
        # route rightly refuses to start it twice.
        first, second = await _project(c, token, 60), await _project(c, token, 60)
        try:
            plain = await _analyze(c, token, first, seconds=60)
            allowed = await _analyze(c, token, second, seconds=60, allow_wallet="true")
        finally:
            _cleanup(first)
            _cleanup(second)
    assert plain.status_code == 202 and allowed.status_code == 202
    rows = await db(
        "SELECT reserved_wallet_satang FROM core.ai_runs WHERE user_id = :u ORDER BY created_at", u=uid_user
    )
    assert [r[0] for r in rows] == [0, 100_000]
    held = await db("SELECT wallet_reserved_satang FROM core.usage_accounts WHERE user_id = :u", u=uid_user)
    assert held[0][0] == 0  # nothing is held: the balance stays spendable


async def _true() -> bool:
    return True


async def _false() -> bool:
    return False


# ── pricing is on what the SERVER measured (2026-09-22 billing review) ───────

async def _run_rows(user_id: int) -> list[tuple]:
    return [tuple(r) for r in await db(
        "SELECT kind, media_sec, estimate_tokens FROM core.ai_runs WHERE user_id = :u ORDER BY created_at",
        u=user_id,
    )]


async def test_analyze_video_prices_the_measured_proxy_not_the_stated_length(captured):
    """Declared 1 s at creation and in the manifest; the proxy is 120 s. The
    reservation, the run's media_sec (what the per-call guard prices) and
    the stored manifest all follow the measured file."""
    from packages.billing import estimate

    uid_user = await make_user(email("start"), plan="pro")
    token = await user_token(uid_user)
    async with client() as c:
        project = await _project(c, token, 1)
        try:
            r = await _analyze(c, token, project, seconds=120, declared=1)
            proxy_dir = data_root() / "video_outputs" / project / "proxy"
            stored = json.loads((proxy_dir / "proxy_manifest.json").read_text(encoding="utf-8"))
            leftovers = [p.name for p in (data_root() / "video_outputs" / project).glob(".incoming*")]
        finally:
            _cleanup(project)
    assert r.status_code == 202, r.text
    [(kind, media_sec, estimate_tokens)] = await _run_rows(uid_user)
    expected = estimate.estimate_run(kind="analyze_video", engine="lite", clip_secs=[120.0])
    assert kind == "analyze_video" and abs(media_sec - 120) < 0.5
    assert abs(estimate_tokens - expected.tokens) < 200  # ± the probe's sub-second rounding
    assert stored[0]["file"] == "proxy_000.mp4" and abs(stored[0]["measuredSec"] - 120) < 0.5
    assert leftovers == []


async def test_an_unmeasurable_or_oversized_proxy_is_refused_before_reserving(captured):
    uid_user = await make_user(email("start"), plan="pro")
    token = await user_token(uid_user)
    async with client() as c:
        project = await _project(c, token, 10)
        try:
            junk = await _analyze(c, token, project, body=b"not really a video")
            big = await _analyze(c, token, project, body=video_bytes(2, 1280, 720))
            leftovers = list((data_root() / "video_outputs" / project).glob(".incoming*"))
        finally:
            _cleanup(project)
    assert junk.status_code == 422 and big.status_code == 422
    assert leftovers == [] and captured == []
    assert await _open_runs(uid_user) == []


@pytest.mark.parametrize("name", ["../../x.mp4", "..\\x.mp4", "/etc/x.mp4", "C:x.mp4", ".hidden.mp4"])
async def test_a_client_file_name_is_never_a_path(captured, name):
    uid_user = await make_user(email("start"), plan="pro")
    token = await user_token(uid_user)
    async with client() as c:
        project = await _project(c, token, 10)
        try:
            r = await _analyze(c, token, project, name=name)
        finally:
            _cleanup(project)
    assert r.status_code == 422
    assert captured == []


async def _reedit(c, token: str, uid: str, *, proxy_name: str, proxy_sec: float, preview_sec: float):
    return await c.post(
        f"/videos/{uid}/reedit-dub-scenes",
        data={
            "manifest": json.dumps({"instruction": "tighter"}),
            "proxy_manifest": json.dumps([{"clip_id": "c1", "file": proxy_name, "durationSec": 1}]),
        },
        files=[
            ("preview", ("preview.mp4", video_bytes(preview_sec), "video/mp4")),
            ("proxies", (proxy_name, video_bytes(proxy_sec), "video/mp4")),
        ],
        headers=bearer(token),
    )


async def _update_project(user_id: int, uid: str, sets: str, **params) -> None:
    """Every tenant's projects live in the shared schema (packages/db/tenancy.py)."""
    from packages.db.tenancy import SHARED_DATA_SCHEMA

    await db(
        f'UPDATE "{SHARED_DATA_SCHEMA}".video_projects SET {sets} WHERE uid = :uid AND user_id = :user_id',
        uid=uid, user_id=user_id, **params,
    )


async def _with_edit_script(user_id: int, uid: str) -> None:
    out = data_root() / "video_outputs" / uid
    out.mkdir(parents=True, exist_ok=True)
    (out / "edit_script.json").write_text('{"segments": []}', encoding="utf-8")
    await _update_project(user_id, uid, "edit_script_path = :p", p=f"video_outputs/{uid}/edit_script.json")


async def test_reedit_writes_proxies_under_server_names_and_prices_the_preview_too(captured):
    """The path-traversal fix (a proxy_manifest `file` of `../../…` used to be
    written wherever it pointed) and the preview being priced with the proxies."""
    from packages.billing import estimate

    uid_user = await make_user(email("start"), plan="pro")
    token = await user_token(uid_user)
    async with client() as c:
        project = await _project(c, token, 1)
        await _with_edit_script(uid_user, project)
        try:
            evil = await _reedit(c, token, project, proxy_name="../../../escape.mp4", proxy_sec=5, preview_sec=5)
            ok = await _reedit(c, token, project, proxy_name="clip-a.mp4", proxy_sec=60, preview_sec=30)
            proxy_dir = data_root() / "video_outputs" / project / "proxy"
            files = sorted(p.name for p in proxy_dir.iterdir())
            preview = (data_root() / "video_outputs" / project / "ai_reedit" / "edited_preview.mp4").is_file()
        finally:
            _cleanup(project)
    assert evil.status_code == 422
    assert not (data_root() / "escape.mp4").exists()
    assert ok.status_code == 202, ok.text
    assert files == ["proxy_000.mp4", "proxy_manifest.json"] and preview
    [(kind, media_sec, estimate_tokens)] = await _run_rows(uid_user)
    expected = estimate.estimate_run(kind="reedit", precision="standard", clip_secs=[60.0, 30.0])
    assert kind == "reedit" and abs(media_sec - 90) < 1 and abs(estimate_tokens - expected.tokens) < 300


async def test_plan_effects_prices_the_reference_and_caps_its_length(captured, monkeypatch):
    uid_user = await make_user(email("start"), plan="pro")
    token = await user_token(uid_user)

    async def post(ref_sec: float):
        return await c.post(
            f"/videos/{project}/plan-effects",
            files=[
                ("proxy", ("cut.mp4", video_bytes(20), "video/mp4")),
                ("reference", ("ref.mp4", video_bytes(ref_sec), "video/mp4")),
            ],
            headers=bearer(token),
        )

    monkeypatch.setenv("REFERENCE_MAX_SEC", "60")
    get_settings.cache_clear()
    async with client() as c:
        project = await _project(c, token, 1)
        await _update_project(uid_user, project, "status = 'done'")
        try:
            too_long = await post(90)
            ok = await post(40)
        finally:
            _cleanup(project)
    assert too_long.status_code == 422
    assert ok.status_code == 202, ok.text
    [(kind, media_sec, _)] = await _run_rows(uid_user)
    assert kind == "plan_effects" and abs(media_sec - 60) < 1  # cut 20 s + reference 40 s


async def test_transcribe_audio_prices_the_measured_wavs(captured):
    uid_user = await make_user(email("start"), plan="pro")
    token = await user_token(uid_user)
    async with client() as c:
        r = await c.post(
            "/videos/local",
            json={"mode": "talking_head", "clips": [{"id": "c1", "durationSec": 1}]},
            headers=bearer(token),
        )
        project = r.json()["uid"]
        try:
            r = await c.post(
                f"/videos/{project}/transcribe-audio",
                files=[("files", ("audio_000.wav", wav_bytes(45), "audio/wav"))],
                headers=bearer(token),
            )
            audio = sorted(p.name for p in (data_root() / "video_outputs" / project / "audio").iterdir())
        finally:
            _cleanup(project)
    assert r.status_code == 202, r.text
    assert audio == ["audio_000.wav"]
    [(kind, media_sec, _)] = await _run_rows(uid_user)
    # The MODE decides the kind on this route: talking_head is speech-to-text
    # with no model call behind it (estimate.py KIND_FOR_MODE).
    assert kind == "transcribe_only" and abs(media_sec - 45) < 0.5


async def test_a_refused_free_start_does_not_spend_the_networks_daily_runs(captured, monkeypatch):
    """A start refused on the request's own shape must not count against the
    IP's free runs (every free account behind the same NAT shares them)."""
    monkeypatch.setenv("FREE_RUNS_PER_IP_DAY", "2")
    get_settings.cache_clear()
    blocked = await make_user(email("start"), plan="free")
    other = await make_user(email("start"), plan="free")
    t_blocked, t_other = await user_token(blocked), await user_token(other)
    over_cap = limits.plan_limits("free").footage_sec + 30
    async with client() as c:
        # Declares a legal length, then uploads more footage than the plan's
        # cap: the start measures the file and refuses → 422, every time.
        p1 = await _project(c, t_blocked, 30)
        mine = [await _project(c, t_other, 10) for _ in range(3)]  # one start each
        try:
            refused = [
                (await _analyze(c, t_blocked, p1, seconds=over_cap)).status_code for _ in range(3)
            ]
            fine = [(await _analyze(c, t_other, p)).status_code for p in mine[:2]]
            third = await _analyze(c, t_other, mine[2])
        finally:
            for p in (p1, *mine):
                _cleanup(p)
    assert refused == [422, 422, 422]
    assert fine == [202, 202]
    assert third.status_code == 429 and third.json()["detail"]["code"] == "free_tier_limited"


async def test_a_style_reference_that_cannot_be_measured_or_is_too_long_is_refused(captured, monkeypatch):
    """It used to count as 0 s when unreadable (a Pro video call priced as
    text) and only cut styles had a length cap."""
    monkeypatch.setenv("REFERENCE_MAX_SEC", "5")
    get_settings.cache_clear()
    uid_user = await make_user(email("start"), plan="pro")
    token = await user_token(uid_user)
    async with client() as c:
        junk = await c.post(
            "/effect-styles", data={"name": "x", "kind": "effects"},
            files=[("reference", ("r.webm", b"not media", "video/webm"))], headers=bearer(token),
        )
        long = await c.post(
            "/effect-styles", data={"name": "x", "kind": "cut"},
            files=[("reference", ("r.mp4", video_bytes(10), "video/mp4"))], headers=bearer(token),
        )
    assert junk.status_code == 422 and long.status_code == 400
    assert await _open_runs(uid_user) == []


# ── the synchronous /plan-dub takes a concurrency slot (security 2026-09-30) ──

async def _plan_ready_project(c, token: str, user_id: int) -> str:
    project = await _project(c, token, 10)
    out = data_root() / "video_outputs" / project
    out.mkdir(parents=True, exist_ok=True)
    (out / "edit_script.json").write_text(json.dumps({"segments": []}), encoding="utf-8")
    # Every account's projects live in tenant "default" (services/api/deps.py).
    await db(
        'UPDATE "tenant_default".video_projects SET edit_script_path = :p WHERE uid = :uid',
        p=f"video_outputs/{project}/edit_script.json", uid=project,
    )
    return project


async def test_parallel_plan_dub_calls_do_not_share_one_quota_snapshot(captured, monkeypatch):
    """N parallel POSTs each ran against the same quota snapshot (none took
    the plan's concurrency slot), so together they overspent the window. The
    second call while the first holds the slot is refused and its run released."""
    import asyncio

    from packages.video import dub_ai

    gate = asyncio.Event()
    entered = asyncio.Event()
    calls = 0

    async def slow_plan(*_a, **_k):
        nonlocal calls
        calls += 1
        entered.set()
        await gate.wait()
        return []

    monkeypatch.setattr(dub_ai, "plan_dub_timeline_cuts", slow_plan)
    uid_user = await make_user(email("plandub"), plan="free")
    token = await user_token(uid_user)
    body = {"voDurationSec": 10, "clipDurations": [10]}
    async with client() as c:
        project = await _plan_ready_project(c, token, uid_user)
        try:
            first = asyncio.create_task(c.post(f"/videos/{project}/plan-dub", json=body, headers=bearer(token)))
            await asyncio.wait_for(entered.wait(), 10)
            # Bounded: without the slot the second call reaches the model and
            # would wait on the gate forever.
            try:
                second = await asyncio.wait_for(
                    c.post(f"/videos/{project}/plan-dub", json=body, headers=bearer(token)), 10
                )
            finally:
                gate.set()
            first_r = await first
        finally:
            gate.set()
            _cleanup(project)
    assert second.status_code == 429, second.text
    assert second.json()["detail"]["code"] == "busy"
    assert first_r.status_code == 200, first_r.text
    assert calls == 1
    statuses = sorted(s for (s,) in await db("SELECT status FROM core.ai_runs WHERE user_id = :u", u=uid_user))
    assert "released" in statuses and "running" not in statuses and "queued" not in statuses


async def test_free_runs_are_claimed_atomically_with_the_daily_cap(monkeypatch):
    """check-then-count let a burst all read the same count; claim_run
    increments first and gives back what went over."""
    import asyncio

    monkeypatch.setenv("FREE_RUNS_PER_IP_DAY", "2")
    get_settings.cache_clear()
    monkeypatch.setattr(free_tier, "_store", free_tier.MemoryFreeTierStore())
    results = await asyncio.gather(
        *(free_tier.claim_run(user_id=i, ip="203.0.113.50", device=None) for i in range(5)),
        return_exceptions=True,
    )
    admitted = [r for r in results if r is None]
    assert len(admitted) == 2
    assert all(isinstance(r, free_tier.FreeTierLimited) for r in results if r is not None)
    # The refused hits were given back: today's count is exactly the cap.
    key = free_tier._runs_key("ip", free_tier.identity_hash("203.0.113.50"))
    assert free_tier._store.counts[key] == 2
    await free_tier.unclaim_run(ip="203.0.113.50", device=None)
    await free_tier.claim_run(user_id=9, ip="203.0.113.50", device=None)
