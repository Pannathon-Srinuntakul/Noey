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
    out = est.cut_plan_output_for("lite")
    assert std.kind == "analyze_video" and std.model == lite
    assert std.tokens == rate_card.tokens_for_llm(lite, 60 * 100 + p.prompt_in, 0, out)
    assert high.tokens == rate_card.tokens_for_llm(lite, 60 * 300 + p.prompt_in, 0, out)
    assert std.ceiling == math.ceil(std.tokens * 1.2)
    assert std.estimator_version == "e4" and std.rate_version == "v1"


def test_scout_is_priced_at_its_own_thinking_depth(monkeypatch):
    """Scout thinks at medium and Pro at high; the estimate prices each at
    its own depth (e3), from the e4 thinking figures — ~21.5k at high,
    ~10k at medium — plus the same default-size answer."""
    monkeypatch.setenv("DUB_EFFORT_LITE", "medium")
    monkeypatch.setenv("DUB_EFFORT_PRO", "high")
    get_settings.cache_clear()
    try:
        answer = est.cut_answer_tokens(est.DEFAULT_CUT_SEGMENTS)
        assert answer == 60 + 165 * 18 == 3_030
        assert est.cut_plan_output_for("pro") == est.CUT_PLAN_OUTPUT_TOKENS == 21_500 + answer
        assert est.cut_plan_output_for("lite") == est.CUT_PLAN_OUTPUT_TOKENS_MEDIUM == 10_000 + answer
        pro = est.estimate_run(mode="dub_first", engine="pro", precision="standard", clip_secs=[331.8])
        scout = est.estimate_run(mode="dub_first", engine="lite", precision="standard", clip_secs=[331.8])
        # Run b8ad8c25's footage: e3 said 164,756 at a flat 24,000 output;
        # e4's default-size plan writes 530 more (24,530).
        assert pro.tokens == 167_495 and pro.call_output == 24_530 and pro.expected_items == 18
        assert pro.tokens - scout.tokens == rate_card.tokens_for_llm(pro.model, 0, 0, 11_500)
    finally:
        get_settings.cache_clear()


# ── output sized by what the user asked for (e4) ─────────────────────────────

def test_the_cut_plans_answer_grows_with_the_requested_length():
    """Owner, 2026-10-01: output is the expensive half, so it follows the
    request — target length × ~0.6 segments a second, ~165 tokens a segment
    (alternates included), on top of the engine's thinking."""
    base = est.estimate_run(mode="highlight", engine="pro", clip_secs=[1800])
    one_min = est.estimate_run(mode="highlight", engine="pro", clip_secs=[1800], target_sec=60)
    five_min = est.estimate_run(mode="highlight", engine="pro", clip_secs=[1800], target_sec=300)
    assert (base.expected_items, one_min.expected_items, five_min.expected_items) == (18, 36, 180)
    assert base.tokens < one_min.tokens < five_min.tokens
    assert five_min.call_output - base.call_output == 165 * (180 - 18)
    # The input is the same footage either way — only the answer moved.
    assert five_min.tokens - base.tokens == rate_card.tokens_for_llm(base.model, 0, 0, 165 * 162)
    # A tiny target never prices below the floor.
    assert est.estimate_run(mode="highlight", clip_secs=[60], target_sec=5).expected_items == est.MIN_CUT_SEGMENTS


def test_a_user_script_sizes_the_plan_by_its_lines():
    """A script is kept verbatim, ~2 segments to each 3-6 s line; a script
    written as one paragraph is counted in ~65-character lines."""
    assert est.script_lines("") == 0
    assert est.script_lines("หนึ่ง\n\nสอง\nสาม") == 3
    assert est.script_lines("ก" * 650) == 10
    lines = "\n".join(f"บรรทัด {i}" for i in range(15))
    run = est.estimate_run(mode="dub_first", clip_secs=[120], script=lines, target_sec=600)
    # The script decides, even beside a target.
    assert run.expected_items == 30


def test_a_reedit_is_priced_on_the_script_it_echoes_back():
    small = est.estimate_run(kind="reedit", clip_secs=[60, 30], segments=10)
    big = est.estimate_run(kind="reedit", clip_secs=[60, 30], segments=120)
    assert (small.expected_items, big.expected_items) == (10, 120)
    # (±1: the rate card rounds each call up separately)
    assert abs(big.tokens - small.tokens - rate_card.tokens_for_llm(small.model, 0, 0, 165 * 110)) <= 1


def test_the_longest_result_a_user_may_ask_for_fits_one_answer():
    """Owner, 2026-10-01: a cut plan stays ONE model call, so the result a
    user may request of the video-cut modes is capped where the answer still
    fits one Gemini Flash response (65,536 output tokens, thinking included)
    — at the estimate's centre AND at the worst measured case."""
    assert est.MAX_CUT_RESULT_SEC == 300
    centre = est.estimate_run(mode="highlight", engine="pro", clip_secs=[1800], target_sec=300)
    assert centre.expected_items == 180
    assert centre.call_output == 21_500 + 60 + 165 * 180 == 51_260 < centre.max_call_output == 65_536
    assert est.worst_cut_output(300) == 30_000 + 60 + 190 * 180 == 64_260
    assert est.worst_cut_output(300) < est.DEFAULT_MODEL_MAX_OUTPUT == 65_536
    # Ten minutes would not: why the old 600 s bound could not stand.
    assert est.worst_cut_output(600) > 65_536
    assert est.estimate_run(mode="highlight", engine="pro", clip_secs=[60], target_sec=600).call_output > 65_536


def test_a_speech_selection_fits_one_answer_at_the_pipelines_ceiling():
    """The speech selector writes one ~200-token pick per span (start/end/
    title/why/opening/ending — not per-cut shots); the pipeline keeps at most
    60 highlights, so even a two-hour recording's answer is ~16k with its
    thinking. No input cap is needed for one response to hold it; each span
    trim is its own small call (one verdict per ~2.5 s transcript segment)."""
    two_hours = est.estimate_run(mode="speech_highlights", clip_secs=[7200.0])
    assert two_hours.expected_items == est.MAX_EXPECTED_PICKS == 60
    assert two_hours.call_output == 4_000 + 200 * 60 == 16_000
    assert two_hours.call_output < two_hours.max_call_output
    scenes = est.estimate_run(mode="speech_scenes", clip_secs=[7200.0])
    assert scenes.call_output == 4_000 + 35 * 60 < 65_536
    # The longest span a trim call can be handed (a 2-hour recording with the
    # minimum 3 picks: 40 min) still answers in ~14k.
    span = 7200 / est.MIN_EXPECTED_PICKS
    assert est.TRIM_THINKING_TOKENS + 150 + 13 * math.ceil(span / 2.5) < 65_536


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
    the whole transcript, then hands the picks to arithmetic. e4: its answer
    is one ~35-token range per expected pick on top of the selector's
    thinking."""
    run = _ten_min("speech_scenes")
    p = est.MODE_PROFILES[run.kind]
    assert run.kind == "select_scenes" and p.calls == 1 and p.fanout is None

    transcript = math.ceil(15 * TEN_MIN)  # 9,000
    picks = est.expected_picks_for(TEN_MIN)
    assert picks == 5  # ceil(600 / 120)
    out = 4_000 + 35 * picks  # 4,175
    #   selector in   (4,000 prompt + 9,000 transcript) x 1.38 =  17,940
    #   selector out   4,175 x 8.28                            =  34,569
    #   speech-to-text 600 x 51.75                             =  31,050
    assert run.call_output == out
    assert run.tokens == rate_card.tokens_for_llm(PRO, p.prompt_in + transcript, 0, out) + 31_050 == 83_559


def test_speech_highlights_pays_for_one_trim_call_per_expected_clip():
    """``select_highlights`` gathers one ``trim_span_content`` call per
    surviving pick (speech_select.py ~line 1011), so a good recording costs
    MORE than a poor one. e4: the selector writes ~200 tokens a pick, and
    each trim one verdict (~13) per ~2.5 s transcript segment of its span."""
    run = _ten_min("speech_highlights")
    p = est.MODE_PROFILES[run.kind]
    assert run.kind == "select_highlights" and p.calls == 1 and p.fanout is not None

    transcript = math.ceil(15 * TEN_MIN)  # 9,000
    picks = est.expected_picks_for(TEN_MIN)
    assert picks == 5  # ceil(600 / 120), inside [3, 60]
    share = math.ceil(transcript / picks)  # 1,800 — the spans do not overlap
    select_out = 4_000 + 200 * picks  # 5,000
    trim_out = 2_000 + 150 + 13 * math.ceil(TEN_MIN / picks / 2.5)  # 2,774
    selector = rate_card.tokens_for_llm(PRO, p.prompt_in + transcript, 0, select_out)
    trim = rate_card.tokens_for_llm(PRO, p.fanout.prompt_in + share, 0, trim_out)
    assert run.tokens == selector + trim * picks + rate_card.tokens_for_stt(TEN_MIN) == 238_355
    assert run.call_output == select_out


def test_speech_highlights_grows_with_the_number_of_clips_expected():
    base = est.estimate_run(mode="speech_highlights", clip_secs=[TEN_MIN], model=PRO, expected_picks=4)
    more = est.estimate_run(mode="speech_highlights", clip_secs=[TEN_MIN], model=PRO, expected_picks=12)
    none = est.estimate_run(mode="speech_highlights", clip_secs=[TEN_MIN], model=PRO, expected_picks=0)
    assert none.tokens < base.tokens < more.tokens
    # With no fan-out left it is the selector plus speech-to-text.
    assert none.tokens == rate_card.tokens_for_llm(PRO, 4_000 + 9_000, 0, 4_000) + rate_card.tokens_for_stt(TEN_MIN)
    # …and the derived count is bounded at both ends: a floor, and the
    # pipeline's own runaway ceiling (60 kept highlights).
    assert est.expected_picks_for(30) == est.MIN_EXPECTED_PICKS
    assert est.expected_picks_for(3 * 3600) == est.MAX_EXPECTED_PICKS == 60
    # The owner's example: an hour-long recording is priced at 30 highlights.
    assert est.expected_picks_for(3600) == 30


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
    assert highlights > e1 * 1.5


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
        # Two hours of speech_highlights against the SMALLEST window (a new
        # run must fit every enforced window): e4 prices an hour at 30
        # highlights, so two hours (60, the pipeline's ceiling) is ~2.44M at
        # the Pro model — past Starter's month and Pro's 40 % week. Studio
        # and up hold it. (Owner decision pending: the pricing page still
        # says only Free and Lite stop short of two hours.)
        smallest = min(limits.window_limit(plan, w) for w in limit.windows)
        longform = est.estimate_run(mode="speech_highlights", clip_secs=[full], model=PRO)
        assert (longform.tokens <= smallest) == (plan in ("studio", "agency", "max")), plan


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
    # Weekly = 40 % of the month (owner, 2026-10-01); five_hour keeps the
    # old arithmetic, still defined for a window nothing enforces.
    assert limits.window_limit("pro", "weekly") == math.floor(5_600_000 * 0.40) == 2_240_000
    assert limits.window_limit("lite", "five_hour") == math.floor(
        math.floor(800_000 / 4.33) * limits.FIVE_HOUR_SHARE
    )


def test_the_window_rules_per_plan():
    """Free spends a lifetime credit; every paid plan a month; Pro, Studio,
    Agency and Max a 40 % week beside it (owner, 2026-10-01). Nobody
    enforces the 5-hour window."""
    assert limits.plan_limits("free").windows == ("lifetime",)
    for plan in ("lite", "starter"):
        assert limits.plan_limits(plan).windows == ("monthly",), plan
    for plan in ("pro", "studio", "agency", "max"):
        assert limits.plan_limits(plan).windows == ("monthly", "weekly"), plan
        assert limits.enforces_weekly(plan)
    enforced = {w for p in PLANS for w in limits.plan_limits(p).windows}
    assert enforced == {"lifetime", "monthly", "weekly"}
    # …but every window is still ACCOUNTED for, so switching one on does not
    # start the first account that gets it from zero.
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
        "fits": "plan", "full": False, "overage_too_large": False, "pct": {}, "wallet_satang": 0,
        "binding": None, "resets_at": None, "resets": True, "unlimited": True,
    }


async def test_the_estimate_says_which_start_would_be_refused():
    """``fits`` is advice; ``full`` and ``overage_too_large`` are the two
    gates a start can still meet (owner, 2026-10-01) — so the wizard stops
    before anything uploads."""
    uid = await make_user(email("est"), plan="free")
    credit = limits.window_limit("free", "lifetime")

    async def ask(left: int, seconds: float) -> dict:
        await db(
            "INSERT INTO core.usage_accounts (user_id, lifetime_started_at, lifetime_used, reserved_tokens) "
            "VALUES (:u, now(), :m, 0) ON CONFLICT (user_id) DO UPDATE SET lifetime_used = :m, "
            "lifetime_started_at = now()",
            u=uid, m=credit - left,
        )
        async with client() as c:
            r = await c.post("/usage/estimate", json=dict(BODY, clips=[{"duration_sec": seconds}]),
                             headers=bearer(await _token(uid)))
        assert r.status_code == 200, r.text
        return r.json()

    # The strict start gate (owner, 2026-10-01): the run must FIT what is
    # left — a 60 s Pro cut (~130k) does not fit 50k, so it is refused now.
    small = await ask(50_000, 60)
    assert (small["fits"], small["full"], small["overage_too_large"]) == ("none", False, True)
    fits = await ask(200_000, 60)
    assert (fits["fits"], fits["full"], fits["overage_too_large"]) == ("plan", False, False)
    spent = await ask(0, 60)
    assert spent["full"] is True and spent["resets"] is False


async def test_the_estimate_sizes_the_answer_by_the_requested_length():
    uid = await make_user(email("est"), plan="pro")
    body = dict(BODY, mode="highlight", clips=[{"duration_sec": 1800}])
    async with client() as c:
        short = await c.post("/usage/estimate", json=dict(body, target_duration_sec=60),
                             headers=bearer(await _token(uid)))
        long = await c.post("/usage/estimate", json=dict(body, target_duration_sec=300),
                            headers=bearer(await _token(uid)))
    assert short.status_code == long.status_code == 200
    assert short.json()["pct"]["monthly"] < long.json()["pct"]["monthly"]


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
