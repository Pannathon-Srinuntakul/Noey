"""The rate card: vendor usage → our tokens (the unit a user's limits are in).

Owner-approved 2026-09-22 (docs/token-billing-plan.md §1). The peg is
1M of our tokens = ฿50 of vendor cost at the 2027 list prices and ฿34.5/USD,
so each rate is ``vendor $/1M × 34.5 ÷ 50``:

    Flash  in  $1.50 → 1.035     out  $7.50 → 5.175
    Pro    in  $2    → 1.38      out $12    → 8.28     (prompt ≤200k)
           in  $4    → 2.76      out $18    → 12.42    (prompt >200k)
    Scribe v2 $0.22/h + $0.05/h keyterms = $0.27/h → 186,300 per hour = 51.75/s

The card is FIXED on purpose. A user must never feel their limit drain faster
because the baht moved or a vendor changed a price, so nothing here reads FX
or the admin's vendor price table — those price the *real* cost
(packages/billing/vendor_cost.py), which only moves our margin.

Forward-only versioning: a change is a new ``RATE_CARDS`` key plus a bump of
``CURRENT_RATE_VERSION``, never an edit of an existing card. Every usage row
stores the version it was charged at, so history stays explainable.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Literal

Family = Literal["flash", "pro"]


@dataclass(frozen=True)
class LlmRate:
    """Our tokens per vendor token."""

    input: float
    output: float
    #: Rates for a call whose prompt is above ``long_threshold`` vendor tokens.
    #: Gemini bills the WHOLE call at the long rate in that case, not just the
    #: part past the threshold, so the card does the same.
    input_long: float | None = None
    output_long: float | None = None
    long_threshold: int | None = None

    def rates_for(self, prompt_tokens: int) -> tuple[float, float]:
        if (
            self.long_threshold is not None
            and prompt_tokens > self.long_threshold
            and self.input_long is not None
            and self.output_long is not None
        ):
            return self.input_long, self.output_long
        return self.input, self.output


@dataclass(frozen=True)
class RateCard:
    version: str
    llm: Mapping[str, LlmRate]
    #: Cached input is charged at this share of the model's input rate.
    cached_ratio: float
    #: Our tokens per billed audio second (keyterms surcharge included).
    stt_per_sec: float


RATE_CARDS: Mapping[str, RateCard] = MappingProxyType(
    {
        "v1": RateCard(
            version="v1",
            llm=MappingProxyType(
                {
                    "flash": LlmRate(input=1.035, output=5.175),
                    "pro": LlmRate(
                        input=1.38, output=8.28,
                        input_long=2.76, output_long=12.42, long_threshold=200_000,
                    ),
                }
            ),
            cached_ratio=0.10,
            stt_per_sec=51.75,
        ),
    }
)

#: The card new usage is charged at. Forward-only: never point it back.
CURRENT_RATE_VERSION = "v1"

# Money constants (satang per 1M of our tokens). Code, not DB: the admin may
# edit the reference/sell figures it DISPLAYS margins with, but what a user is
# actually charged comes from here.
REFERENCE_COST_SATANG_PER_1M = 5_000   # ฿50 — the peg above
SELL_SATANG_PER_1M = 25_000            # ฿250 — every plan
TOPUP_SATANG_PER_1M = 35_000           # ฿350 — pay-as-you-go balance


def card(version: str | None = None) -> RateCard:
    """The card for ``version`` (default: current). KeyError on an unknown one."""
    return RATE_CARDS[version or CURRENT_RATE_VERSION]


def bare_model(model: str | None) -> str:
    """``gemini/gemini-3.7-flash`` → ``gemini-3.7-flash``."""
    return (model or "").rsplit("/", 1)[-1].strip().lower()


def family_for(model: str | None) -> Family:
    """Which rate a model id is charged at.

    Unknown ids are charged as Pro: a guess on the dear side reads as "this
    cost something", while a cheap guess would quietly under-charge — the same
    rule as the speech-to-text fallback.
    """
    name = bare_model(model)
    if "flash" in name:
        return "flash"
    return "pro"


def tokens_for_llm(
    model: str | None,
    input_tokens: int,
    cached_tokens: int,
    output_tokens: int,
    version: str | None = None,
) -> int:
    """Our tokens for one model call.

    ``input_tokens`` is the whole prompt as the vendor reports it, cached part
    included; ``cached_tokens`` is the part served from cache, charged at
    ``cached_ratio`` of the input rate. Output includes thinking — Gemini bills
    thinking as output. Rounded up once per call.
    """
    rc = card(version)
    rate = rc.llm[family_for(model)]
    inp = max(0, int(input_tokens or 0))
    cached = min(max(0, int(cached_tokens or 0)), inp)
    out = max(0, int(output_tokens or 0))
    rate_in, rate_out = rate.rates_for(inp)
    raw = (inp - cached) * rate_in + cached * rate_in * rc.cached_ratio + out * rate_out
    return _ceil(raw)


def tokens_for_stt(billed_sec: float, version: str | None = None) -> int:
    """Our tokens for ``billed_sec`` seconds of transcribed audio.

    The keyterms surcharge is already inside the per-second rate; whether a
    request sent keyterms changes only its real cost, never the charge.
    """
    sec = float(billed_sec or 0.0)
    if sec <= 0:
        return 0
    return _ceil(sec * card(version).stt_per_sec)


def _ceil(value: float) -> int:
    # Float noise (1.035 × 1_000_000 = 1034999.9999…) must not round a whole
    # figure up by one token, so snap to 6 decimals before the ceiling.
    return max(0, math.ceil(round(value, 6)))


def describe(version: str | None = None) -> dict[str, object]:
    """The card as plain data (admin read-only view)."""
    rc = card(version)
    return {
        "version": rc.version,
        "llm": {
            fam: {
                "input": r.input,
                "output": r.output,
                "input_long": r.input_long,
                "output_long": r.output_long,
                "long_threshold": r.long_threshold,
            }
            for fam, r in rc.llm.items()
        },
        "cached_ratio": rc.cached_ratio,
        "stt_per_sec": rc.stt_per_sec,
        "reference_thb_per_1m": REFERENCE_COST_SATANG_PER_1M / 100,
        "sell_thb_per_1m": SELL_SATANG_PER_1M / 100,
        "topup_thb_per_1m": TOPUP_SATANG_PER_1M / 100,
    }
