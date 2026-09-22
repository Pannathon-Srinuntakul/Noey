"""The owner-edited vendor prices and cost assumptions.

Stored as one JSON document (``core.admin_settings`` key ``cost_config``).
Two readers:

- the usage recorder (packages/billing/vendor_cost.py) prices every vendor
  request into ``cost_thb`` at the moment it is recorded, from ``models`` /
  ``stt`` and the current USD→THB rate (packages/billing/fx.py);
- the dashboard's money module (admin app) adds the owner's fixed monthly
  costs and per-user extras, and prices legacy rows recorded before
  ``cost_thb`` existed.

Nothing here decides what a USER is charged — that is the fixed rate card
(packages/billing/rate_card.py). A price edit moves our margin only.

Model keys are bare model ids (``gemini-3.7-flash``): usage rows may carry a
provider prefix (``gemini/…``), which ``model_key`` strips.
"""

from __future__ import annotations

from datetime import date
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, StringConstraints, field_validator, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.db.models.admin import AdminSetting

SETTING_KEY = "cost_config"

ItemId = Annotated[str, StringConstraints(min_length=1, max_length=40, pattern=r"^[A-Za-z0-9_\-]+$")]
Label = Annotated[str, StringConstraints(max_length=80, strip_whitespace=True)]
ModelKey = Annotated[str, StringConstraints(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_.:\-]+$")]
SttKey = Annotated[str, StringConstraints(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.\-]+$")]


class ModelPrice(BaseModel):
    """USD per 1M vendor tokens, as the vendor's price list states it."""

    input: float = Field(ge=0, le=1000)
    output: float = Field(ge=0, le=1000)
    #: A dearer tier for a call whose prompt is above ``long_threshold``
    #: tokens (Gemini 3.1 Pro: >200k). The whole call is billed at it.
    input_long: float | None = Field(default=None, ge=0, le=1000)
    output_long: float | None = Field(default=None, ge=0, le=1000)
    long_threshold: int | None = Field(default=None, gt=0, le=10_000_000)
    #: Cached input costs this share of ``input``.
    cached_ratio: float = Field(default=0.10, ge=0, le=1)
    #: This price holds THROUGH ``until`` (inclusive); ``then`` applies after.
    #: A dated schedule, so a known future change (Flash's promo ending
    #: 2026-12-31) needs no one to remember to edit the table that night.
    until: date | None = None
    then: ModelPrice | None = None

    def at(self, day: date) -> ModelPrice:
        """The price in force on ``day`` (follows the schedule)."""
        price = self
        for _ in range(10):  # a schedule deeper than this is a mistake, not a plan
            if price.until is not None and day > price.until and price.then is not None:
                price = price.then
                continue
            break
        return price

    def rates_usd(self, prompt_tokens: int) -> tuple[float, float]:
        """(input, output) USD per 1M for a call with this many prompt tokens."""
        if (
            self.long_threshold is not None
            and prompt_tokens > self.long_threshold
            and self.input_long is not None
            and self.output_long is not None
        ):
            return self.input_long, self.output_long
        return self.input, self.output


ModelPrice.model_rebuild()  # resolve the self-reference in `then`


class SttModelPrice(BaseModel):
    """Pay-as-you-go speech-to-text: USD per hour of billed audio."""

    usd_per_hour: float = Field(ge=0, le=1000)
    #: Surcharge per hour when the request sends keyterms (the worker sends
    #: the project's product names on every transcription).
    keyterms_usd_per_hour: float = Field(default=0.0, ge=0, le=1000)


class FixedItem(BaseModel):
    id: ItemId
    label: Label
    #: THB per month.
    value: float = Field(ge=0, le=10_000_000)


class PerUserItem(BaseModel):
    id: ItemId
    label: Label
    #: THB per user per month ("user") or per finished clip ("clip").
    value: float = Field(ge=0, le=100_000)
    basis: Literal["user", "clip"]


# The pre-2026-09-22 defaults. They were never real list prices (see
# docs/token-billing-plan.md §5), so a stored document still carrying one of
# them exactly is upgraded to the correct default rather than kept.
_STALE_DEFAULTS: dict[str, tuple[float, float]] = {
    "gemini-3.1-pro-preview": (1.25, 5.00),
    "gemini-3.8-flash": (0.30, 2.50),
    "gemini-3.7-flash": (0.15, 1.20),
}


def upgrade_legacy_document(data: Any) -> Any:
    """Turn a document saved by the old admin (STT as a credit package) into
    the current shape, so a saved config never fails validation.

    Only a LEGACY document is touched (``stt`` holding ``credits_per_hour``):
    its STT package becomes the pay-as-you-go default, stale default model
    prices become the real ones, and VAT goes off (owner decision 2026-09-22).
    Anything the owner edited away from a stale default is kept.
    """
    if not isinstance(data, dict):
        return data
    stt = data.get("stt")
    if not (isinstance(stt, dict) and "credits_per_hour" in stt):
        return data
    out = dict(data)
    out["stt"] = {k: v.model_dump(mode="json") for k, v in DEFAULT_COST_CONFIG.stt.items()}
    models = dict(out.get("models") or {})
    for key, stale in _STALE_DEFAULTS.items():
        price = models.get(key)
        if isinstance(price, dict) and (price.get("input"), price.get("output")) == stale:
            models[key] = DEFAULT_COST_CONFIG.models[key].model_dump(mode="json")
    out["models"] = models
    out["vat_included"] = False
    return out


class CostConfig(BaseModel):
    #: Manual USD→THB fallback, used only when there is neither an admin
    #: override nor a fetched rate from the last 7 days (packages/billing/fx.py).
    fx_rate: float = Field(ge=1, le=200)
    models: dict[ModelKey, ModelPrice] = Field(max_length=60)
    stt: dict[SttKey, SttModelPrice] = Field(max_length=20)
    fixed: list[FixedItem] = Field(max_length=40)
    per_user: list[PerUserItem] = Field(max_length=40)
    #: Plan prices include 7% VAT (revenue is shown net of it). Off: the owner
    #: is an individual below the ฿1.8M/year threshold, not VAT-registered.
    vat_included: bool = False
    #: Count admin (owner) accounts in totals.
    include_internal: bool = True

    @field_validator("fixed", "per_user")
    @classmethod
    def _unique_ids(cls, items: list) -> list:  # type: ignore[type-arg]
        ids = [item.id for item in items]
        if len(ids) != len(set(ids)):
            raise ValueError("item ids must be unique")
        return items

    @model_validator(mode="before")
    @classmethod
    def _upgrade_legacy(cls, data: Any) -> Any:
        return upgrade_legacy_document(data)


_FLASH = ModelPrice(
    input=0.75, output=3.75, until=date(2026, 12, 31), then=ModelPrice(input=1.50, output=7.50)
)
_PRO = ModelPrice(input=2.00, output=12.00, input_long=4.00, output_long=18.00, long_threshold=200_000)

DEFAULT_COST_CONFIG = CostConfig(
    fx_rate=34.5,
    models={
        "gemini-3.1-pro-preview": _PRO,
        "gemini-3.8-flash": _FLASH,
        "gemini-3.7-flash": _FLASH,
    },
    stt={"scribe_v2": SttModelPrice(usd_per_hour=0.22, keyterms_usd_per_hour=0.05)},
    fixed=[
        FixedItem(id="server", label="เซิร์ฟเวอร์ (Railway)", value=980),
        FixedItem(id="storage", label="ที่เก็บไฟล์ (Cloudflare R2)", value=120),
        FixedItem(id="misc", label="โดเมนและอื่นๆ", value=90),
    ],
    per_user=[
        PerUserItem(id="sms", label="SMS OTP", value=1.50, basis="user"),
        PerUserItem(id="smtp", label="อีเมลแจ้งเตือน (SMTP)", value=0.35, basis="clip"),
    ],
    vat_included=False,
    include_internal=True,
)

#: Used for a model the owner has not priced: the dearest list price we know,
#: because an under-estimate reads as "nearly free" — the wrong way to be wrong.
FALLBACK_MODEL_PRICE = _PRO
FALLBACK_STT_PRICE = SttModelPrice(usd_per_hour=0.40, keyterms_usd_per_hour=0.05)

def model_key(model: str | None) -> str:
    """``gemini/gemini-3.7-flash`` → ``gemini-3.7-flash``."""
    return (model or "unknown").rsplit("/", 1)[-1][:128] or "unknown"


def default_model_price(key: str) -> ModelPrice:
    """A starting price for a model the owner has not priced yet."""
    found = DEFAULT_COST_CONFIG.models.get(key)
    return (found or FALLBACK_MODEL_PRICE).model_copy(deep=True)


def model_price(config: CostConfig, model: str | None) -> ModelPrice:
    """The owner's price for a (possibly prefixed) model id, else a default."""
    key = model_key(model)
    return config.models.get(key) or default_model_price(key)


def stt_price(config: CostConfig, model: str | None) -> SttModelPrice:
    return config.stt.get(model or "") or DEFAULT_COST_CONFIG.stt.get(model or "") or FALLBACK_STT_PRICE


def known_stt_prices() -> dict[str, dict[str, float]]:
    """Default per-hour prices per speech-to-text model (admin starting values)."""
    return {k: v.model_dump() for k, v in DEFAULT_COST_CONFIG.stt.items()}


async def load_cost_config(session: AsyncSession) -> CostConfig:
    found = await session.execute(select(AdminSetting).where(AdminSetting.key == SETTING_KEY))
    row = found.scalar_one_or_none()
    if row is None:
        return DEFAULT_COST_CONFIG.model_copy(deep=True)
    return CostConfig.model_validate(row.value)


async def save_cost_config(session: AsyncSession, config: CostConfig, actor_id: int) -> None:
    found = await session.execute(
        select(AdminSetting).where(AdminSetting.key == SETTING_KEY).with_for_update()
    )
    row = found.scalar_one_or_none()
    value = config.model_dump(mode="json")
    if row is None:
        session.add(AdminSetting(key=SETTING_KEY, value=value, updated_by=actor_id))
    else:
        row.value = value
        row.updated_by = actor_id
    await session.flush()
