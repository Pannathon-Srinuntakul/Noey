"""The plan features the website promises (docs/token-billing-plan.md §8) and
the editor's plan switch (docs/design/editor-limits.md §5–6)."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from packages.billing import limits, plan_features, plan_switch
from packages.core.settings import get_settings
from services.api.routers.videos import queue_priority_kwargs
from tests.admin_helpers import (  # noqa: F401
    _admin_env,
    bearer,
    client,
    db,
    email,
    make_user,
    user_token,
)


def _user(plan: str = "free", admin: bool = False) -> SimpleNamespace:
    return SimpleNamespace(id=1, plan=plan, is_admin=admin)


# ── the table matches the website ─────────────────────────────────────────────

def test_the_table_is_what_the_pricing_page_promises():
    rows = {k: limits.PLAN_LIMITS[k] for k in ("free", "lite", "starter", "pro", "studio", "agency", "max")}
    assert [r.footage_sec for r in rows.values()] == [600, 600, 1200, 1800, 1800, 1800, 1800]
    assert [r.max_projects for r in rows.values()] == [3, 10, 20, None, None, None, None]
    assert [r.storage_gb for r in rows.values()] == [1, 3, 5, 10, 30, 60, 100]
    assert [r.music for r in rows.values()] == [False, True, True, True, True, True, True]
    assert [r.transcode for r in rows.values()] == [False, False, True, True, True, True, True]
    # High ความละเอียด: Pro and up — it is 5.2x Standard per second of footage.
    assert [r.high_precision for r in rows.values()] == [False, False, False, True, True, True, True]
    # What the pricing page prints: whole 5-minute clips, rounded down, at
    # BOTH precisions where the plan has High (owner, 2026-10-01).
    assert [limits.plan_cuts(k) for k in rows] == [2, 4, 10, 30, 64, 140, 259]
    assert [limits.plan_cuts_high(k) for k in rows] == [None, None, None, 20, 44, 97, 179]
    leads = [r.queue_lead_sec for r in rows.values()]
    assert leads[:3] == [0, 0, 0] and 0 < leads[3] < leads[4] == leads[5] == leads[6]


#: The owner's volume-discount table (2026-10-01): monthly budget in rate-card
#: tokens, full and beta price in baht, and the full-price margin he signed off.
_LADDER = {
    #          budget      full  beta  margin at full price
    "lite":    (800_000,     199,   99, 0.705),
    "starter": (2_000_000,   399,  199, 0.681),
    "pro":     (5_600_000,   990,  499, 0.664),
    "studio":  (12_000_000, 1990,  999, 0.650),
    "agency":  (26_000_000, 3990, 1999, 0.628),
    "max":     (48_000_000, 6990, 3499, 0.612),
}


def _margin(price_thb: float, tokens: int) -> float:
    """Gross margin at full burn: Stripe card 3.65 % + ฿10, Stripe Billing
    0.7 %, and ฿50 per 1M rate-card tokens at the 2027 vendor prices."""
    return (price_thb - 0.0435 * price_thb - 10 - tokens * 50 / 1_000_000) / price_thb


def test_budgets_are_the_volume_discount_the_owner_signed_off():
    """Prices never moved; budgets rose, more steeply up the ladder. Every row
    must land on the margin the owner approved, never under the 60 % floor
    at full price, and each step up must buy tokens more cheaply."""
    last_price_per_1m = float("inf")
    last_margin = 1.0
    for plan, (budget, full, _beta, approved) in _LADDER.items():
        assert limits.PLAN_LIMITS[plan].monthly == budget, plan
        margin = _margin(full, budget)
        assert round(margin, 3) == approved, (plan, margin)
        assert margin >= 0.60, plan
        assert margin < last_margin, plan  # a volume discount: it steps DOWN
        price_per_1m = full / (budget / 1_000_000)
        assert price_per_1m < last_price_per_1m, plan
        last_margin, last_price_per_1m = margin, price_per_1m
    # Free is untouched: a 450 k credit, spent once.
    assert limits.PLAN_LIMITS["free"].monthly == 450_000


def test_beta_margins_are_thinner_but_never_a_loss():
    """While the beta ladder runs the same budgets earn ~27–45 % at full burn
    (docs/unit-economics.md §4) — thin, and stated, but still positive."""
    beta = {plan: _margin(row[2], row[0]) for plan, row in _LADDER.items()}
    assert 0.26 < min(beta.values()) and max(beta.values()) < 0.46
    assert round(beta["lite"], 3) == 0.451 and round(beta["max"], 3) == 0.268


def test_quoted_counts_come_from_the_fitted_cut_model():
    """5-minute cut = per-second rate × 300 + 125,390 fixed + 40,000 voiceover."""
    assert limits.cut_tokens(300, "standard") == 185_070 == limits.TYPICAL_CUT_TOKENS
    assert limits.cut_tokens(300, "high") == 267_420 == limits.TYPICAL_HIGH_CUT_TOKENS
    for plan in ("free", "lite", "starter", "pro", "studio", "agency", "max"):
        budget = limits.PLAN_LIMITS[plan].monthly
        assert limits.plan_cuts(plan) == budget // 185_070, plan
        if limits.PLAN_LIMITS[plan].high_precision:
            assert limits.plan_cuts_high(plan) == budget // 267_420, plan


def test_footage_cap_with_a_small_tolerance():
    free_cap = limits.plan_limits("free").footage_sec
    assert plan_features.check_footage(_user("free"), free_cap) is None
    assert plan_features.check_footage(_user("free"), free_cap + 4) is None
    refusal = plan_features.check_footage(_user("starter"), 24 * 60)
    assert refusal["code"] == "footage_over_limit" and refusal["limit_sec"] == 1200
    assert "24 นาที" in refusal["message"] and "20 นาที" in refusal["message"]
    assert plan_features.check_footage(_user("pro"), limits.plan_limits("pro").footage_sec) is None
    assert plan_features.check_footage(_user("free", admin=True), 10 * 3600) is None
    assert plan_features.check_footage(_user("enterprise"), 10 * 3600) is None


def test_the_video_call_cap_is_derived_from_the_two_real_constants():
    """1 hour is the owner's cap (2026-09-26), but an hour at High prices
    3600 × 300 = 1.08 M tokens — past the model's 1 M input context. One
    number cannot be right for both, so the cap is computed, not typed in."""
    ceiling = limits.MODEL_INPUT_CONTEXT_TOKENS * limits.FOOTAGE_CONTEXT_SHARE
    assert limits.footage_context_ceiling_sec("high") == int(ceiling // 300)
    assert limits.footage_context_ceiling_sec("standard") == int(ceiling // 100)
    # Standard: the owner's hour binds. High: the context does, ~44 min.
    assert limits.video_call_footage_sec("standard") == 3_600
    assert 40 * 60 <= limits.video_call_footage_sec("high") <= 45 * 60
    # An hour at High would have been 1.08 M tokens — above the context.
    assert 3_600 * 300 > limits.MODEL_INPUT_CONTEXT_TOKENS


def test_the_video_call_cap_applies_to_the_video_modes_only():
    pro = _user("pro")
    cap = limits.plan_limits("pro").footage_sec
    assert plan_features.check_footage(pro, cap, mode="dub_first", precision="high") is None
    # Speech modes send audio per clip: only the plan's own cap applies.
    assert plan_features.check_footage(pro, cap, mode="talking_head", precision="high") is None
    # The plan cap wins when it is the tighter of the two, and its message
    # points at the plan rather than at ความละเอียด.
    over = plan_features.check_footage(pro, cap + 600, mode="dub_first", precision="standard")
    assert over["code"] == "footage_over_limit" and over["limit_sec"] == cap
    assert over["by_precision"] is False and "แผนนี้" in over["message"]
    lite = plan_features.check_footage(_user("lite"), 1_200, mode="dub_first", precision="standard")
    assert lite["limit_sec"] == limits.plan_limits("lite").footage_sec and lite["by_precision"] is False
    # Now that every plan caps footage at 30 minutes or less, the CONTEXT
    # ceiling is only reachable by an account with no plan cap at all — and it
    # binds there, because no plan can make a request fit a context it does
    # not fit. That branch is what tells the user to drop ความละเอียด.
    admin = _user("free", admin=True)
    tight = plan_features.check_footage(admin, 3_000, mode="dub_first", precision="high")
    assert tight["code"] == "footage_over_limit" and tight["by_precision"] is True
    assert "Standard" in tight["message"] and "1 ชั่วโมง" in tight["message"]
    assert plan_features.check_footage(admin, 3_000, mode="dub_first", precision="standard") is None


def test_a_run_too_big_for_every_window_is_refused_whatever_is_left():
    credit = limits.window_limit("free", "lifetime")
    assert plan_features.check_run_size(_user("free"), credit - 1) is None
    too_big = plan_features.check_run_size(_user("free"), credit + 1)
    assert too_big["code"] == "run_too_large" and too_big["window"] == "lifetime"
    # A one-time credit has no "รอบ" to be too big for — it is simply all of it.
    assert "เครดิตทดลองใช้ทั้งหมด" in too_big["message"]
    month = limits.window_limit("studio", "monthly")
    assert plan_features.check_run_size(_user("studio"), month) is None
    refused = plan_features.check_run_size(_user("studio"), month + 1)
    assert refused["code"] == "run_too_large" and refused["window"] == "monthly"
    assert "โควตารายเดือนทั้งรอบ" in refused["message"]
    # Only the BIGGEST window decides, so a plan that ever enforced two again
    # could still start a run one of them cannot hold.
    two = SimpleNamespace(id=1, plan="studio", is_admin=False)
    from dataclasses import replace as _replace
    old = limits.PLAN_LIMITS["studio"]
    limits.PLAN_LIMITS["studio"] = _replace(old, windows=("monthly", "weekly"))
    try:
        assert plan_features.check_run_size(two, limits.window_limit("studio", "weekly") + 1) is None
        assert plan_features.check_run_size(two, month + 1)["window"] == "monthly"
    finally:
        limits.PLAN_LIMITS["studio"] = old
    assert plan_features.check_run_size(_user("free", admin=True), 10**9) is None
    assert plan_features.check_run_size(_user("enterprise"), 10**9) is None


def test_the_longer_clip_and_the_finer_setting_both_buy_fewer_cuts():
    """A plan that says "30 นาที" and "30 คลิป" invites the wrong sum: 30 cuts
    is what five-minute sources buy, and thirty-minute ones buy 19. The cap
    count must always be the smaller — if it ever is not, the cap stopped
    costing anything and the claim is noise. Same for High: it must quote
    fewer than Standard, or the second number on the card is noise."""
    for plan in ("free", "lite", "starter", "pro", "studio", "agency", "max"):
        typical = limits.plan_cuts(plan)
        at_cap = limits.plan_cuts_at_cap(plan)
        assert at_cap >= 1, plan
        assert at_cap <= typical, plan
        high = limits.plan_cuts_high(plan)
        assert (high is None) == (not limits.plan_limits(plan).high_precision), plan
        assert high is None or 1 <= high < typical, plan
    # Free's cap IS about five minutes' worth of budget, so the two agree;
    # everywhere else the cap costs real cuts.
    assert limits.plan_cuts_at_cap("free") == limits.plan_cuts("free")
    assert limits.plan_cuts_at_cap("pro") < limits.plan_cuts("pro")


def test_every_advertised_cap_is_actually_runnable():
    """The bug this table was rewritten to fix: a plan that says 30 minutes
    while a 20-minute clip is refused.

    For every plan, the pre-flight estimate at that plan's own ``footage_sec``
    — at the best precision the plan may pick — must be strictly smaller than
    EVERY window the plan enforces. Then nothing a plan advertises can reach
    ``check_run_size`` at all.
    """
    from packages.billing import estimate

    priced = {}
    for plan in ("free", "lite", "starter", "pro", "studio", "agency", "max"):
        limit = limits.plan_limits(plan)
        precisions = ("standard", "high") if limit.high_precision else ("standard",)
        for precision in precisions:
            est = estimate.estimate_run(
                kind="analyze_video", engine="pro", precision=precision,
                clip_secs=[float(limit.footage_sec)],
            )
            for window in limit.windows:
                assert est.tokens < limits.window_limit(plan, window), (plan, precision, window)
            assert plan_features.check_run_size(_user(plan), est.tokens) is None, (plan, precision)
            assert plan_features.check_footage(
                _user(plan), limit.footage_sec, mode="dub_first", precision=precision
            ) is None, (plan, precision)
        priced[plan] = est.tokens  # the dearest precision the plan may pick
    # Pinned so a change to the estimator shows up here, not on a user's run.
    assert priced == {
        "free": 192_510, "lite": 192_510, "starter": 254_610,
        "pro": 689_310, "studio": 689_310, "agency": 689_310, "max": 689_310,
    }


def test_high_precision_is_refused_below_pro():
    """Free, Lite and Starter cannot pay for High — 5.2x Standard per second
    of footage (limits.py rule 2). Refused, never silently downgraded, like
    every other plan feature here."""
    for plan in ("free", "lite", "starter"):
        assert plan_features.check_precision(_user(plan), "standard") is None
        assert plan_features.check_precision(_user(plan), None) is None  # unset = Standard
        refusal = plan_features.check_precision(_user(plan), "high")
        assert refusal["code"] == "plan_feature" and refusal["feature"] == "high_precision"
        assert refusal["required_plan"] == "pro"
        assert "Pro" in refusal["message"] and "Standard" in refusal["message"]
        # No vendor is ever named to a user.
        assert not any(v in refusal["message"].lower() for v in ("gemini", "claude", "elevenlabs"))
    for plan in ("pro", "studio", "agency", "max"):
        assert plan_features.check_precision(_user(plan), "high") is None
    assert plan_features.check_precision(_user("free", admin=True), "high") is None
    assert plan_features.check_precision(_user("enterprise"), "high") is None
    # A junk value normalises to Standard exactly as the call site does.
    assert plan_features.check_precision(_user("free"), "HIGHER") is None


def test_the_features_payload_tells_a_client_both_caps():
    payload = plan_features.features_payload(_user("pro"))
    assert payload["footage_sec"] == limits.plan_limits("pro").footage_sec
    assert payload["video_call_footage_sec"] == {
        "standard": limits.video_call_footage_sec("standard"),
        "high": limits.video_call_footage_sec("high"),
    }
    assert payload["video_call_modes"] == sorted(limits.VIDEO_CALL_MODES)
    # Unlimited skips the plan cap but never the request one.
    assert plan_features.features_payload(_user("enterprise"))["footage_sec"] is None
    assert plan_features.features_payload(_user("enterprise"))["video_call_footage_sec"]["high"] > 0


def test_project_cap_counts_what_would_be_added():
    assert plan_features.check_new_project(_user("free"), 2) is None
    assert plan_features.check_new_project(_user("free"), 3)["code"] == "project_limit"
    assert plan_features.check_new_project(_user("free"), 1, adding=3)["limit"] == 3
    assert plan_features.check_new_project(_user("pro"), 5000) is None
    assert plan_features.check_new_project(_user("free", admin=True), 99) is None


def test_music_and_conversion_name_the_cheapest_plan_that_has_them():
    assert plan_features.minimum_plan("high_precision") == "pro"
    assert plan_features.features_payload(_user("starter"))["high_precision"] is False
    assert plan_features.features_payload(_user("pro"))["high_precision"] is True
    assert plan_features.features_payload(_user("enterprise"))["high_precision"] is True
    # The plan's advertised clip count travels with the features, in clips.
    assert plan_features.features_payload(_user("pro"))["approx_cuts"] == limits.plan_cuts("pro")
    assert plan_features.features_payload(_user("enterprise"))["approx_cuts"] is None
    # …and at High, only on the plans that can pick it.
    assert plan_features.features_payload(_user("pro"))["approx_cuts_high"] == 20
    assert plan_features.features_payload(_user("starter"))["approx_cuts_high"] is None
    assert plan_features.features_payload(_user("enterprise"))["approx_cuts_high"] is None
    assert plan_features.check_feature(_user("free"), "music")["required_plan"] == "lite"
    assert plan_features.check_feature(_user("lite"), "music") is None
    assert plan_features.check_feature(_user("lite"), "transcode")["required_plan"] == "starter"
    assert plan_features.check_feature(_user("starter"), "transcode") is None
    assert plan_features.check_feature(_user("free", admin=True), "transcode") is None


def test_queue_priority_scores_paid_tiers_ahead():
    assert queue_priority_kwargs(_user("starter")) == {}
    assert queue_priority_kwargs(None) == {}
    now = datetime.now(UTC)
    pro = queue_priority_kwargs(_user("pro"))["_defer_until"]
    studio = queue_priority_kwargs(_user("studio"))["_defer_until"]
    admin = queue_priority_kwargs(_user("free", admin=True))["_defer_until"]
    assert studio < pro < now and admin == pytest.approx(studio, abs=timedelta(seconds=2))


def test_prorate_is_rounded_up_and_full_price_from_free():
    now = datetime(2026, 9, 1, tzinfo=UTC)
    assert plan_switch.prorate_satang(0, 99_000, None, now, paid=False) == 99_000
    half = plan_switch.prorate_satang(39_900, 99_000, now + timedelta(days=15), now, paid=True)
    assert half == 29_600  # (990 − 399) × 0.5 = 295.5 → ฿296
    assert plan_switch.prorate_satang(99_000, 39_900, now + timedelta(days=15), now, paid=True) == 0


# ── the routes ───────────────────────────────────────────────────────────────

async def _new_project(c, token: str, seconds: float = 60):
    return await c.post(
        "/videos/local",
        json={"mode": "dub_first", "clips": [{"id": "c1", "durationSec": seconds}]},
        headers=bearer(token),
    )


async def test_free_footage_over_the_plan_cap_is_refused_before_upload():
    token = await user_token(await make_user(email("feat")))
    over = limits.plan_limits("free").footage_sec + 60
    async with client() as c:
        r = await _new_project(c, token, seconds=over)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "footage_over_limit"


async def test_free_keeps_three_projects_and_the_old_ones_stay_open():
    uid = await make_user(email("feat"))
    token = await user_token(uid)
    async with client() as c:
        uids = []
        for _ in range(3):
            r = await _new_project(c, token)
            assert r.status_code == 201, r.text
            uids.append(r.json()["uid"])
        r = await _new_project(c, token)
        assert r.status_code == 403 and r.json()["detail"]["code"] == "project_limit"
        # Past the cap (e.g. after a downgrade) nothing is removed or locked.
        await db("UPDATE core.users SET plan = 'free' WHERE id = :u", u=uid)
        r = await c.get(f"/videos/{uids[0]}", headers=bearer(token))
        assert r.status_code == 200
        me = (await c.get("/usage/me", headers=bearer(token))).json()
    assert me["projects"] == {"count": 3, "max": 3}
    assert me["features"]["music"] is False and me["features"]["transcode"] is False
    assert me["features"]["footage_sec"] == limits.plan_limits("free").footage_sec
    assert me["features"]["queue"] == "normal"
    assert me["features"]["high_precision"] is False


async def test_admin_accounts_have_no_plan_caps():
    uid = await make_user(email("feat"), admin=True)
    token = await user_token(uid)
    async with client() as c:
        for _ in range(4):
            # Well past every paid plan's footage cap and project count.
            r = await _new_project(c, token, seconds=3000)
            assert r.status_code == 201, r.text
        me = (await c.get("/usage/me", headers=bearer(token))).json()
    assert me["projects"]["max"] is None and me["features"]["footage_sec"] is None
    assert me["features"]["music"] and me["features"]["transcode"] and me["features"]["queue"] == "first"


async def test_even_an_admin_cannot_exceed_the_models_context():
    """The 1-hour cap is a product decision; the context ceiling is not.

    An unlimited account skips every PLAN rule, but a request whose footage
    prices above the model's input window cannot be answered by anyone — so
    that one limit still binds, and the refusal says the length, not the plan.
    """
    token = await user_token(await make_user(email("feat"), admin=True))
    async with client() as c:
        # 150 minutes at Standard is ~900k video tokens against a 1M context.
        r = await _new_project(c, token, seconds=9000)
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["code"] == "footage_over_limit" and detail["by_precision"] is True


async def test_music_needs_lite_and_conversion_needs_starter():
    free = await user_token(await make_user(email("feat")))
    lite = await user_token(await make_user(email("feat"), plan="lite"))
    async with client() as c:
        uid = (await _new_project(c, free)).json()["uid"]
        r = await c.post(
            f"/videos/{uid}/music", files={"file": ("m.mp3", b"x", "audio/mpeg")}, headers=bearer(free)
        )
        assert r.status_code == 403 and r.json()["detail"] == {
            **r.json()["detail"], "code": "plan_feature", "feature": "music", "required_plan": "lite",
        }
        r = await c.post(
            "/videos/transcode", files={"file": ("a.mov", b"x", "video/quicktime")}, headers=bearer(lite)
        )
        assert r.status_code == 403 and r.json()["detail"]["required_plan"] == "starter"


# ── plan switch ──────────────────────────────────────────────────────────────

@pytest.fixture
def mock_payments(monkeypatch):
    monkeypatch.setattr(get_settings(), "wallet_mock_topup", True)
    monkeypatch.setattr(get_settings(), "postgres_host", "localhost")


async def test_plan_switch_needs_consent_for_a_paid_plan(mock_payments):
    token = await user_token(await make_user(email("sw")))
    async with client() as c:
        r = await c.post("/billing/plan-switch", json={"tier": "pro"}, headers=bearer(token))
    assert r.status_code == 422


async def test_preview_then_upgrade_applies_at_once_in_mock_mode(mock_payments):
    uid = await make_user(email("sw"))
    token = await user_token(uid)
    async with client() as c:
        p = (await c.post("/billing/plan-preview", json={"tier": "pro"}, headers=bearer(token))).json()
        assert p["direction"] == "upgrade" and p["mode"] == "mock"
        assert p["due_now_satang"] == p["next_price_satang"] == 99_000
        r = await c.post("/billing/plan-switch", json={"tier": "pro", "consent": True}, headers=bearer(token))
        assert r.status_code == 200 and r.json()["applied"] is True and r.json()["url"] is None
    assert (await db("SELECT plan FROM core.users WHERE id = :u", u=uid))[0][0] == "pro"


async def test_downgrade_is_scheduled_for_the_period_end(mock_payments):
    uid = await make_user(email("sw"), plan="studio")
    token = await user_token(uid)
    async with client() as c:
        p = (await c.post("/billing/plan-preview", json={"tier": "starter"}, headers=bearer(token))).json()
        assert p["direction"] == "downgrade" and p["due_now_satang"] == 0
        r = await c.post("/billing/plan-switch", json={"tier": "starter", "consent": True}, headers=bearer(token))
        assert r.status_code == 200 and r.json()["applied"] is True
        me = (await c.get("/usage/me", headers=bearer(token))).json()
    assert (await db("SELECT plan FROM core.users WHERE id = :u", u=uid))[0][0] == "studio"
    assert me["pending_plan"]["plan"] == "starter"


async def test_without_payments_a_real_deployment_refuses(monkeypatch):
    monkeypatch.setattr(get_settings(), "wallet_mock_topup", False)
    token = await user_token(await make_user(email("sw")))
    async with client() as c:
        p = (await c.post("/billing/plan-preview", json={"tier": "pro"}, headers=bearer(token))).json()
        assert p["mode"] == "unavailable"
        r = await c.post("/billing/plan-switch", json={"tier": "pro", "consent": True}, headers=bearer(token))
    assert r.status_code == 503


async def test_measured_footage_is_checked_again_at_start(monkeypatch):
    """The declared length is only an early refusal: a start route measures the
    uploaded media itself and refuses footage over the cap (billing_start)."""
    import shutil

    from packages.video.storage import data_root
    from tests.media_helpers import wav_bytes

    monkeypatch.setenv("REQUIRE_VERIFIED_EMAIL_FOR_AI", "false")
    token = await user_token(await make_user(email("feat")))
    over_cap = limits.plan_limits("free").footage_sec + 60
    async with client() as c:
        r = await c.post(
            "/videos/local",
            json={"mode": "talking_head", "clips": [{"id": "c1", "durationSec": 60}]},
            headers=bearer(token),
        )
        uid = r.json()["uid"]
        try:
            r = await c.post(
                f"/videos/{uid}/transcribe-audio",
                files=[("files", ("audio_000.wav", wav_bytes(over_cap), "audio/wav"))],
                headers=bearer(token),
            )
        finally:
            shutil.rmtree(data_root() / "video_outputs" / uid, ignore_errors=True)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "footage_over_limit"


# ── storage meter must not stall a page (2026-09-22) ─────────────────────────


async def test_storage_display_falls_back_to_last_value_when_the_walk_is_slow(monkeypatch):
    import asyncio

    from services.api.routers import videos_local as vl

    class _Rows:
        def scalars(self):
            return self

        def all(self):
            return ["p1", "p2"]

    class _Session:
        async def execute(self, _stmt):
            return _Rows()

    async def slow_files(_uid):
        await asyncio.sleep(0.5)
        return {"a.mp4": 100}

    monkeypatch.setattr(vl, "_project_files", slow_files)
    vl._USED_CACHE.pop(4242, None)
    vl._USED_LAST[4242] = (7, 1)
    got = await vl.storage_used_for_display(_Session(), 4242, wait_sec=0.05)
    assert got == (7, 1)  # last known value, no waiting on the walk
    await asyncio.sleep(0.7)  # the walk finishes in the background …
    assert vl._USED_LAST[4242] == (200, 2)  # … and both projects were measured concurrently
    vl._USED_CACHE.pop(4242, None)
    vl._USED_LAST.pop(4242, None)
