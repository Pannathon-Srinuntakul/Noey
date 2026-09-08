"""User-editable settings — LLM model/endpoint (global from env + DB).

ADMIN ONLY, and deliberately so. The body of this endpoint used to name the
exact model id and which vendors have keys configured — the two facts the
product must never hand to a user. It was also reachable with no credentials
at all, so a browser address bar was enough.

Two changes: every handler now requires an authenticated admin, and the
non-admin view of "is the AI set up?" is a single boolean. Nothing in the
product needs more than that.
"""

import os

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from packages.db.config import effective_llm, get_or_create_setting
from services.api.deps import CurrentUser, db_session
from services.api.schemas import SettingsIn, SettingsOut

router = APIRouter(prefix="/settings", tags=["settings"])


def _require_admin(auth: CurrentUser) -> None:
    if not auth.user.is_admin:
        raise HTTPException(status_code=403, detail="admin only")


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


@router.get("", response_model=SettingsOut, include_in_schema=False)
async def get_settings_endpoint(
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
) -> SettingsOut:
    _require_admin(auth)
    return await _build_out(session)


@router.put("", response_model=SettingsOut, include_in_schema=False)
async def put_settings(
    body: SettingsIn,
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
) -> SettingsOut:
    _require_admin(auth)
    row = await get_or_create_setting(session)
    if body.llm_model is not None:
        row.llm_model = body.llm_model or None
    if body.llm_base_url is not None:
        row.llm_base_url = body.llm_base_url or None
    await session.flush()
    return await _build_out(session)
