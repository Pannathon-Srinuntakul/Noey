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


async def _project(c, token: str, seconds: float) -> str:
    r = await c.post(
        "/videos/local",
        json={"mode": "dub_first", "clips": [{"id": "c1", "durationSec": seconds}], "engine": "lite"},
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
    assert runs == [("analyze_video", "queued", runs[0][2], 0, f"vlocal_{project[:8]}")]
    held = await db("SELECT reserved_tokens FROM core.usage_accounts WHERE user_id = :u", u=uid_user)
    assert held == [] or held[0][0] == 0


async def test_a_used_up_window_no_longer_refuses_the_start(captured):
    """The estimate reserved more than a real run spends, so a used-up window
    refused work that would have fitted. The start goes ahead now; the run
    pauses mid-way if the quota really does run out."""
    uid_user = await make_user(email("start"), plan="free")
    token = await user_token(uid_user)
    await db(
        "INSERT INTO core.usage_accounts (user_id, monthly_started_at, monthly_used, reserved_tokens) "
        "VALUES (:u, now(), :m, 0)",
        u=uid_user, m=limits.window_limit("free", "monthly"),
    )
    async with client() as c:
        project = await _project(c, token, 10)
        try:
            r = await _analyze(c, token, project, seconds=60)
        finally:
            _cleanup(project)
    assert r.status_code == 202, r.text
    assert [(k, s) for k, s, *_ in await _open_runs(uid_user)] == [("analyze_video", "queued")]


async def test_a_run_too_big_for_the_whole_window_is_refused_up_front(captured):
    """The one pre-flight check left: not "is there enough left" but "could
    this ever fit". 5 minutes of footage at Precision high prices well past
    Free's whole monthly limit, so nothing would make it work."""
    uid_user = await make_user(email("start"), plan="free")
    token = await user_token(uid_user)
    async with client() as c:
        r = await c.post(
            "/videos/local",
            json={"mode": "dub_first", "clips": [{"id": "c1", "durationSec": 290}],
                  "engine": "pro", "precision": "high"},
            headers=bearer(token),
        )
        project = r.json()["uid"]
        try:
            refused = await _analyze(c, token, project, seconds=290)
            stored = (data_root() / "video_outputs" / project / "proxy").exists()
            status = (await c.get(f"/videos/{project}", headers=bearer(token))).json()["status"]
        finally:
            _cleanup(project)
    assert refused.status_code == 422, refused.text
    detail = refused.json()["detail"]
    assert detail["code"] == "run_too_large" and detail["window"] == "monthly"
    assert not any("token" in k for k in detail)
    assert not stored and status == "pending" and captured == []
    assert await _open_runs(uid_user) == []


async def test_footage_longer_than_one_request_is_refused_by_precision(captured):
    """1 hour fits a Standard request but not a High one (1.08 M tokens past
    a 1 M context) — the cap follows ความละเอียด, and the message says so."""
    from packages.billing import plan_features

    user = SimpleNamespace(plan="max", is_admin=False)
    assert plan_features.check_footage(user, 3_000, mode="dub_first", precision="standard") is None
    refusal = plan_features.check_footage(user, 3_000, mode="dub_first", precision="high")
    assert refusal is not None and refusal["by_precision"] is True
    assert refusal["limit_sec"] == limits.video_call_footage_sec("high") == 2_666
    assert "Standard" in refusal["message"]
    # An hour is the owner's cap at Standard; the context ceiling is higher.
    assert limits.video_call_footage_sec("standard") == 3_600
    # A speech mode sends audio per clip, not one video request: plan cap only.
    assert plan_features.check_footage(user, 3_000, mode="talking_head", precision="high") is None


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
    assert kind == "transcribe_audio" and abs(media_sec - 45) < 0.5


async def test_a_refused_free_start_does_not_spend_the_networks_daily_runs(captured, monkeypatch):
    """A start refused on the request's own shape must not count against the
    IP's free runs (every free account behind the same NAT shares them)."""
    monkeypatch.setenv("FREE_RUNS_PER_IP_DAY", "2")
    get_settings.cache_clear()
    blocked = await make_user(email("start"), plan="free")
    other = await make_user(email("start"), plan="free")
    t_blocked, t_other = await user_token(blocked), await user_token(other)
    async with client() as c:
        # Too big for Free's whole month however empty it is → 422, every time.
        r = await c.post(
            "/videos/local",
            json={"mode": "dub_first", "clips": [{"id": "c1", "durationSec": 290}],
                  "engine": "pro", "precision": "high"},
            headers=bearer(t_blocked),
        )
        p1 = r.json()["uid"]
        mine = [await _project(c, t_other, 10) for _ in range(3)]  # one start each
        try:
            refused = [(await _analyze(c, t_blocked, p1, seconds=290)).status_code for _ in range(3)]
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
