"""Effective runtime config = DB app_settings overlaid on env defaults."""

from sqlalchemy.ext.asyncio import AsyncSession

from packages.core.settings import get_settings
from packages.db.models import AppSetting


async def get_or_create_setting(session: AsyncSession) -> AppSetting:
    row = await session.get(AppSetting, 1)
    if row is None:
        row = AppSetting(id=1)
        session.add(row)
        await session.flush()
    return row


async def effective_llm(session: AsyncSession) -> dict[str, str | None]:
    """Effective LLM model + base_url (DB if set, else env)."""
    row = await get_or_create_setting(session)
    s = get_settings()
    return {
        "model": row.llm_model or s.llm_model,
        "base_url": row.llm_base_url or s.llm_base_url,
    }
