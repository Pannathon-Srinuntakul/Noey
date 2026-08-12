"""What a transcription costs, in ElevenLabs credits.

Scribe returns no price and no credit field, so the rate has to come from
somewhere. These numbers were **measured against the live account** on
2026-08-12 by transcribing clips of known length and diffing the account's
credit total (`scripts/probe_stt_cost.py`):

    scribe_v2     1385 credits /   1245.3s  →  4,004 credits/hour
    scribe_v2_5   6359 credits /    457.9s  → 49,994 credits/hour

Two 5s and 17s probes then matched `ceil(seconds × rate)` exactly (6 and 19
credits), which is why the rounding below is a ceiling per run rather than a
plain multiplication.

The 12.5× gap between the two models is the single biggest lever on
speech-to-text cost — it dominates anything else in this pipeline — so the
model is stored per run and never assumed.
"""

from __future__ import annotations

import math

# Credits per hour of audio, per model id.
STT_CREDITS_PER_HOUR: dict[str, float] = {
    "scribe_v2": 4000.0,
    "scribe_v2_5": 50000.0,
}

# Used when a row predates the model column, or names a model not measured yet.
# The cheaper rate is the wrong one to guess with — an under-estimate reads as
# "this was nearly free" — so unknown models are priced at the higher rate.
_FALLBACK_CREDITS_PER_HOUR = 50000.0


def credits_for(audio_sec: float, model: str) -> int:
    """Credits one run of ``audio_sec`` seconds costs on ``model``.

    Rounds up: every probe showed ElevenLabs charging the ceiling of the
    fractional credit, so rounding down would quietly under-report.
    """
    if audio_sec <= 0:
        return 0
    rate = STT_CREDITS_PER_HOUR.get(model, _FALLBACK_CREDITS_PER_HOUR)
    return math.ceil(audio_sec * rate / 3600.0)


def is_rate_known(model: str) -> bool:
    """Whether ``model`` has a measured rate, or is being estimated."""
    return model in STT_CREDITS_PER_HOUR
