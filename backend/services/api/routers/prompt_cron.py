"""CRUD for user-defined prompt-crons (ai_prompts).

Each row is a fully user-defined prompt + schedule. No presets. The scheduler service
reads enabled rows and registers jobs. The prompt-cron's own run cadence is not the
scrape floor (running an AI summary often is cheap/safe); actual scraping cadence is
always clamped in the scheduler regardless of any prompt text.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.db.models import AiPrompt
from services.api.deps import db_session
from services.api.schemas import PromptIn, PromptOut

router = APIRouter(prefix="/prompts", tags=["prompt-cron"])


def _to_out(p: AiPrompt) -> PromptOut:
    return PromptOut(
        id=p.id,
        name=p.name,
        prompt=p.prompt,
        schedule=p.schedule,
        enabled=p.enabled,
        created_at=p.created_at,
        updated_at=p.updated_at,
    )


@router.get("", response_model=list[PromptOut])
async def list_prompts(session: AsyncSession = Depends(db_session)) -> list[PromptOut]:
    rows = (await session.execute(select(AiPrompt).order_by(AiPrompt.id))).scalars().all()
    return [_to_out(p) for p in rows]


@router.post("", response_model=PromptOut, status_code=201)
async def create_prompt(body: PromptIn, session: AsyncSession = Depends(db_session)) -> PromptOut:
    p = AiPrompt(name=body.name, prompt=body.prompt, schedule=body.schedule, enabled=body.enabled)
    session.add(p)
    await session.flush()
    await session.refresh(p)
    return _to_out(p)


@router.put("/{prompt_id}", response_model=PromptOut)
async def update_prompt(
    prompt_id: int, body: PromptIn, session: AsyncSession = Depends(db_session)
) -> PromptOut:
    p = await session.get(AiPrompt, prompt_id)
    if p is None:
        raise HTTPException(404, "prompt not found")
    p.name, p.prompt, p.schedule, p.enabled = body.name, body.prompt, body.schedule, body.enabled
    await session.flush()
    await session.refresh(p)
    return _to_out(p)


@router.delete("/{prompt_id}", status_code=204)
async def delete_prompt(prompt_id: int, session: AsyncSession = Depends(db_session)) -> None:
    p = await session.get(AiPrompt, prompt_id)
    if p is None:
        raise HTTPException(404, "prompt not found")
    await session.delete(p)
