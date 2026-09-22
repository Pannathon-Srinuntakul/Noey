"""Pre-flight estimate of one AI run, in rate-card tokens. Server-side only.

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
    stt        = rate_card.tokens_for_stt(audio_sec)             # transcribing kinds
    llm        = tokens_for_llm(model,
                    video_in + frames_in + prompt_in + transcript_per_sec × audio_sec,
                    0, max_output) × calls
    estimate   = llm + stt;  ceiling = ceil(estimate × 1.2)

Profiles (``ESTIMATOR_VERSION = "e1"``), measured 2026-09-22 with
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
for — above p90 everywhere, but NOT the dub p99 (24.9k: runaway thinking),
which would reserve 5× the typical cost. The per-call guard's
``max_tokens`` must agree with ``max_output`` (CORE-B, design §6.2).
Video tokens use the owner's plan figures (100 / 300 per second); the
2026-09-07 measurement in packages/video/quality.py was ~84 / ~348.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any, Literal

from packages.billing import rate_card

ESTIMATOR_VERSION = "e1"
CEILING_RATIO = 1.2

VIDEO_TOKENS_PER_SEC: dict[str, int] = {"standard": 100, "high": 300}
#: Gemini bills one image at 258 tokens.
FRAME_TOKENS = 258
EDGE_FRAMES_PER_CLIP = 2

Kind = Literal[
    "analyze_video",
    "analyze_frames",
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
class ModeProfile:
    prompt_in: int
    max_output: int
    #: Transcript tokens fed to the planner per second of audio.
    transcript_per_sec: float = 0.0
    calls: int = 1
    uses_video: bool = False
    uses_frames: bool = False
    uses_stt: bool = False
    model: ModelRole = "engine"


MODE_PROFILES: dict[str, ModeProfile] = {
    "analyze_video": ModeProfile(prompt_in=6_000, max_output=8_000, uses_video=True),
    "analyze_frames": ModeProfile(prompt_in=6_000, max_output=8_000, uses_frames=True, model="vision"),
    "reedit": ModeProfile(prompt_in=6_000, max_output=8_000, uses_video=True, model="reedit"),
    "plan_dub": ModeProfile(prompt_in=8_000, max_output=4_000, model="text"),
    "voiceover": ModeProfile(prompt_in=8_000, max_output=4_000, model="text"),
    # Selector + span-trim / tightening passes over the transcript.
    "transcribe_audio": ModeProfile(
        prompt_in=4_000, max_output=4_000, transcript_per_sec=15.0, calls=2,
        uses_stt=True, model="speech",
    ),
    "server_pipeline": ModeProfile(
        prompt_in=4_000, max_output=4_000, transcript_per_sec=15.0, calls=2,
        uses_stt=True, model="text",
    ),
    "plan_effects": ModeProfile(prompt_in=4_000, max_output=2_000, uses_video=True, model="effects"),
    "distill_style": ModeProfile(prompt_in=3_000, max_output=1_500, uses_video=True, model="effects"),
}

#: The wizard knows the mode, not the route it will call.
KIND_FOR_MODE: dict[str, str] = {
    "dub_first": "analyze_video",
    "highlight": "analyze_video",
    "talking_head": "transcribe_audio",
    "speech_scenes": "transcribe_audio",
    "speech_highlights": "transcribe_audio",
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
    """Video tokens for ``seconds`` of footage — also what a video call site
    passes the per-call guard, since a file part cannot be counted locally."""
    per_sec = VIDEO_TOKENS_PER_SEC.get(precision or "standard", VIDEO_TOKENS_PER_SEC["standard"])
    return math.ceil(max(0.0, float(seconds or 0.0)) * per_sec)


def frame_input_tokens(clip_secs: Iterable[float]) -> int:
    from packages.video.scene import dub_sample_frame_budget

    frames = sum(
        dub_sample_frame_budget(max(0.0, float(s))) + EDGE_FRAMES_PER_CLIP for s in clip_secs if s > 0
    )
    return frames * FRAME_TOKENS


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
) -> Estimate:
    """The estimate for one run. ``audio_sec`` defaults to the clip total
    (speech modes transcribe the clips' own audio). ``frame_count`` — images
    the request really carries (analyze-frames' uploaded frames, an image
    style reference): each is priced at ``FRAME_TOKENS``; for a frames kind it
    replaces the per-clip sampling budget."""
    resolved = kind_for(kind, mode)
    profile = MODE_PROFILES[resolved]
    secs = [max(0.0, float(s or 0.0)) for s in clip_secs]
    footage = sum(secs)
    audio = footage if audio_sec is None else max(0.0, float(audio_sec))
    chosen = model or model_for(profile.model, engine)

    prompt = profile.prompt_in
    if profile.uses_video:
        prompt += video_input_tokens(footage, precision)
    if frame_count is not None:
        prompt += max(0, int(frame_count)) * FRAME_TOKENS
    elif profile.uses_frames:
        prompt += frame_input_tokens(secs)
    if profile.transcript_per_sec:
        prompt += math.ceil(profile.transcript_per_sec * audio)

    llm = rate_card.tokens_for_llm(chosen, prompt, 0, profile.max_output) * profile.calls
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
