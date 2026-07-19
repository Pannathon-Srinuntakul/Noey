"""Effect-style CRUD — reusable per-user AI editing styles for the effects pass.

A style is created in the desktop Studio from a text description and/or a
reference clip; a distillation job (arq ``distill_style_local`` →
packages/video/effects_style.py) turns it into stored prose that the
effects-placement pass reuses. See packages/db/models/effect_style.py.

All endpoints are scoped to the authenticated user in the tenant schema (same
ownership pattern as videos_local.py). The reference clip is stored on the
server's shared data_root under ``effect_styles/<style_uid>/`` — the local
worker reads it from there (desktop app + worker share the machine).
"""

from __future__ import annotations

import uuid as _uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from packages.core.logging import get_logger
from packages.db.models.core_auth import Job
from packages.db.models.effect_style import EffectStyle
from packages.video.storage import data_root
from services.api.deps import CurrentUser, db_session
from services.api.routers.videos import _enqueue

router = APIRouter(prefix="/effect-styles", tags=["effect-styles"])
log = get_logger(__name__)

_VIDEO_SUFFIXES = {".mp4", ".mov", ".webm"}
_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}


def _style_dir(style_uid: str) -> Path:
    return data_root() / "effect_styles" / style_uid


# ── schemas ─────────────────────────────────────────────────────────────────

class StyleSummary(BaseModel):
    uid: str
    name: str
    status: str
    has_reference: bool
    updated_at: str


class StyleDetail(StyleSummary):
    description: str | None
    system_prompt: str | None
    error_msg: str | None


class StyleCreateOut(BaseModel):
    style_uid: str
    job_id: str


class StyleUpdateIn(BaseModel):
    name: str | None = None
    description: str | None = None
    system_prompt: str | None = None


# ── helpers ─────────────────────────────────────────────────────────────────

async def _get_style(session: AsyncSession, uid: str, user_id: int) -> EffectStyle:
    style = await session.get(EffectStyle, uid)
    if style is None or style.user_id != user_id:
        raise HTTPException(404, "ไม่พบสไตล์นี้")
    return style


def _summary(style: EffectStyle) -> StyleSummary:
    return StyleSummary(
        uid=style.uid,
        name=style.name,
        status=style.status,
        has_reference=bool(style.reference_clip_path),
        updated_at=style.updated_at.isoformat() if style.updated_at else "",
    )


async def _create_distill_job(session: AsyncSession, style: EffectStyle, auth: CurrentUser) -> str:
    """Upsert the core-schema Job row the desktop polls for distillation status.

    Switches search_path to core for the Job write (EffectStyle lives in the
    tenant schema and must already be flushed by the caller). Does NOT enqueue
    or commit — the caller commits, then calls _enqueue_distill.
    """
    job_id = f"style_{style.uid[:8]}"
    await session.execute(text("SET search_path TO core, public"))
    queued = {"step": "queued", "message": "รับสไตล์แล้ว รอ AI วิเคราะห์…"}
    existing = await session.get(Job, job_id)
    if existing:
        existing.status = "queued"
        existing.progress = 2
        existing.result = queued
        existing.error = None
    else:
        session.add(Job(
            id=job_id, tenant_id=auth.tenant_id, type="style_distill",
            status="queued", progress=2, result=queued,
        ))
    return job_id


async def _enqueue_distill(style_uid: str, auth: CurrentUser) -> None:
    await _enqueue(
        f"style_{style_uid[:8]}", "distill_style_local",
        style_uid=style_uid, tenant_slug=auth.tenant_slug,
    )


# ── endpoints ───────────────────────────────────────────────────────────────

@router.post("", response_model=StyleCreateOut, status_code=201)
async def create_style(
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
    name: str = Form(...),
    description: str = Form(""),
    reference: UploadFile | None = File(None),
) -> StyleCreateOut:
    """Create a style (status=pending) and enqueue its distillation.

    Requires a description and/or a reference clip — a style with neither has
    nothing to distil.
    """
    if not (description.strip() or reference is not None):
        raise HTTPException(400, "ต้องมีคำอธิบายสไตล์ หรือคลิปอ้างอิงอย่างน้อยหนึ่งอย่าง")

    style_uid = str(_uuid.uuid4())
    ref_rel: str | None = None
    if reference is not None:
        suffix = Path(reference.filename or "").suffix.lower()
        if suffix not in _VIDEO_SUFFIXES and suffix not in _IMAGE_SUFFIXES:
            suffix = ".mp4"
        d = _style_dir(style_uid)
        d.mkdir(parents=True, exist_ok=True)
        (d / f"reference{suffix}").write_bytes(await reference.read())
        ref_rel = f"effect_styles/{style_uid}/reference{suffix}"

    style = EffectStyle(
        uid=style_uid,
        user_id=auth.user_id,
        tenant_slug=auth.tenant_slug,
        name=name.strip() or "สไตล์ใหม่",
        description=description.strip() or None,
        reference_clip_path=ref_rel,
        status="pending",
    )
    session.add(style)
    await session.flush()

    job_id = await _create_distill_job(session, style, auth)
    await session.commit()
    await _enqueue_distill(style_uid, auth)
    log.info("effect_style_created", style_uid=style_uid, has_reference=ref_rel is not None)
    return StyleCreateOut(style_uid=style_uid, job_id=job_id)


@router.get("", response_model=list[StyleSummary])
async def list_styles(
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
) -> list[StyleSummary]:
    rows = (
        await session.execute(
            select(EffectStyle)
            .where(EffectStyle.user_id == auth.user_id)
            .order_by(EffectStyle.updated_at.desc())
        )
    ).scalars().all()
    return [_summary(s) for s in rows]


@router.get("/{uid}", response_model=StyleDetail)
async def get_style(
    uid: str,
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
) -> StyleDetail:
    style = await _get_style(session, uid, auth.user_id)
    return StyleDetail(
        **_summary(style).model_dump(),
        description=style.description,
        system_prompt=style.system_prompt,
        error_msg=style.error_msg,
    )


@router.put("/{uid}", response_model=StyleDetail)
async def update_style(
    uid: str,
    auth: CurrentUser,
    body: StyleUpdateIn,
    session: AsyncSession = Depends(db_session),
) -> StyleDetail:
    """Rename / hand-edit the description or the distilled system_prompt."""
    style = await _get_style(session, uid, auth.user_id)
    if body.name is not None:
        style.name = body.name.strip() or style.name
    if body.description is not None:
        style.description = body.description.strip() or None
    if body.system_prompt is not None:
        style.system_prompt = body.system_prompt.strip() or None
    await session.commit()
    await session.refresh(style)
    return StyleDetail(
        **_summary(style).model_dump(),
        description=style.description,
        system_prompt=style.system_prompt,
        error_msg=style.error_msg,
    )


@router.post("/{uid}/regenerate", response_model=StyleCreateOut)
async def regenerate_style(
    uid: str,
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
) -> StyleCreateOut:
    """Re-run distillation from the stored reference clip and/or description."""
    style = await _get_style(session, uid, auth.user_id)
    if not (style.description or style.reference_clip_path):
        raise HTTPException(400, "สไตล์นี้ไม่มีคำอธิบายหรือคลิปอ้างอิงให้วิเคราะห์ใหม่")
    style.status = "pending"
    style.error_msg = None
    await session.flush()
    job_id = await _create_distill_job(session, style, auth)
    await session.commit()
    await _enqueue_distill(style.uid, auth)
    return StyleCreateOut(style_uid=style.uid, job_id=job_id)


@router.delete("/{uid}", status_code=204)
async def delete_style(
    uid: str,
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
) -> None:
    style = await _get_style(session, uid, auth.user_id)
    await session.delete(style)
    await session.commit()
    # Best-effort cleanup of the stored reference clip.
    d = _style_dir(uid)
    if d.is_dir():
        for f in d.iterdir():
            f.unlink(missing_ok=True)
        d.rmdir()
