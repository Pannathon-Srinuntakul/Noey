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
    assert std.estimator_version == "e2" and std.rate_version == "v1"


# ── the three speech modes (e2) ──────────────────────────────────────────────
# One route, POST /videos/{uid}/transcribe-audio, three different pipelines.
# Until e2 all three were priced as 2 model calls + speech-to-text and not one
# of them did that. Every figure below is pinned at the Pro model explicitly so
# the arithmetic does not move with a DUB_VISION_MODEL override in .env.
#
#   rate card v1, "pro" family: input 1.38, output 8.28 per vendor token
#   speech-to-text: 51.75 per audio second
#   transcript fed to a planner: 15 tokens per audio second (TRANSCRIPT_TOKENS_PER_SEC)

PRO = "gemini-3.1-pro-preview"
TEN_MIN = 600.0


def _ten_min(mode: str) -> est.Estimate:
    return est.estimate_run(mode=mode, clip_secs=[TEN_MIN], model=PRO)


def test_talking_head_is_speech_to_text_and_nothing_else():
    """``tasks.plan_talking_local`` runs ``elevenlabs_stt.run_transcription``
    and then ``plan_core.build_talking_head_timeline``. ``plan_core`` imports
    no model gateway (the reviewer model was replaced by ``build_silence_gaps``
    arithmetic), so there is no model call to price."""
    run = _ten_min("talking_head")
    p = est.MODE_PROFILES[run.kind]
    assert run.kind == "transcribe_only" and p.calls == 0 and p.uses_stt

    #   speech-to-text  600 s x 51.75            =  31,050
    #   model calls     none                     =       0
    assert run.tokens == rate_card.tokens_for_stt(TEN_MIN) == 31_050
    assert run.ceiling == 37_260  # ceil(31,050 x 1.2)
    # It is pure speech-to-text, so it scales with the audio and nothing else.
    assert est.estimate_run(mode="talking_head", clip_secs=[TEN_MIN], audio_sec=300).tokens == (
        rate_card.tokens_for_stt(300)
    )


def test_talking_heads_planner_really_has_no_model_call_in_it():
    """The claim the profile above rests on, checked against the source rather
    than remembered: if a model call comes back to ``plan_core``, this fails
    here instead of as a ``RunBudgetExceeded`` on a user's run."""
    import pathlib

    from packages.video import plan_core

    src = pathlib.Path(plan_core.__file__).read_text(encoding="utf-8")
    assert "packages.llm" not in src and "acompletion" not in src


def test_speech_scenes_is_one_selector_call():
    """``speech_select.select_scenes`` makes exactly one ``_select`` call over
    the whole transcript, then hands the picks to arithmetic."""
    run = _ten_min("speech_scenes")
    p = est.MODE_PROFILES[run.kind]
    assert run.kind == "select_scenes" and p.calls == 1 and p.fanout is None

    transcript = math.ceil(15 * TEN_MIN)  # 9,000
    #   selector in   (4,000 prompt + 9,000 transcript) x 1.38 =  17,940
    #   selector out   4,000 x 8.28                            =  33,120
    #                                                            -------
    #                                                             51,060
    #   speech-to-text 600 x 51.75                             =  31,050
    assert rate_card.tokens_for_llm(PRO, p.prompt_in + transcript, 0, p.max_output) == 51_060
    assert run.tokens == 82_110
    assert run.ceiling == 98_532  # ceil(82,110 x 1.2)


def test_speech_highlights_pays_for_one_trim_call_per_expected_clip():
    """``select_highlights`` gathers one ``trim_span_content`` call per
    surviving pick (speech_select.py ~line 1011), so a good recording costs
    MORE than a poor one. A fixed ``calls=2`` under-counted every real run."""
    run = _ten_min("speech_highlights")
    p = est.MODE_PROFILES[run.kind]
    assert run.kind == "select_highlights" and p.calls == 1 and p.fanout is not None

    transcript = math.ceil(15 * TEN_MIN)  # 9,000
    picks = est.expected_picks_for(TEN_MIN)
    assert picks == 10  # ceil(600 / 60), inside [3, 24]
    share = math.ceil(transcript / picks)  # 900 — the spans do not overlap
    #   selector   in  (4,000 + 9,000) x 1.38  =  17,940
    #   selector   out  6,000 x 8.28           =  49,680   ->  67,620
    #   trim, each in  (3,000 +   900) x 1.38  =   5,382
    #   trim, each out  2,500 x 8.28           =  20,700   ->  26,082 x 10 = 260,820
    #   speech-to-text  600 x 51.75                                        =  31,050
    #                                                                        -------
    #                                                                        359,490
    assert rate_card.tokens_for_llm(PRO, p.prompt_in + transcript, 0, p.max_output) == 67_620
    assert rate_card.tokens_for_llm(PRO, p.fanout.prompt_in + share, 0, p.fanout.max_output) == 26_082
    assert run.tokens == 359_490
    assert run.ceiling == 431_388  # ceil(359,490 x 1.2)


def test_speech_highlights_grows_with_the_number_of_clips_expected():
    base = est.estimate_run(mode="speech_highlights", clip_secs=[TEN_MIN], model=PRO, expected_picks=4)
    more = est.estimate_run(mode="speech_highlights", clip_secs=[TEN_MIN], model=PRO, expected_picks=12)
    none = est.estimate_run(mode="speech_highlights", clip_secs=[TEN_MIN], model=PRO, expected_picks=0)
    assert none.tokens < base.tokens < more.tokens
    # With no fan-out left it is the selector plus speech-to-text, i.e. the
    # scenes shape at the highlights selector's bigger output budget.
    assert none.tokens == 67_620 + rate_card.tokens_for_stt(TEN_MIN)
    # …and the derived count is bounded at both ends, so neither a 30-second
    # clip nor a three-hour podcast escapes into a silly number.
    assert est.expected_picks_for(30) == est.MIN_EXPECTED_PICKS
    assert est.expected_picks_for(3 * 3600) == est.MAX_EXPECTED_PICKS


def test_the_three_speech_modes_no_longer_cost_the_same():
    """The e1 bug in one line: one kind, one figure, three unrelated
    pipelines. talking_head was paying ~4.3x its real shape."""
    talking, scenes, highlights = (
        _ten_min(m).tokens for m in ("talking_head", "speech_scenes", "speech_highlights")
    )
    assert talking < scenes < highlights
    e1 = rate_card.tokens_for_llm(PRO, 4_000 + 9_000, 0, 4_000) * 2 + rate_card.tokens_for_stt(TEN_MIN)
    assert e1 == 133_170
    assert round(e1 / talking, 1) == 4.3
    assert highlights > e1 * 2


def test_the_legacy_speech_kind_still_prices_a_stored_ticket():
    """``video_projects.resume_state`` rows written before e2 name
    ``transcribe_audio``; ``resume.estimate_for`` returns None for a kind it
    cannot find, and POST /videos/{uid}/resume answers 409 on a None. So the
    name stays — priced as the DEAREST of the three it used to stand for, so
    an old ticket is never resumed under a ceiling too small for its work."""
    from packages.billing import resume as resume_mod

    legacy = resume_mod.estimate_for(
        resume_mod.ticket(stage="select", kind="transcribe_audio", media_sec=TEN_MIN)
    )
    assert legacy is not None and legacy.kind == "transcribe_audio"
    # Compared at whatever model this environment resolves, the way a resume
    # really prices it — the point is the ordering, not the figure.
    for mode in ("talking_head", "speech_scenes", "speech_highlights"):
        assert legacy.tokens >= est.estimate_run(mode=mode, clip_secs=[TEN_MIN]).tokens


def test_every_mode_a_client_can_pick_is_footage_capped():
    """``start_paid_run`` only measures footage for a kind in
    ``plan_features.FOOTAGE_KINDS``. Renaming a kind and forgetting that set
    silently turns off the plan's footage cap for that mode — which is exactly
    what splitting ``transcribe_audio`` did on the first attempt."""
    from packages.billing import plan_features

    for mode, kind in est.KIND_FOR_MODE.items():
        assert kind in plan_features.FOOTAGE_KINDS, (mode, kind)


def test_every_speech_mode_fits_the_footage_its_plan_advertises():
    """The sibling of test_plan_features' cap check, for the modes that check
    does not walk. The speech modes are off the plan's ladder (owner,
    2026-10-01): two hours on every plan, bounded by what the plan's window
    can pay (``check_run_size``). The pricing page states exactly that, so pin
    it: talking_head runs the full two hours on every plan, every speech mode
    still fits the length the plan's ladder used to allow, and only Free and
    Lite stop short of two hours of speech_highlights."""
    full = float(limits.SPEECH_FOOTAGE_SEC)
    for plan in PLANS:
        limit = limits.plan_limits(plan)
        biggest = max(limits.window_limit(plan, w) for w in limit.windows)
        assert est.estimate_run(mode="talking_head", clip_secs=[full], model=PRO).tokens < biggest, plan
        for mode in ("talking_head", "speech_scenes", "speech_highlights"):
            run = est.estimate_run(mode=mode, clip_secs=[float(limit.footage_sec)], model=PRO)
            for window in limit.windows:
                assert run.tokens < limits.window_limit(plan, window), (plan, mode, window)
        longform = est.estimate_run(mode="speech_highlights", clip_secs=[full], model=PRO)
        assert (longform.tokens <= biggest) == (plan not in ("free", "lite")), plan


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
    kinds = {"analyze_video", "analyze_frames", "transcribe_only", "select_scenes",
             "select_highlights", "transcribe_audio", "plan_dub", "reedit",
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
        # speech_select._select resolves quality.speech_model() itself
        "transcribe_only": s.speech_select_model or s.dub_vision_model,
        "select_scenes": s.speech_select_model or s.dub_vision_model,
        "select_highlights": s.speech_select_model or s.dub_vision_model,
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
    if p.calls == 0:
        # There IS no first request: the pipeline is speech-to-text plus
        # arithmetic. The ceiling is therefore the speech-to-text alone, and
        # deliberately too small to admit a model call — the profile's claim,
        # enforced rather than asserted in prose.
        nothing = est.estimate_run(kind=kind, engine="pro", precision="high", clip_secs=secs)
        assert p.fanout is None and p.uses_stt
        assert nothing.tokens == rate_card.tokens_for_stt(sum(secs))
        return
    run = est.estimate_run(kind=kind, engine="pro", precision="high", clip_secs=secs)
    media = 0
    if p.uses_video:
        media = est.video_input_tokens(sum(secs), "high")
    elif p.uses_frames:
        media = est.frame_input_tokens(secs)
    first = rate_card.tokens_for_llm(_call_site_model(kind, "pro"), p.prompt_in + media, 0, p.max_output)
    assert first <= run.ceiling, (kind, first, run.ceiling)


PLANS = ("free", "lite", "starter", "pro", "studio", "agency", "max")


def test_plan_limits_table():
    # Free is a one-time trial credit; its "monthly" number IS that credit.
    assert limits.window_limit("free", "lifetime") == limits.PLAN_LIMITS["free"].monthly
    assert limits.plan_limits("mystery") == limits.PLAN_LIMITS["free"]
    # The window arithmetic is still defined for the windows nothing enforces.
    assert limits.window_limit("lite", "weekly") == math.floor(800_000 / 4.33)
    assert limits.window_limit("lite", "five_hour") == math.floor(
        math.floor(800_000 / 4.33) * limits.FIVE_HOUR_SHARE
    )


def test_one_window_rule_per_account():
    """Free spends a lifetime credit, every paid plan spends a month. No plan
    enforces a 5-hour or weekly sub-window any more (limits.py rule 1): they
    could not hold one large run, so they only ever blocked the NEXT job."""
    assert limits.plan_limits("free").windows == ("lifetime",)
    for plan in PLANS[1:]:
        assert limits.plan_limits(plan).windows == ("monthly",), plan
    enforced = {w for p in PLANS for w in limits.plan_limits(p).windows}
    assert enforced == {"lifetime", "monthly"}
    # …but every window is still ACCOUNTED for, so switching one back on
    # would not start the first account that got it from zero.
    assert set(limits.TRACKED_WINDOWS) == {"five_hour", "weekly", "monthly", "lifetime"}


def test_the_pricing_pages_cut_count_is_approximate_and_rounds_down():
    """The meter is a percentage; this number exists only for the pricing
    page's "ตัดได้ราว N คลิป". It rounds DOWN, so the claim is never one the
    account cannot finish, and it is deliberately approximate — a longer or
    high-precision cut costs more than one ``TYPICAL_CUT_TOKENS``."""
    assert [limits.plan_cuts(p) for p in PLANS] == [2, 4, 10, 30, 64, 140, 259]
    assert limits.plan_cuts("mystery") == limits.plan_cuts("free")
    # Free's 450,000 is 2.25 typical cuts and is advertised as 2, never 3.
    free = limits.PLAN_LIMITS["free"].monthly
    assert free / limits.TYPICAL_CUT_TOKENS > limits.plan_cuts("free")
    # And it really is a claim about a typical cut, not about the cheapest
    # one a plan allows: 5 minutes of Standard source with a voiceover, as
    # measured — 185,070, not a rounded-up stand-in.
    assert limits.TYPICAL_CUT_TOKENS == 185_070


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
    # Whatever the table says Pro enforces — not a list typed in here twice.
    windows = limits.plan_limits("pro").windows
    assert data["pct"] == {
        w: round(run.tokens / limits.window_limit("pro", w) * 100, 1) for w in windows
    }
    tightest = min(windows, key=lambda w: limits.window_limit("pro", w))
    assert data["fits"] == "plan" and data["binding"] == tightest and data["unlimited"] is False
    assert data["resets"] is True
    assert not any("token" in k for k in _keys(data)), data


async def test_a_run_bigger_than_the_free_credit_does_not_fit():
    """Free's window is the lifetime trial credit, and it is the one window
    that reports ``resets: False`` — nothing refills it."""
    uid = await make_user(email("est"), plan="free")
    body = dict(BODY, clips=[{"duration_sec": 3 * 3600}])
    async with client() as c:
        r = await c.post("/usage/estimate", json=body, headers=bearer(await _token(uid)))
    data = r.json()
    assert data["fits"] == "none" and data["binding"] == "lifetime" and data["pct"]["lifetime"] > 100
    assert data["resets"] is False and data["resets_at"] is None
    assert data["wallet_satang"] > 0


async def test_admins_are_unlimited():
    uid = await make_user(email("est"), admin=True)
    async with client() as c:
        r = await c.post("/usage/estimate", json=BODY, headers=bearer(await _token(uid)))
    assert r.json() == {
        "fits": "plan", "pct": {}, "wallet_satang": 0, "binding": None, "resets_at": None,
        "resets": True, "unlimited": True,
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
