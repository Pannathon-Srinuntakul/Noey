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

import shutil
import uuid as _uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from packages.core.logging import get_logger
from packages.db.models.core_auth import Job
from packages.db.models.effect_style import (
    CUT_STYLE_PLATFORMS,
    EFFECT_STYLE_KINDS,
    EffectStyle,
)
from packages.video.storage import data_root
from packages.billing import estimate as estimator
from services.api.billing_start import release_run, start_paid_run
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
    kind: str
    target_platform: str | None = None
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
        kind=style.kind,
        target_platform=style.target_platform,
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


async def _enqueue_distill(style_uid: str, auth: CurrentUser, run_id: str) -> None:
    await _enqueue(
        f"style_{style_uid[:8]}", "distill_style_local",
        style_uid=style_uid, tenant_slug=auth.tenant_slug, run_id=run_id, user=auth.user,
    )


async def _reference_seconds(ref_rel: str | None) -> float:
    """Length of the stored reference clip (0 for none / an image), FAIL
    CLOSED: a clip whose length cannot be read — not even by decoding it,
    e.g. a browser MediaRecorder WebM with no duration header — is refused
    (422), never priced as zero seconds of a Pro video call. Over
    ``settings.reference_max_sec`` is refused too (every second is billed)."""
    if not ref_rel or Path(ref_rel).suffix.lower() in _IMAGE_SUFFIXES:
        return 0.0
    import asyncio

    from packages.core.settings import get_settings
    from packages.video.ffmpeg_bin import MediaUnmeasurable, measure_media

    try:
        seconds = (await asyncio.to_thread(measure_media, data_root() / ref_rel)).duration_sec
    except MediaUnmeasurable:
        raise HTTPException(422, "อ่านความยาวคลิปอ้างอิงไม่ได้ — กรุณาส่งไฟล์วิดีโอที่เปิดได้") from None
    cap = float(get_settings().reference_max_sec)
    if seconds > cap:
        raise HTTPException(400, f"คลิปอ้างอิงต้องยาวไม่เกิน {int(cap // 60)} นาที")
    return seconds


async def _reserve_distill(
    auth: CurrentUser, request: Request, style: EffectStyle | None, style_uid: str, kind: str,
    ref_rel: str | None, allow_wallet: bool,
) -> str:
    """Reserve the distillation run (docs/token-billing-design.md §6.1), priced
    at the model the style's kind really runs (cut styles use the dub vision
    model, effects styles the effects model)."""
    from packages.video import quality

    ref_sec = await _reference_seconds(ref_rel)
    model = quality.cut_style_model() if kind == "cut" else quality.effects_model()
    image_ref = bool(ref_rel) and Path(ref_rel or "").suffix.lower() in _IMAGE_SUFFIXES
    return await start_paid_run(
        auth, request,
        estimator.estimate_run(
            kind="distill_style", clip_secs=[ref_sec], model=model, frame_count=1 if image_ref else None,
        ),
        allow_wallet=allow_wallet, job_id=f"style_{style_uid[:8]}", reference_id=style_uid,
    )


# ── endpoints ───────────────────────────────────────────────────────────────

@router.post("", response_model=StyleCreateOut, status_code=201)
async def create_style(
    auth: CurrentUser,
    request: Request,
    session: AsyncSession = Depends(db_session),
    name: str = Form(...),
    description: str = Form(""),
    kind: str = Form("effects"),
    target_platform: str = Form(""),
    reference: UploadFile | None = File(None),
    allow_wallet: bool = Form(False),
) -> StyleCreateOut:
    """Create a style (status=pending) and enqueue its distillation.

    Effects styles require a description and/or a reference clip. Cut styles
    always require a reference *video* (cutting rhythm can't be distilled from
    text alone) of at most 5 minutes.
    """
    if kind not in EFFECT_STYLE_KINDS:
        raise HTTPException(400, "kind ไม่ถูกต้อง")
    if kind == "cut":
        if reference is None:
            raise HTTPException(400, "สไตล์การตัดต้องแนบคลิปอ้างอิง")
        if target_platform and target_platform not in CUT_STYLE_PLATFORMS:
            raise HTTPException(400, "platform ไม่ถูกต้อง")
    if not (description.strip() or reference is not None):
        raise HTTPException(400, "ต้องมีคำอธิบายสไตล์ หรือคลิปอ้างอิงอย่างน้อยหนึ่งอย่าง")

    style_uid = str(_uuid.uuid4())
    ref_rel: str | None = None
    if reference is not None:
        suffix = Path(reference.filename or "").suffix.lower()
        if kind == "cut":
            if suffix not in _VIDEO_SUFFIXES:
                raise HTTPException(400, "สไตล์การตัดรองรับเฉพาะไฟล์วิดีโอ")
        elif suffix not in _VIDEO_SUFFIXES and suffix not in _IMAGE_SUFFIXES:
            suffix = ".mp4"
        d = _style_dir(style_uid)
        d.mkdir(parents=True, exist_ok=True)
        ref_path = d / f"reference{suffix}"
        ref_path.write_bytes(await reference.read())
        ref_rel = f"effect_styles/{style_uid}/reference{suffix}"

    # The reference is measured (and capped at settings.reference_max_sec —
    # ~20 minutes, ~400k Gemini tokens) inside the reservation; a refusal of
    # any kind removes what was stored.
    try:
        run_id = await _reserve_distill(auth, request, None, style_uid, kind, ref_rel, allow_wallet)
    except BaseException:
        shutil.rmtree(_style_dir(style_uid), ignore_errors=True)
        raise

    style = EffectStyle(
        uid=style_uid,
        user_id=auth.user_id,
        tenant_slug=auth.tenant_slug,
        kind=kind,
        target_platform=(target_platform or None) if kind == "cut" else None,
        name=name.strip() or "สไตล์ใหม่",
        description=description.strip() or None,
        reference_clip_path=ref_rel,
        status="pending",
    )
    try:
        session.add(style)
        await session.flush()

        job_id = await _create_distill_job(session, style, auth)
        await session.commit()
        await _enqueue_distill(style_uid, auth, run_id)
    except BaseException:
        await release_run(run_id)
        raise
    log.info("effect_style_created", style_uid=style_uid, has_reference=ref_rel is not None)
    return StyleCreateOut(style_uid=style_uid, job_id=job_id)


@router.get("", response_model=list[StyleSummary])
async def list_styles(
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
    kind: str | None = None,
) -> list[StyleSummary]:
    stmt = select(EffectStyle).where(EffectStyle.user_id == auth.user_id)
    if kind:
        stmt = stmt.where(EffectStyle.kind == kind)
    rows = (
        await session.execute(stmt.order_by(EffectStyle.updated_at.desc()))
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
    request: Request,
    session: AsyncSession = Depends(db_session),
    allow_wallet: bool = Form(False),
) -> StyleCreateOut:
    """Re-run distillation from the stored reference clip and/or description."""
    style = await _get_style(session, uid, auth.user_id)
    if not (style.description or style.reference_clip_path):
        raise HTTPException(400, "สไตล์นี้ไม่มีคำอธิบายหรือคลิปอ้างอิงให้วิเคราะห์ใหม่")
    run_id = await _reserve_distill(
        auth, request, style, style.uid, style.kind, style.reference_clip_path, allow_wallet,
    )
    try:
        style.status = "pending"
        style.error_msg = None
        await session.flush()
        job_id = await _create_distill_job(session, style, auth)
        await session.commit()
        await _enqueue_distill(style.uid, auth, run_id)
    except BaseException:
        await release_run(run_id)
        raise
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
