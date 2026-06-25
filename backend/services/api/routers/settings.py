"""User-editable settings — LLM model/endpoint (global from env + DB)."""

import os

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from packages.db.config import effective_llm, get_or_create_setting
from services.api.deps import db_session
from services.api.schemas import SettingsIn, SettingsOut

router = APIRouter(prefix="/settings", tags=["settings"])


async def _build_out(session: AsyncSession) -> SettingsOut:
    llm = await effective_llm(session)
    return SettingsOut(
        llm_model=llm.get("model") or "",
        llm_base_url=llm.get("base_url"),
        keys={
            "anthropic": bool(os.getenv("ANTHROPIC_API_KEY")),
            "openai": bool(os.getenv("OPENAI_API_KEY")),
            "gemini": bool(os.getenv("GEMINI_API_KEY")),
        },
    )


@router.get("", response_model=SettingsOut)
async def get_settings_endpoint(session: AsyncSession = Depends(db_session)) -> SettingsOut:
    return await _build_out(session)


@router.put("", response_model=SettingsOut)
async def put_settings(body: SettingsIn, session: AsyncSession = Depends(db_session)) -> SettingsOut:
    row = await get_or_create_setting(session)
    if body.llm_model is not None:
        row.llm_model = body.llm_model or None
    if body.llm_base_url is not None:
        row.llm_base_url = body.llm_base_url or None
    await session.flush()
    return await _build_out(session)
