"""Pre-flight estimate of one AI run, in rate-card tokens. Server-side only.

**What this estimate is NOT.** It is not what anyone is charged. A run is
charged per real vendor request as it goes (``packages/billing/metering.py``,
``guard.call_budget``), from the actual messages and the actual ``max_tokens``
of each call — never from anything in this file. Nothing is reserved at start
(owner, 2026-09-26), so a wrong number here moves no money on a run that
succeeds.

**The estimate is ADVICE** (owner, 2026-10-01 — the "chat AI usage limit"
model). No call is refused, and no call's output is capped, because of it:
a run is sent call after call while the plan's window has anything left and
pauses at 100 % (packages/billing/guard.py). What it still drives:

1. **The figure the clients show before a run starts** — "งานนี้ใช้ประมาณ 5%"
   (``POST /usage/estimate``, ``GET /videos/{uid}/resume``). This is the one
   live job the number has.
2. **The run's ceiling**, ``ceil(estimate × 1.2)`` — now only the line an
   OPTIONAL call (a quality retry) is held to, so a retry never doubles a run.
   Required calls ignore it.
3. **The overage gate at start** (``guard.overage_refusal``): a NEW run
   expected to go past what is left by more than
   ``BILLING_MAX_OVERAGE_RATIO`` of the window is refused — the one place
   the estimate still refuses anything, and the reason it must not be
   inflated.
4. **The in-flight price of a call** (``guard.call_budget`` reads the
   profile's ``max_output`` as what a call is expected to write). The output
   a call MAY write is the profile's ``output_cap`` (the model's own maximum
   for the single-call steps), which has nothing to do with the estimate.
5. ``plan_features.check_run_size``, a refusal that today no plan can reach:
   every advertised footage cap prices well under every enforced window
   (tests/test_plan_features.py, tests/test_estimate.py).

The wizard asks ``POST /usage/estimate`` as soon as files are chosen; every
start route recomputes the same estimate from what the SERVER measured on the
files it received (ffprobe — ``ffmpeg_bin.measure_media``: the proxies, the
preview, a style reference, the WAVs; the number of frame images) and never
prices a length the client states — not ``local_meta.clips[].durationSec``,
not a manifest's ``durationSec``. A file whose length cannot be measured is
refused, never priced as zero (2026-09-22 billing review).

Formula (docs/token-billing-design.md §5)::

    video_in   = Σ clip_sec × (100 standard | 300 high)          # plan §4.1
    frames_in  = Σ (frame budget per clip + 2 edge frames) × 258
    transcript = transcript_per_sec × audio_sec                  # planner's input
    stt        = rate_card.tokens_for_stt(audio_sec)             # transcribing kinds
    llm        = tokens_for_llm(model,
                    video_in + frames_in + prompt_in + transcript,
                    0, max_output) × calls
               + fan-out pass, when the profile has one (see FanoutPass)
    estimate   = llm + stt;  ceiling = ceil(estimate × 1.2)

Profiles (``ESTIMATOR_VERSION = "e2"``), measured 2026-09-22 with
``scripts/usage_profile.py --days 365`` on the development database (the only
real usage so far; re-measure on production and bump the version):

    feature        model                     n    in p50    p99   out p50  p90   p99
    video_cut      gemini-3.8-flash        468    27,136  120,524  2,522  3,254  24,869
    video_cut      gemini-3.7-flash      1,144     1,227   29,336    412    511   3,148
    video_effects  gemini-3.1-pro-preview  272    30,988   35,905  1,607  1,852   1,916
    video_style    gemini-3.1-pro-preview   31    45,635   57,285    900    900     900
    STT file (scribe_v2)                   552    211 s p50, 422 s p99

``prompt_in`` is the text around the footage (the dub system prompt alone is
~4.8k tokens); ``max_output`` is the output + thinking the estimate budgets
for. For the short text calls that number sits above p90. For the cut-planning
kinds it does NOT: the dub p99 of 24.9k is not runaway thinking, it is what a
cut plan costs (re-measured on production 2026-09-29 — see
``CUT_PLAN_OUTPUT_TOKENS``), so those budget for it. The per-call guard's
``max_tokens`` must agree with ``max_output`` (CORE-B, design §6.2).
Video tokens use the owner's plan figures (100 / 300 per second); the
2026-09-07 measurement in packages/video/quality.py was ~84 / ~348.

``e2`` (2026-09-29) split the one ``transcribe_audio`` kind that stood for all
three speech modes — it priced each of them as 2 model calls plus speech-to-
text, and not one of the three does that. Traced through the code instead of
the profile:

* ``talking_head``  — ``tasks.plan_talking_local`` → ``elevenlabs_stt``
  ``run_transcription`` then ``plan_core.build_talking_head_timeline``.
  ``plan_core`` imports no model gateway at all; the silent-gap review that
  used to be a model pass is now arithmetic (``build_silence_gaps``). ZERO
  model calls — the cost is speech-to-text and nothing else.
* ``speech_scenes`` — ``speech_select.select_scenes``: exactly one ``_select``
  call over the transcript.
* ``speech_highlights`` — ``speech_select.select_highlights``: one selector
  call, then ``asyncio.gather`` of one ``trim_span_content`` call PER SURVIVING
  PICK. The call count is not a constant; it grows with how much of the
  recording is worth keeping (see ``FanoutPass`` / ``expected_picks_for``).
* ``server_pipeline`` — the server-render chain for the same talking_head
  (``ingest_video`` → ``transcribe_video`` → ``plan_edit`` → ``render_video``);
  ``plan_edit`` calls the same ``build_talking_head_timeline``. Also ZERO model
  calls, and also priced for two.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any, Literal

from packages.billing import rate_card

ESTIMATOR_VERSION = "e3"
CEILING_RATIO = 1.2

VIDEO_TOKENS_PER_SEC: dict[str, int] = {"standard": 100, "high": 300}
#: Gemini bills one image at 258 tokens.
FRAME_TOKENS = 258
EDGE_FRAMES_PER_CLIP = 2

Kind = Literal[
    "analyze_video",
    "analyze_frames",
    "transcribe_only",
    "select_scenes",
    "select_highlights",
    "transcribe_audio",
    "plan_dub",
    "reedit",
    "plan_effects",
    "distill_style",
    "server_pipeline",
    "voiceover",
]
#: Which call site's model a kind is priced at — each resolves through the SAME
#: function the call site uses (packages/video/quality.py, packages/llm/config.py):
#: engine  the project's Engine tier (analyze-video)       quality.engine_model
#: vision  the frame-based vision path (analyze-frames)    llm.config.vision_model
#: reedit  the AI re-edit                                   quality.reedit_model
#: effects effects placement / effects-style distillation   quality.effects_model
#: speech  speech-mode selection                            quality.speech_model
#: text    a text call naming no model (plan-dub)           llm.config.text_model
ModelRole = Literal["engine", "vision", "reedit", "effects", "speech", "text"]


@dataclass(frozen=True)
class FanoutPass:
    """A second pass that runs once per item the first pass returned.

    ``speech_highlights`` is the only one: ``select_highlights`` picks the
    topic spans in one call, then gathers one ``trim_span_content`` call per
    surviving pick. A fixed ``calls`` cannot describe that — the count grows
    with how much of the recording is worth keeping — so the profile carries
    the shape of ONE such call and ``estimate_run`` multiplies it by the
    expected pick count (``expected_picks_for``).

    ``max_output`` here is an estimate component only. The ``max_tokens`` the
    guard hands an unbounded call is the run profile's ``max_output``
    (``guard.meter_for_run``), which is the bigger of the two — a trim call is
    never truncated by this number.
    """

    #: Fixed text per call: the pass's own system prompt plus its header.
    prompt_in: int
    #: Output + thinking budgeted for ONE call of the pass.
    max_output: int
    #: The transcript is DIVIDED across these calls rather than repeated in
    #: each: every ``trim_span_content`` call is shown its own span only, and
    #: the spans are non-overlapping ranges of the same transcript. Charging
    #: each call for the whole transcript would over-count by the pick count.
    splits_transcript: bool = True


@dataclass(frozen=True)
class ModeProfile:
    prompt_in: int
    #: Output tokens one call is expected to produce. This is NOT the API's
    #: ``max_tokens``: Gemini bills thinking as output, and thinking is not
    #: bounded by the cap we send. Measured on the three production
    #: ``analyze_video`` runs (docs/unit-economics.md §4.1): 17,732 / 27,216 /
    #: 24,141 output tokens against a profile that claimed 8,000 — which made
    #: every estimate 2.8x low. The number matters far beyond the figure shown
    #: before a run: ``guard.admit`` refuses a call whose budget exceeds what
    #: the plan's window still holds, and ``runs.windows_for_run`` decides
    #: which window governs, both from this estimate. Too low and a run is
    #: admitted against a window it then overshoots.
    max_output: int
    #: Transcript tokens fed to the planner per second of audio.
    transcript_per_sec: float = 0.0
    #: Model calls of this shape the run makes. ZERO is a real answer: a kind
    #: whose pipeline is speech-to-text plus arithmetic makes no model call at
    #: all, and pricing it for two was this module's largest error (see the
    #: ``e2`` note in the module docstring).
    calls: int = 1
    uses_video: bool = False
    uses_frames: bool = False
    uses_stt: bool = False
    model: ModelRole = "engine"
    #: A per-item second pass, when the run fans out.
    fanout: FanoutPass | None = None
    #: The per-call SAFETY cap: ``max_tokens`` (output + thinking — Gemini
    #: counts thought tokens inside max_output_tokens) for every call of the
    #: run that sets none. Runaway protection only; deliberately independent
    #: of the estimate and of what is left of the quota (2026-10-01).
    #: ``MODEL_MAX`` = the model's own maximum output, read from LiteLLM's
    #: model metadata at call time (``llm.config.model_max_output_tokens``).
    output_cap: int = 16_000


#: What a cut-planning call really produces, thinking included (2026-09-29).
#: The three measured ``analyze_video`` runs came out at 17,732 / 27,216 /
#: 24,141 output tokens; 24,000 sits between the median and the worst of them.
#: ``analyze_frames`` and ``reedit`` get the same number on purpose: all three
#: are the SAME request — plan a cut, reason over the footage, emit an edit
#: script — differing only in how the footage arrives (video part, uploaded
#: frames, or a re-edit of an existing script). Nothing makes their thinking
#: shorter, so leaving them at 8,000 would keep under-estimating two of the
#: three paths that spend the most.
CUT_PLAN_OUTPUT_TOKENS = 24_000

#: The same cut plan at thinking level MEDIUM — the Scout (lite) engine's
#: (quality.engine_effort). scripts/effort_ab.py, 2026-09-29, two of the
#: owner's clips, eight runs: 12,428 thinking tokens at medium against 22,892
#: at high; the answer itself (the edit script) is ~2-3k either way, so
#: ~15,000 in all. Pricing Scout at Pro's thinking made the advice wrong by
#: ~45 % of the output term — and made "try Scout" (the overage refusal's
#: suggestion) a suggestion that changed nothing. e3, 2026-10-01.
#:
#: Footage length is deliberately NOT a term (looked at 2026-10-01): the six
#: production outputs do not follow it (192 s → 17.7k, 136 s → 27.2k, 227 s →
#: 24.1k, 332 s → 19.1k / 19.5k / 29.5k+), and the prompts explain why — the
#: number of segments is set by the script / target length, not by how much
#: footage there is, and each segment's ≤3 alternates scale with segments
#: too. More footage gives the model more to LOOK at (input, already priced
#: per second), not more to write.
CUT_PLAN_OUTPUT_TOKENS_MEDIUM = 15_000


def cut_plan_output_for(engine: str | None) -> int:
    """Expected output of the engine-tiered cut plan (``analyze_video``):
    Pro's high thinking or Scout's medium. Anything below medium is priced as
    medium — no measurement, and over- beats under-stating the advice."""
    from packages.video import quality

    effort = (quality.engine_effort(engine) or "").strip().lower()
    return CUT_PLAN_OUTPUT_TOKENS if effort in ("high", "max", "xhigh", "") else CUT_PLAN_OUTPUT_TOKENS_MEDIUM

#: ── per-call safety caps (``ModeProfile.output_cap``, 2026-10-01) ──────────
#: Runaway protection, never a budget — an answer cut off at one has no use
#: at all.
#:
#: ``MODEL_MAX`` (0): the model's OWN maximum output, for the single calls a
#: whole step rests on — the cut plan (analyze-video / analyze-frames), the
#: AI re-cut, the speech selector and its span trims. Any number of ours
#: below it could make a legitimately large job (long footage, many cuts,
#: alternates, long thinking) impossible on every plan. Read from LiteLLM's
#: model metadata, not typed in: gemini-3.8-flash, gemini-3.7-flash and
#: gemini-3.1-pro-preview all report max_output_tokens 65,536 (LiteLLM
#: 1.100.1), matching Google's model pages ("Output token limit 65,536",
#: ai.google.dev/gemini-api/docs/models/gemini-3.8-flash and …/gemini-3.7-flash).
#: Measured cut-plan outputs, thinking included: 17,732 / 27,216 / 24,141
#: (2026-09-29), 19,477 / 19,097 / 29,464+ (2026-10-01; the last one cut off
#: at the old estimate-derived cap).
MODEL_MAX = 0
#: The inherently small calls: effects placement (output p99 1,916, n=272 —
#: three arrays of a few numbers each, the schema allows nothing else), style
#: distillation (p99 900), plan-dub's cut list (p99 ~3.1k) — 2026-09-22
#: profile. 16,000 is 5-17x the worst seen; an answer that long is a runaway.
DEFAULT_OUTPUT_CAP = 16_000

#: Video tokens per second the VENDOR really bills, measured — what the per-
#: call guard prices a video part at (``vendor_video_tokens``). Standard
#: (~1 fps): 24,496 input tokens on a 291.7 s proxy less its ~6k prompt
#: (packages/video/quality.py, 2026-09-07) = 63.4/s; production run b8ad8c25
#: (2026-10-01): 27,673 input on 331.8 s ≈ 65/s after its prompt. High (5 fps):
#: 328.2-329.0/s on three production runs (docs/unit-economics.md §4.1).
#: ``VIDEO_TOKENS_PER_SEC`` (100 / 300) stays the ESTIMATE's figure — it also
#: sizes the one-request footage caps (limits.py) — so the advice is unchanged.
VENDOR_VIDEO_TOKENS_PER_SEC: dict[str, int] = {"standard": 66, "high": 330}

#: Transcript tokens the speech planners read per second of audio. Deliberately
#: generous for Thai: Scribe returns roughly 3-4 syllables a second and Gemini
#: spends 1-2 tokens on each, so the honest figure is nearer 5-8.
TRANSCRIPT_TOKENS_PER_SEC = 15.0

#: ── speech_highlights' fan-out ───────────────────────────────────────────────
#: How many picks ``select_highlights`` is assumed to return, and therefore how
#: many ``trim_span_content`` calls follow it. Nothing in the pipeline fixes
#: this: the prompt's ``<how_many>`` block explicitly refuses to name a number
#: ("if the recording holds thirty of them, return thirty"), the only gate in
#: code is ``MIN_HIGHLIGHT_SCORE``, and ``HIGHLIGHT_RUNAWAY_CEILING`` (60) is a
#: malformed-response guard applied AFTER the trim calls have already gone out.
#:
#: So it is assumed from the one thing the server knows at start: how long the
#: recording is. One pick a minute is above what real runs produce (picks are
#: non-overlapping spans that each carry their own setup and landing, so a
#: minute apiece is close to the physical maximum), and being above it is the
#: point — an estimate too low makes the ceiling too small and the run dies
#: mid-way with ``RunBudgetExceeded``, while one too high only inflates a
#: percentage on a screen.
PICK_SECONDS = 60.0
#: Floor: even a two-minute recording pays the selector plus a few trims.
MIN_EXPECTED_PICKS = 3
#: Ceiling: past this the transcript share per call has shrunk to noise and
#: each further pick would add a whole fixed prompt for a span that, on any
#: real recording, is not there. A long podcast is priced at 24 highlights.
MAX_EXPECTED_PICKS = 24

MODE_PROFILES: dict[str, ModeProfile] = {
    "analyze_video": ModeProfile(prompt_in=6_000, max_output=CUT_PLAN_OUTPUT_TOKENS, uses_video=True,
                                   output_cap=MODEL_MAX),
    "analyze_frames": ModeProfile(
        prompt_in=6_000, max_output=CUT_PLAN_OUTPUT_TOKENS, uses_frames=True, model="vision",
        output_cap=MODEL_MAX,
    ),
    "reedit": ModeProfile(
        prompt_in=6_000, max_output=CUT_PLAN_OUTPUT_TOKENS, uses_video=True, model="reedit",
        output_cap=MODEL_MAX,
    ),
    "plan_dub": ModeProfile(prompt_in=8_000, max_output=4_000, model="text"),
    "voiceover": ModeProfile(prompt_in=8_000, max_output=4_000, model="text"),
    # ── the three speech modes, one profile each (e2) ────────────────────────
    # talking_head: Scribe, then arithmetic. `plan_core` imports no gateway and
    # `build_silence_gaps` replaced the reviewer model, so there is no model
    # call to price — only the audio. `max_output` is kept at a sane figure
    # because `guard.meter_for_run` reads it as the run's default `max_tokens`;
    # `calls=0` is what makes the estimate speech-to-text alone.
    "transcribe_only": ModeProfile(
        prompt_in=0, max_output=4_000, calls=0, uses_stt=True, model="speech",
    ),
    # speech_scenes: one `speech_select._select` call over the whole transcript.
    "select_scenes": ModeProfile(
        prompt_in=4_000, max_output=4_000,
        transcript_per_sec=TRANSCRIPT_TOKENS_PER_SEC, calls=1,
        uses_stt=True, model="speech", output_cap=MODEL_MAX,
    ),
    # speech_highlights: the selector (whole transcript in, a pick list out —
    # 6,000 because that list carries title/why/opensWith/endsWith per pick and
    # 4,000 could truncate a long recording's answer), then one span-trim call
    # per surviving pick.
    "select_highlights": ModeProfile(
        prompt_in=4_000, max_output=6_000,
        transcript_per_sec=TRANSCRIPT_TOKENS_PER_SEC, calls=1,
        uses_stt=True, model="speech", output_cap=MODEL_MAX,
        fanout=FanoutPass(prompt_in=3_000, max_output=2_500),
    ),
    # Legacy: the kind every speech mode used to be priced at. Nothing writes
    # it any more, but a resume ticket stored before e2 still names it
    # (`video_projects.resume_state.kind`, and `_STAGE_KIND`'s fallback in
    # routers/videos_local.py), and `resume.estimate_for` returns None for a
    # kind it cannot find — which makes POST /videos/{uid}/resume answer 409
    # instead of resuming. So it stays, priced as the DEAREST of the three it
    # used to cover: an old ticket may be over-priced, never under-priced into
    # a ceiling that stops the run it is resuming.
    "transcribe_audio": ModeProfile(
        prompt_in=4_000, max_output=6_000,
        transcript_per_sec=TRANSCRIPT_TOKENS_PER_SEC, calls=1,
        uses_stt=True, model="speech", output_cap=MODEL_MAX,
        fanout=FanoutPass(prompt_in=3_000, max_output=2_500),
    ),
    # The server-render chain for talking_head (routers/videos.py). Same shape
    # as `transcribe_only`: ingest → transcribe → plan_edit → render, and
    # `plan_edit` is the same `build_talking_head_timeline`. No model call.
    "server_pipeline": ModeProfile(
        prompt_in=0, max_output=4_000, calls=0, uses_stt=True, model="text",
    ),
    "plan_effects": ModeProfile(prompt_in=4_000, max_output=2_000, uses_video=True, model="effects"),
    "distill_style": ModeProfile(prompt_in=3_000, max_output=1_500, uses_video=True, model="effects"),
}

#: The wizard knows the mode, not the route it will call. The three speech
#: modes share ONE route (POST /videos/{uid}/transcribe-audio) and used to
#: share one kind with it; they now price separately because they run entirely
#: different work behind it.
KIND_FOR_MODE: dict[str, str] = {
    "dub_first": "analyze_video",
    "highlight": "analyze_video",
    "talking_head": "transcribe_only",
    "speech_scenes": "select_scenes",
    "speech_highlights": "select_highlights",
}


@dataclass(frozen=True)
class Estimate:
    tokens: int
    ceiling: int
    media_sec: float
    kind: str
    model: str
    estimator_version: str = ESTIMATOR_VERSION
    rate_version: str = rate_card.CURRENT_RATE_VERSION


def kind_for(kind: str | None, mode: str | None) -> str:
    if kind:
        if kind not in MODE_PROFILES:
            raise ValueError(f"unknown kind: {kind}")
        return kind
    found = KIND_FOR_MODE.get(mode or "")
    if found is None:
        raise ValueError(f"unknown mode: {mode}")
    return found


def model_for(role: ModelRole, engine: str | None) -> str:
    """The model the call site behind ``role`` will run (see ``ModelRole``).
    Pricing a run at another model's rates made the per-call guard stop it
    before its first request whenever the call site's model was dearer."""
    from packages.llm import config as llm_config
    from packages.video import quality

    if role == "vision":
        return llm_config.vision_model()
    if role == "reedit":
        return quality.reedit_model()
    if role == "effects":
        return quality.effects_model()
    if role == "speech":
        return quality.speech_model()
    if role == "text":
        return llm_config.text_model()
    return quality.engine_model(engine)


def video_input_tokens(seconds: float, precision: str | None) -> int:
    """Video tokens the ESTIMATE prices ``seconds`` of footage at (the owner's
    plan figures, 100 / 300 per second)."""
    per_sec = VIDEO_TOKENS_PER_SEC.get(precision or "standard", VIDEO_TOKENS_PER_SEC["standard"])
    return math.ceil(max(0.0, float(seconds or 0.0)) * per_sec)


def vendor_video_tokens(seconds: float, precision: str | None) -> int:
    """Video tokens the vendor really bills for ``seconds`` of footage at this
    sampling density (``VENDOR_VIDEO_TOKENS_PER_SEC``) — what the per-call
    guard prices a video part at, since a file part cannot be counted
    locally."""
    rates = VENDOR_VIDEO_TOKENS_PER_SEC
    per_sec = rates.get(precision or "standard", rates["standard"])
    return math.ceil(max(0.0, float(seconds or 0.0)) * per_sec)


def frame_input_tokens(clip_secs: Iterable[float]) -> int:
    from packages.video.scene import dub_sample_frame_budget

    frames = sum(
        dub_sample_frame_budget(max(0.0, float(s))) + EDGE_FRAMES_PER_CLIP for s in clip_secs if s > 0
    )
    return frames * FRAME_TOKENS


def expected_picks_for(audio_sec: float) -> int:
    """How many highlights a recording of this length is priced for.

    The number of ``trim_span_content`` calls ``select_highlights`` fans out
    into equals the number of picks the selector returned, which only exists
    after the selector has answered — long after the estimate was needed. The
    server's one honest proxy at start is the length of the audio it measured,
    which is also what a resume ticket stores (``resume.ticket``'s
    ``media_sec``), so a resumed run reprices to the same number.
    """
    picks = math.ceil(max(0.0, float(audio_sec or 0.0)) / PICK_SECONDS)
    return max(MIN_EXPECTED_PICKS, min(MAX_EXPECTED_PICKS, picks))


def estimate_run(
    *,
    kind: str | None = None,
    mode: str | None = None,
    engine: str | None = None,
    precision: str | None = None,
    clip_secs: Iterable[float] = (),
    audio_sec: float | None = None,
    model: str | None = None,
    frame_count: int | None = None,
    expected_picks: int | None = None,
) -> Estimate:
    """The estimate for one run. ``audio_sec`` defaults to the clip total
    (speech modes transcribe the clips' own audio). ``frame_count`` — images
    the request really carries (analyze-frames' uploaded frames, an image
    style reference): each is priced at ``FRAME_TOKENS``; for a frames kind it
    replaces the per-clip sampling budget. ``expected_picks`` overrides how
    many second-pass calls a fan-out kind is priced for; left out, it is
    derived from the audio length (``expected_picks_for``) — no caller knows
    better than that before the first call has answered."""
    resolved = kind_for(kind, mode)
    profile = MODE_PROFILES[resolved]
    secs = [max(0.0, float(s or 0.0)) for s in clip_secs]
    footage = sum(secs)
    audio = footage if audio_sec is None else max(0.0, float(audio_sec))
    chosen = model or model_for(profile.model, engine)

    transcript = math.ceil(profile.transcript_per_sec * audio) if profile.transcript_per_sec else 0
    prompt = profile.prompt_in + transcript
    if profile.uses_video:
        prompt += video_input_tokens(footage, precision)
    if frame_count is not None:
        prompt += max(0, int(frame_count)) * FRAME_TOKENS
    elif profile.uses_frames:
        prompt += frame_input_tokens(secs)

    output = cut_plan_output_for(engine) if resolved == "analyze_video" else profile.max_output
    llm = rate_card.tokens_for_llm(chosen, prompt, 0, output) * profile.calls
    fan = profile.fanout
    if fan is not None:
        picks = expected_picks_for(audio) if expected_picks is None else max(0, int(expected_picks))
        if picks:
            # Each call reads its own span, and the spans do not overlap, so
            # the transcript is split between them rather than repeated.
            share = math.ceil(transcript / picks) if fan.splits_transcript else transcript
            llm += rate_card.tokens_for_llm(chosen, fan.prompt_in + share, 0, fan.max_output) * picks
    stt = rate_card.tokens_for_stt(audio) if profile.uses_stt else 0
    tokens = llm + stt
    return Estimate(
        tokens=tokens,
        ceiling=math.ceil(tokens * CEILING_RATIO),
        media_sec=round(max(footage, audio), 3),
        kind=resolved,
        model=chosen,
    )


def clip_seconds_from_meta(local_meta: Any) -> list[float]:
    """Clip durations as stored at project creation
    (``video_projects.local_meta.clips``) — what the CLIENT stated. Display
    only; never a pricing source (a start route measures the files)."""
    clips = local_meta.get("clips") if isinstance(local_meta, dict) else None
    out: list[float] = []
    for clip in clips or []:
        if isinstance(clip, dict):
            try:
                out.append(max(0.0, float(clip.get("durationSec") or 0.0)))
            except (TypeError, ValueError):
                continue
    return out
