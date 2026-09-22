"""The admin's DISPLAY figures for margins: reference cost and sell price per 1M.

``admin_settings`` key ``billing_config``. These only change how the admin
dashboard computes margin — what a user is charged comes from the code
constants in packages/billing/rate_card.py (the rate card is fixed and
versioned forward-only; the top-up price is read-only here).
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.billing import rate_card
from packages.db.models.admin import AdminSetting

KEY = "billing_config"


class BillingConfig(BaseModel):
    reference_thb_per_1m: float = Field(default=rate_card.REFERENCE_COST_SATANG_PER_1M / 100, gt=0, le=10_000)
    sell_thb_per_1m: float = Field(default=rate_card.SELL_SATANG_PER_1M / 100, gt=0, le=10_000)


async def load(session: AsyncSession) -> BillingConfig:
    row = (await session.execute(select(AdminSetting.value).where(AdminSetting.key == KEY))).scalar_one_or_none()
    try:
        return BillingConfig.model_validate(row or {})
    except ValueError:
        return BillingConfig()


async def save(session: AsyncSession, config: BillingConfig, actor_id: int | None) -> None:
    value = config.model_dump()
    row = (
        await session.execute(select(AdminSetting).where(AdminSetting.key == KEY).with_for_update())
    ).scalar_one_or_none()
    if row is None:
        session.add(AdminSetting(key=KEY, value=value, updated_by=actor_id))
    else:
        row.value = value
        row.updated_by = actor_id
    await session.flush()


def view(config: BillingConfig) -> dict[str, Any]:
    return {
        **config.model_dump(),
        "topup_thb_per_1m": rate_card.TOPUP_SATANG_PER_1M / 100,
        "charged_sell_thb_per_1m": rate_card.SELL_SATANG_PER_1M / 100,
        "rate_card": rate_card.describe(),
    }
