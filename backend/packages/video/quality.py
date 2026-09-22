"""User-facing AI quality tiers → provider settings.

Two independent dials a project carries:

    Engine     "lite" | "pro"        — which model decides the cut
    Precision  "standard" | "high"   — how densely it samples the footage

The names are deliberately vendor-neutral. Nothing a user reads may name the
provider or a frame rate (project rule: the UI never names an AI vendor), so
the tier→provider mapping lives here and nowhere else — API, worker and probe
scripts all resolve through these functions rather than each knowing a model id.

Measured 2026-09-07 on the 291.7s คาร์โก้ proxy, same prompts, fps the only
variable:

    standard (~1 fps)   24,496 input tokens   13 cuts   avg 2.31s
    high     (5 fps)   101,452 input tokens   15 cuts   avg 1.89s

Only 7 of those cuts were the same moment: denser sampling does not merely
sharpen the timestamps, it surfaces moments the sparse pass never saw (at 1 fps
every chosen timestamp lands on a whole second — that is the entire menu it
had). Timestamp error against PySceneDetect ground truth on a 26.7s clip:
±0.42s at 1 fps vs ±0.08s at 5 fps.

Ceilings, both measured:
  * ~40 minutes of footage at high precision before Gemini's 1M context fills
    (~330 tokens per second of video; standard is ~66).
  * High precision is safe ONLY on the downscaled proxies every caller already
    uploads. The same footage at 1080x1920 and >=8 fps is refused outright with
    promptFeedback.blockReason=PROHIBITED_CONTENT, which safety_settings cannot
    turn off. See packages/llm/files.py:gemini_video_block.
"""

from __future__ import annotations

from typing import Literal

Engine = Literal["lite", "pro"]
Precision = Literal["standard", "high"]

ENGINES: tuple[str, ...] = ("lite", "pro")
PRECISIONS: tuple[str, ...] = ("standard", "high")

# What a project gets when it says nothing: today's behaviour exactly.
DEFAULT_ENGINE = "pro"
DEFAULT_PRECISION = "standard"


def normalize_engine(value: str | None) -> str:
    """Coerce stored/request input to a known engine, never raising.

    An unknown value degrades to the default rather than failing a render — the
    same rule DUB_PROMPT_VERSION follows, and for the same reason: a typo in a
    stored row must not be able to take a paying user's job down.
    """
    v = (value or "").strip().lower()
    return v if v in ENGINES else DEFAULT_ENGINE


def normalize_precision(value: str | None) -> str:
    v = (value or "").strip().lower()
    return v if v in PRECISIONS else DEFAULT_PRECISION


def engine_model(engine: str | None) -> str:
    """Model id for an engine tier. "pro" falls through to DUB_VISION_MODEL so
    the existing env override keeps working and nothing changes for projects
    that never picked a tier."""
    from packages.core.settings import get_settings

    s = get_settings()
    if normalize_engine(engine) == "lite":
        return s.dub_engine_lite or s.dub_vision_model
    return s.dub_engine_pro or s.dub_vision_model


def precision_fps(precision: str | None) -> int:
    """Frame sampling rate for a precision tier. 0 = the provider default
    (~1 fps), i.e. no video_metadata attached at all."""
    from packages.core.settings import get_settings

    if normalize_precision(precision) == "high":
        return max(0, int(get_settings().dub_precision_high_fps))
    return 0


def resolve(engine: str | None, precision: str | None) -> tuple[str, int]:
    """(model_id, fps) for a project's stored tiers."""
    return engine_model(engine), precision_fps(precision)


# ── the model each non-tiered call site uses ─────────────────────────────────
#
# One resolver per call site, imported by the call site AND by the billing
# estimator (packages/billing/estimate.py:model_for). The estimate prices its
# reservation at the model that will actually run: when the two disagreed
# (Flash priced, Pro called) the per-call guard stopped every run before its
# first request.


def reedit_model() -> str:
    """AI re-edit of a dub edit script (dub_ai.generate_dub_reedit_script_video)."""
    from packages.core.settings import get_settings

    return get_settings().dub_vision_model


def speech_model() -> str:
    """Speech-mode scene / highlight selection (speech_select)."""
    from packages.core.settings import get_settings

    s = get_settings()
    return getattr(s, "speech_select_model", "") or s.dub_vision_model


def effects_model() -> str:
    """Effects placement and effects-style distillation."""
    from packages.core.settings import get_settings

    return get_settings().effects_vision_model


def cut_style_model() -> str:
    """Cut-style distillation (cut_style.distill_cut_style_prompt)."""
    from packages.core.settings import get_settings

    return get_settings().dub_vision_model
