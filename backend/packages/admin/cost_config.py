"""The owner-edited cost assumptions the dashboard computes profit with.

Stored as one JSON document (``core.admin_settings`` key ``cost_config``).
Nothing here is billed or enforced — it prices the usage the logs recorded:
model $/1M tokens, the THB/USD rate, the speech-to-text package, fixed monthly
costs and per-user extras (SMS, email, …). The dashboard's first load uses
DEFAULT_COST_CONFIG until an admin saves.

Model keys are bare model ids (``gemini-3.7-flash``): usage rows may carry a
provider prefix (``gemini/…``), which ``model_key`` strips.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field, StringConstraints, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.db.models.admin import AdminSetting
from packages.llm.usage import _DEFAULT_PRICE, MODEL_PRICES
from packages.video.stt_pricing import STT_CREDITS_PER_HOUR

SETTING_KEY = "cost_config"

ItemId = Annotated[str, StringConstraints(min_length=1, max_length=40, pattern=r"^[A-Za-z0-9_\-]+$")]
Label = Annotated[str, StringConstraints(max_length=80, strip_whitespace=True)]
ModelKey = Annotated[str, StringConstraints(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_.:\-]+$")]


class ModelPrice(BaseModel):
    #: USD per 1M input / output tokens.
    input: float = Field(ge=0, le=1000)
    output: float = Field(ge=0, le=1000)


class SttConfig(BaseModel):
    model: Annotated[str, StringConstraints(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.\-]+$")]
    #: Credits one hour of audio costs on `model`.
    credits_per_hour: float = Field(gt=0, le=10_000_000)
    #: THB per month for the package.
    monthly_price: float = Field(ge=0, le=10_000_000)
    #: Credits the package includes per month.
    credits: int = Field(gt=0, le=10_000_000_000)


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


class CostConfig(BaseModel):
    fx_rate: float = Field(ge=1, le=200)
    models: dict[ModelKey, ModelPrice] = Field(max_length=60)
    stt: SttConfig
    fixed: list[FixedItem] = Field(max_length=40)
    per_user: list[PerUserItem] = Field(max_length=40)
    #: Plan prices include 7% VAT (revenue is shown net of it).
    vat_included: bool = True
    #: Count admin (owner) accounts in totals.
    include_internal: bool = True

    @field_validator("fixed", "per_user")
    @classmethod
    def _unique_ids(cls, items: list) -> list:  # type: ignore[type-arg]
        ids = [item.id for item in items]
        if len(ids) != len(set(ids)):
            raise ValueError("item ids must be unique")
        return items


DEFAULT_COST_CONFIG = CostConfig(
    fx_rate=34.5,
    models={
        "gemini-3.1-pro-preview": ModelPrice(input=1.25, output=5.00),
        "gemini-3.8-flash": ModelPrice(input=0.30, output=2.50),
        "gemini-3.7-flash": ModelPrice(input=0.15, output=1.20),
    },
    stt=SttConfig(model="scribe_v2", credits_per_hour=4000, monthly_price=790, credits=100_000),
    fixed=[
        FixedItem(id="server", label="เซิร์ฟเวอร์ (Railway)", value=980),
        FixedItem(id="storage", label="ที่เก็บไฟล์ (Cloudflare R2)", value=120),
        FixedItem(id="misc", label="โดเมนและอื่นๆ", value=90),
    ],
    per_user=[
        PerUserItem(id="sms", label="SMS OTP", value=1.50, basis="user"),
        PerUserItem(id="smtp", label="อีเมลแจ้งเตือน (SMTP)", value=0.35, basis="clip"),
    ],
    vat_included=True,
    include_internal=True,
)


def model_key(model: str | None) -> str:
    """``gemini/gemini-3.7-flash`` → ``gemini-3.7-flash``."""
    return (model or "unknown").rsplit("/", 1)[-1][:128] or "unknown"


def default_model_price(key: str) -> ModelPrice:
    """A starting price for a model the owner has not priced yet."""
    for name, (inp, out) in MODEL_PRICES.items():
        if model_key(name) == key:
            return ModelPrice(input=inp, output=out)
    inp, out = _DEFAULT_PRICE
    return ModelPrice(input=inp, output=out)


def known_stt_rates() -> dict[str, float]:
    """Measured credits/hour per speech-to-text model (packages/video/stt_pricing.py)."""
    return dict(STT_CREDITS_PER_HOUR)


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
