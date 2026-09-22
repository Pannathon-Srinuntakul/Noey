"""The server-side estimator and POST /usage/estimate (percentages, never tokens)."""

import math

import pytest

from packages.auth.tokens import encode_access
from packages.billing import estimate as est
from packages.billing import limits, rate_card
from packages.core.settings import get_settings
from services.api import ratelimit
from tests.admin_helpers import _admin_env, bearer, client, db, email, make_user  # noqa: F401


def test_video_formula_standard_and_high():
    lite = get_settings().dub_engine_lite
    std = est.estimate_run(mode="dub_first", engine="lite", precision="standard", clip_secs=[30, 30])
    high = est.estimate_run(mode="dub_first", engine="lite", precision="high", clip_secs=[30, 30])
    p = est.MODE_PROFILES["analyze_video"]
    assert std.kind == "analyze_video" and std.model == lite
    assert std.tokens == rate_card.tokens_for_llm(lite, 60 * 100 + p.prompt_in, 0, p.max_output)
    assert high.tokens == rate_card.tokens_for_llm(lite, 60 * 300 + p.prompt_in, 0, p.max_output)
    assert std.ceiling == math.ceil(std.tokens * 1.2)
    assert std.estimator_version == "e1" and std.rate_version == "v1"


def test_speech_modes_add_transcription_at_the_stt_rate():
    run = est.estimate_run(mode="talking_head", engine="pro", clip_secs=[120])
    p = est.MODE_PROFILES["transcribe_audio"]
    llm = rate_card.tokens_for_llm(run.model, p.prompt_in + math.ceil(15 * 120), 0, p.max_output) * p.calls
    assert run.kind == "transcribe_audio"
    assert run.tokens == llm + rate_card.tokens_for_stt(120)
    # A separate audio length overrides the clip total.
    shorter = est.estimate_run(mode="talking_head", engine="pro", clip_secs=[120], audio_sec=60)
    assert shorter.tokens < run.tokens


def test_frames_are_priced_per_image():
    run = est.estimate_run(kind="analyze_frames", engine="lite", clip_secs=[40])
    p = est.MODE_PROFILES["analyze_frames"]
    frames_in = est.frame_input_tokens([40])
    assert frames_in % est.FRAME_TOKENS == 0 and frames_in > 0
    assert run.tokens == rate_card.tokens_for_llm(run.model, p.prompt_in + frames_in, 0, p.max_output)


def test_effects_and_style_use_the_effects_model():
    fx = est.estimate_run(kind="plan_effects", precision="standard", clip_secs=[30])
    assert fx.model == get_settings().effects_vision_model


def test_longer_footage_never_costs_less():
    a = est.estimate_run(mode="highlight", engine="pro", clip_secs=[10])
    b = est.estimate_run(mode="highlight", engine="pro", clip_secs=[100])
    assert b.tokens > a.tokens


def test_every_ai_route_kind_has_a_profile():
    kinds = {"analyze_video", "analyze_frames", "transcribe_audio", "plan_dub", "reedit",
             "plan_effects", "distill_style", "server_pipeline", "voiceover"}
    assert kinds <= set(est.MODE_PROFILES)
    for mode in ("dub_first", "highlight", "talking_head", "speech_scenes", "speech_highlights"):
        assert est.kind_for(None, mode) in est.MODE_PROFILES


def test_unknown_kind_or_mode_is_refused():
    with pytest.raises(ValueError):
        est.estimate_run(kind="mine_bitcoin")
    with pytest.raises(ValueError):
        est.estimate_run(mode="nope")


def test_stated_durations_parse_for_display_only():
    meta = {"clips": [{"durationSec": 30.5}, {"durationSec": "12"}, {"id": "x"}, "junk"]}
    assert est.clip_seconds_from_meta(meta) == [30.5, 12.0, 0.0]
    assert est.clip_seconds_from_meta(None) == []


def test_frame_count_prices_the_frames_actually_sent():
    run = est.estimate_run(kind="analyze_frames", clip_secs=[9999], frame_count=12)
    p = est.MODE_PROFILES["analyze_frames"]
    assert run.tokens == rate_card.tokens_for_llm(run.model, p.prompt_in + 12 * 258, 0, p.max_output)


def _call_site_model(kind: str, engine: str | None) -> str:
    """What each call site runs today, read the way the call site reads it."""
    s = get_settings()
    return {
        "analyze_video": (s.dub_engine_lite if engine == "lite" else s.dub_engine_pro) or s.dub_vision_model,
        # dub_ai.generate_dub_edit_script → llm.config.vision_call_kwargs
        "analyze_frames": s.llm_vision_model or s.llm_model,
        "reedit": s.dub_vision_model,
        "transcribe_audio": s.speech_select_model or s.dub_vision_model,
        "server_pipeline": s.llm_model,
        "plan_dub": s.llm_model,
        "voiceover": s.llm_model,
        "plan_effects": s.effects_vision_model,
        "distill_style": s.effects_vision_model,
    }[kind]


@pytest.mark.parametrize("engine", ["lite", "pro"])
@pytest.mark.parametrize("kind", sorted(est.MODE_PROFILES))
def test_every_kind_is_priced_at_the_model_its_call_site_runs(kind, engine):
    """Regression (2026-09-22 review): analyze-frames was priced at the Flash
    engine while the frame path calls the Pro vision model, so the per-call
    guard stopped EVERY such run before its first request."""
    from packages.llm.config import vision_call_kwargs

    run = est.estimate_run(kind=kind, engine=engine, clip_secs=[30, 30])
    assert rate_card.family_for(run.model) == rate_card.family_for(_call_site_model(kind, engine))
    if kind == "analyze_frames":
        assert rate_card.bare_model(run.model) == rate_card.bare_model(vision_call_kwargs()["model"])


@pytest.mark.parametrize("kind", sorted(est.MODE_PROFILES))
def test_the_first_call_always_fits_the_ceiling_the_estimate_reserved(kind):
    """The guard's budget for a run's first request (its prompt, its footage,
    its full output budget, at the call site's model) must fit the ceiling."""
    p = est.MODE_PROFILES[kind]
    secs = [30.0, 30.0]
    run = est.estimate_run(kind=kind, engine="pro", precision="high", clip_secs=secs)
    media = 0
    if p.uses_video:
        media = est.video_input_tokens(sum(secs), "high")
    elif p.uses_frames:
        media = est.frame_input_tokens(secs)
    first = rate_card.tokens_for_llm(_call_site_model(kind, "pro"), p.prompt_in + media, 0, p.max_output)
    assert first <= run.ceiling, (kind, first, run.ceiling)


def test_plan_limits_table():
    assert limits.window_limit("free", "monthly") == 100_000
    assert limits.window_limit("lite", "weekly") == math.floor(800_000 / 4.33)
    assert limits.window_limit("pro", "five_hour") == math.floor(math.floor(4_000_000 / 4.33) * 0.4)
    assert limits.plan_limits("mystery") == limits.PLAN_LIMITS["free"]
    assert limits.plan_limits("pro").windows == ("weekly", "five_hour")


# ── the endpoint ─────────────────────────────────────────────────────────────

async def _token(user_id: int) -> str:
    row = await db(
        "SELECT t.id, t.slug, u.token_version FROM core.tenants t "
        "JOIN core.memberships m ON m.tenant_id = t.id JOIN core.users u ON u.id = m.user_id "
        "WHERE m.user_id = :u",
        u=user_id,
    )
    return encode_access(user_id, int(row[0][0]), str(row[0][1]), int(row[0][2]))


def _keys(value) -> set[str]:
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in _keys(v)}
    if isinstance(value, list):
        return {k for v in value for k in _keys(v)}
    return set()


BODY = {"mode": "dub_first", "engine": "pro", "precision": "standard", "clips": [{"duration_sec": 60}]}


async def test_estimate_endpoint_speaks_percent_only():
    uid = await make_user(email("est"), plan="pro")
    async with client() as c:
        r = await c.post("/usage/estimate", json=BODY, headers=bearer(await _token(uid)))
    assert r.status_code == 200, r.text
    data = r.json()
    run = est.estimate_run(mode="dub_first", engine="pro", precision="standard", clip_secs=[60])
    assert data["pct"] == {
        "weekly": round(run.tokens / limits.window_limit("pro", "weekly") * 100, 1),
        "five_hour": round(run.tokens / limits.window_limit("pro", "five_hour") * 100, 1),
    }
    assert data["fits"] == "plan" and data["binding"] == "five_hour" and data["unlimited"] is False
    assert not any("token" in k for k in _keys(data)), data


async def test_a_run_bigger_than_the_free_month_does_not_fit():
    uid = await make_user(email("est"), plan="free")
    body = dict(BODY, precision="high", clips=[{"duration_sec": 3 * 3600}])
    async with client() as c:
        r = await c.post("/usage/estimate", json=body, headers=bearer(await _token(uid)))
    data = r.json()
    assert data["fits"] == "none" and data["binding"] == "monthly" and data["pct"]["monthly"] > 100
    assert data["wallet_satang"] > 0


async def test_admins_are_unlimited():
    uid = await make_user(email("est"), admin=True)
    async with client() as c:
        r = await c.post("/usage/estimate", json=BODY, headers=bearer(await _token(uid)))
    assert r.json() == {
        "fits": "plan", "pct": {}, "wallet_satang": 0, "binding": None, "resets_at": None, "unlimited": True,
    }


async def test_estimate_needs_a_login_and_valid_input():
    uid = await make_user(email("est"))
    async with client() as c:
        anonymous = await c.post("/usage/estimate", json=BODY)
        h = bearer(await _token(uid))
        bad_mode = await c.post("/usage/estimate", json=dict(BODY, mode="nope"), headers=h)
        too_long = await c.post("/usage/estimate", json=dict(BODY, clips=[{"duration_sec": 99_999}]), headers=h)
    assert anonymous.status_code == 401
    assert bad_mode.status_code == 422 and too_long.status_code == 422


async def test_estimate_is_rate_limited_per_account():
    uid = await make_user(email("est"))
    limit = ratelimit.USAGE_ESTIMATE_ACCOUNT.max_hits
    async with client() as c:
        h = bearer(await _token(uid))
        codes = [(await c.post("/usage/estimate", json=BODY, headers=h)).status_code for _ in range(limit + 1)]
    assert codes[:limit] == [200] * limit and codes[-1] == 429
