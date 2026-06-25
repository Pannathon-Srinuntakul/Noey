"""Video editing endpoints.

POST /videos              — upload clips, create VideoProject, enqueue ingest_video
GET  /videos              — list user's projects
GET  /videos/{uid}        — project detail + status
POST /videos/{uid}/cancel — stop an in-progress project
DELETE /videos/{uid}      — delete project + remove files from disk
GET  /videos/{uid}/playback-url      — presigned URL (S3) or authenticated hint (local)
GET  /videos/{uid}/capcut-url        — presigned URL for CapCut ZIP (S3) or authenticated (local)
GET  /videos/{uid}/download          — stream final.mp4
GET  /videos/{uid}/export/capcut     — stream CapCut ZIP bundle
"""

from __future__ import annotations

import pathlib
import uuid
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, RedirectResponse, Response
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from packages.core.settings import get_settings
from packages.core.logging import get_logger
from packages.db.models.core_auth import Job
from packages.db.models.video_project import VideoProject
from packages.db.session import bind_tenant_search_path
from packages.video.s3 import (
    delete_project as s3_delete_project,
    ensure_local_output,
    output_presigned_url,
    push_uploads,
    s3_enabled,
)
from packages.video.storage import data_root, delete_project_files
from packages.video.timeline import normalize_dub_edit_script
from services.api.deps import CurrentUser, db_session

router = APIRouter(prefix="/videos", tags=["videos"])
log = get_logger(__name__)


# ── helpers ───────────────────────────────────────────────────────────────────

def _to_out(p: VideoProject) -> VideoProjectOut:
    source_files = p.source_files or []
    return VideoProjectOut(
        uid=p.uid,
        mode=p.mode,
        status=p.status,
        job_id=p.job_id,
        duration_mode=p.duration_mode or "full",
        target_duration_sec=p.target_duration_sec,
        clip_count=len(source_files) if isinstance(source_files, list) else 1,
        brief=p.brief,
        user_script=p.user_script,
        final_path=p.final_path,
        zip_path=p.zip_path,
        error_msg=p.error_msg,
        edit_script_path=p.edit_script_path,
        voiceover_path=p.voiceover_path,
        reference_clip_path=p.reference_clip_path,
        style_profile_path=p.style_profile_path,
        product_marks=p.product_marks,
        created_at=p.created_at.isoformat(),
    )


async def _get_project(session: AsyncSession, uid: str, user_id: int) -> VideoProject:
    proj = (
        await session.execute(
            select(VideoProject).where(VideoProject.uid == uid, VideoProject.user_id == user_id)
        )
    ).scalar_one_or_none()
    if proj is None:
        raise HTTPException(404, "video project not found")
    return proj


async def _redirect_presigned_output(project_uid: str, filename: str) -> RedirectResponse:
    url = await output_presigned_url(project_uid, filename)
    if not url:
        raise HTTPException(404, "File not found")
    return RedirectResponse(url)


def _stored_output_name(stored_path: str) -> str:
    """Basename under video_outputs/{uid}/ — e.g. final.mp4 vs final_silent.mp4."""
    return pathlib.Path(stored_path).name


async def _enqueue(job_id: str, fn: str, **kwargs) -> None:  # type: ignore[type-arg]
    import asyncio

    from arq import create_pool
    from arq.connections import RedisSettings

    settings = get_settings()
    redis = RedisSettings.from_dsn(settings.redis_url)
    redis.conn_timeout = 5
    redis.conn_retries = 3
    log.info("video_enqueue_start", job_id=job_id, fn=fn, redis_host=redis.host)
    try:
        pool = await asyncio.wait_for(create_pool(redis), timeout=15.0)
        await pool.enqueue_job(fn, job_id=job_id, **kwargs)
        await pool.close()
    except TimeoutError as exc:
        log.error("video_enqueue_redis_timeout", job_id=job_id, redis_url=settings.redis_url)
        raise HTTPException(503, "Redis unavailable — check REDIS_URL on api service") from exc
    except Exception as exc:
        log.error("video_enqueue_failed", job_id=job_id, error=str(exc))
        raise HTTPException(503, f"Failed to enqueue job: {exc}") from exc
    log.info("video_enqueue_done", job_id=job_id, fn=fn)


async def _mark_job_cancelled(job_id: str) -> None:
    """Update core.jobs row so polling UI reflects cancellation."""
    from packages.db.session import get_sessionmaker

    maker = get_sessionmaker()
    async with maker() as session:
        await session.execute(text("SET search_path TO core, public"))
        job = (await session.execute(select(Job).where(Job.id == job_id))).scalar_one_or_none()
        if job and job.status in ("queued", "running"):
            job.status = "error"
            job.progress = 0
            job.result = {"step": "cancelled", "message": "ยกเลิกโดยผู้ใช้"}
            job.error = "cancelled by user"
            await session.commit()


async def _cancel_project(session: AsyncSession, proj: VideoProject) -> None:
    if proj.status not in ("pending", "processing"):
        raise HTTPException(400, "โปรเจกต์นี้หยุดไม่ได้")
    proj.status = "cancelled"
    proj.error_msg = "ยกเลิกโดยผู้ใช้"
    if proj.job_id:
        await _mark_job_cancelled(proj.job_id)


# ── schemas ───────────────────────────────────────────────────────────────────

class VideoProjectOut(BaseModel):
    uid: str
    mode: str
    status: str
    job_id: str | None
    duration_mode: str = "full"
    target_duration_sec: int | None
    clip_count: int = 1
    brief: str | None = None
    user_script: str | None = None
    final_path: str | None
    zip_path: str | None
    error_msg: str | None
    edit_script_path: str | None = None
    voiceover_path: str | None = None
    reference_clip_path: str | None = None
    style_profile_path: str | None = None
    product_marks: list | None = None
    created_at: str

    model_config = {"from_attributes": True}


class ProductMark(BaseModel):
    sourceClip: str
    at: float
    productName: str
    price: str = ""


class UploadProjectItem(BaseModel):
    project_uid: str
    job_id: str


class UploadResponse(BaseModel):
    projects: list[UploadProjectItem]


class PlaybackUrlOut(BaseModel):
    """How the browser should load final.mp4 — direct presigned URL (S3) or authenticated API fetch (local)."""
    mode: str  # "direct" | "authenticated"
    url: str | None = None


UPLOAD_MODES = ("merge", "separate")


async def _save_upload_clip(
    upload_dir_path: pathlib.Path,
    data_root_path: pathlib.Path,
    index: int,
    upload_file: UploadFile,
) -> str:
    ext = pathlib.Path(upload_file.filename or "clip.mp4").suffix or ".mp4"
    dest = upload_dir_path / f"clip_{index:03d}{ext}"
    dest.write_bytes(await upload_file.read())
    return str(dest.relative_to(data_root_path))


async def _create_video_project(
    *,
    session: AsyncSession,
    auth: CurrentUser,
    project_uid: str,
    saved_paths: list[str],
    mode: str,
    target_duration_sec: int | None,
    duration_mode: str = "full",
    brief: str | None = None,
    user_script: str | None = None,
) -> UploadProjectItem:
    job_id = f"video_{project_uid[:8]}"

    proj = VideoProject(
        uid=project_uid,
        user_id=auth.user_id,
        tenant_slug=auth.tenant_slug,
        mode=mode,
        status="processing",
        job_id=job_id,
        source_files=saved_paths,
        target_duration_sec=target_duration_sec,
        duration_mode=duration_mode,
        brief=brief or None,
        user_script=user_script or None,
    )
    session.add(proj)
    await session.flush()

    await session.execute(text("SET search_path TO core, public"))
    job = Job(
        id=job_id,
        tenant_id=auth.tenant_id,
        type="video_edit",
        status="queued",
        progress=2,
        result={"step": "queued", "message": "อัปโหลดเสร็จแล้ว รอ worker รับงาน…"},
    )
    session.add(job)
    await bind_tenant_search_path(session, auth.tenant_slug)
    return UploadProjectItem(project_uid=project_uid, job_id=job_id)


# ── endpoints ─────────────────────────────────────────────────────────────────

DURATION_MODES = ("full", "auto", "custom")


@router.post("", response_model=UploadResponse, status_code=201)
async def upload_video(
    auth: CurrentUser,
    files: list[UploadFile] = File(...),
    mode: str = Form(default="talking_head"),
    upload_mode: str = Form(default="merge"),
    duration_mode: str = Form(default="full"),
    target_duration_sec: int | None = Form(default=None),
    brief: str | None = Form(default=None),
    user_script: str | None = Form(default=None),
    session: AsyncSession = Depends(db_session),
) -> UploadResponse:
    """Upload one or more video clips; start the AI editing pipeline."""
    log.info(
        "video_upload_start",
        user_id=auth.user_id,
        file_count=len(files),
        mode=mode,
        upload_mode=upload_mode,
    )
    if mode not in ("talking_head", "dub_first"):
        raise HTTPException(400, f"Unsupported mode '{mode}'. Use 'talking_head' or 'dub_first'.")
    if upload_mode not in UPLOAD_MODES:
        raise HTTPException(400, f"upload_mode must be one of: {', '.join(UPLOAD_MODES)}")
    if duration_mode not in DURATION_MODES:
        raise HTTPException(400, f"duration_mode must be one of: {', '.join(DURATION_MODES)}")
    if not files:
        raise HTTPException(400, "At least one video file required")
    if duration_mode == "custom" and target_duration_sec is None:
        raise HTTPException(400, "target_duration_sec required when duration_mode='custom'")
    if target_duration_sec is not None:
        if target_duration_sec < 15 or target_duration_sec > 600:
            raise HTTPException(400, "target_duration_sec must be between 15 and 600")

    data_root_path = data_root()
    created: list[UploadProjectItem] = []

    if upload_mode == "separate" and len(files) > 1:
        for f in files:
            project_uid = str(uuid.uuid4())
            upload_dir_path = data_root_path / "video_uploads" / project_uid
            upload_dir_path.mkdir(parents=True, exist_ok=True)
            saved_path = await _save_upload_clip(upload_dir_path, data_root_path, 0, f)
            item = await _create_video_project(
                session=session,
                auth=auth,
                project_uid=project_uid,
                saved_paths=[saved_path],
                mode=mode,
                target_duration_sec=target_duration_sec,
                duration_mode=duration_mode,
                brief=brief,
                user_script=user_script,
            )
            created.append(item)
    else:
        project_uid = str(uuid.uuid4())
        upload_dir_path = data_root_path / "video_uploads" / project_uid
        upload_dir_path.mkdir(parents=True, exist_ok=True)
        saved_paths: list[str] = []
        for i, f in enumerate(files):
            saved_paths.append(await _save_upload_clip(upload_dir_path, data_root_path, i, f))
        created.append(
            await _create_video_project(
                session=session,
                auth=auth,
                project_uid=project_uid,
                saved_paths=saved_paths,
                mode=mode,
                target_duration_sec=target_duration_sec,
                duration_mode=duration_mode,
                brief=brief,
                user_script=user_script,
            )
        )

    await session.commit()
    log.info("video_upload_saved", projects=[c.project_uid for c in created])

    # Push uploaded files to S3 (no-op when S3 not fully configured)
    for item in created:
        up_dir = data_root() / "video_uploads" / item.project_uid
        await push_uploads(item.project_uid, up_dir)
    log.info("video_upload_s3_done", s3_enabled=s3_enabled())

    for item in created:
        await _enqueue(
            item.job_id,
            "ingest_video",
            project_uid=item.project_uid,
            tenant_slug=auth.tenant_slug,
        )
    log.info("video_upload_enqueued", job_ids=[c.job_id for c in created])

    return UploadResponse(projects=created)


@router.get("", response_model=list[VideoProjectOut])
async def list_projects(
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
) -> list[VideoProjectOut]:
    rows = (
        await session.execute(
            select(VideoProject)
            .where(VideoProject.user_id == auth.user_id)
            .order_by(VideoProject.created_at.desc())
            .limit(50)
        )
    ).scalars().all()
    return [
        _to_out(p)
        for p in rows
    ]


@router.get("/{uid}", response_model=VideoProjectOut)
async def get_project(
    uid: str,
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
) -> VideoProjectOut:
    p = await _get_project(session, uid, auth.user_id)
    return _to_out(p)


@router.post("/{uid}/cancel", response_model=VideoProjectOut)
async def cancel_project(
    uid: str,
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
) -> VideoProjectOut:
    """Stop an in-progress video editing pipeline."""
    p = await _get_project(session, uid, auth.user_id)
    await _cancel_project(session, p)
    await session.commit()
    return _to_out(p)


@router.delete("/{uid}", status_code=204, response_class=Response)
async def delete_project(
    uid: str,
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
) -> Response:
    """Delete project record and remove all associated files from disk."""
    p = await _get_project(session, uid, auth.user_id)
    if p.status in ("pending", "processing"):
        await _cancel_project(session, p)
        await session.commit()
    source_files = list(p.source_files or []) if isinstance(p.source_files, list) else None
    delete_project_files(uid, source_files=source_files)
    await s3_delete_project(uid)
    await session.delete(p)
    await session.commit()
    return Response(status_code=204)


@router.get("/{uid}/playback-url", response_model=PlaybackUrlOut)
async def get_playback_url(
    uid: str,
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
) -> PlaybackUrlOut:
    """Return presigned S3 URL for <video src> on prod; local uses authenticated blob fetch."""
    p = await _get_project(session, uid, auth.user_id)
    if p.status != "done" or not p.final_path:
        raise HTTPException(404, "Video not ready yet")
    file_path = data_root() / p.final_path
    if file_path.exists():
        return PlaybackUrlOut(mode="authenticated")
    if s3_enabled():
        url = await output_presigned_url(uid, _stored_output_name(p.final_path))
        if url:
            return PlaybackUrlOut(mode="direct", url=url)
    raise HTTPException(404, "File not found")


@router.get("/{uid}/capcut-url", response_model=PlaybackUrlOut)
async def get_capcut_url(
    uid: str,
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
) -> PlaybackUrlOut:
    """Return presigned S3 URL for CapCut ZIP; local uses authenticated blob fetch."""
    p = await _get_project(session, uid, auth.user_id)
    if p.status != "done" or not p.zip_path:
        raise HTTPException(404, "CapCut bundle not ready yet")
    file_path = data_root() / p.zip_path
    if file_path.exists():
        return PlaybackUrlOut(mode="authenticated")
    if s3_enabled():
        url = await output_presigned_url(uid, _stored_output_name(p.zip_path))
        if url:
            return PlaybackUrlOut(mode="direct", url=url)
    raise HTTPException(404, "File not found")


@router.get("/{uid}/download", response_model=None)
async def download_final(
    uid: str,
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
) -> FileResponse | RedirectResponse:
    """Stream the final.mp4 for download."""
    p = await _get_project(session, uid, auth.user_id)
    if p.status != "done" or not p.final_path:
        raise HTTPException(404, "Video not ready yet")
    file_path = data_root() / p.final_path
    if file_path.exists():
        return FileResponse(str(file_path), media_type="video/mp4", filename=f"noey_edit_{uid[:8]}.mp4")
    if s3_enabled():
        return await _redirect_presigned_output(uid, _stored_output_name(p.final_path))
    raise HTTPException(404, "File not found")


@router.get("/{uid}/export/capcut", response_model=None)
async def export_capcut(
    uid: str,
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
) -> FileResponse | RedirectResponse:
    """Stream the CapCut ZIP bundle for download."""
    p = await _get_project(session, uid, auth.user_id)
    if p.status != "done" or not p.zip_path:
        raise HTTPException(404, "CapCut bundle not ready yet")
    file_path = data_root() / p.zip_path
    if file_path.exists():
        return FileResponse(str(file_path), media_type="application/zip", filename=f"capcut_bundle_{uid[:8]}.zip")
    if s3_enabled():
        return await _redirect_presigned_output(uid, _stored_output_name(p.zip_path))
    raise HTTPException(404, "File not found")


@router.get("/{uid}/edit-script")
async def get_edit_script(
    uid: str,
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
) -> dict:
    """Return the edit_script.json content for a dub_first project."""
    import json as _json
    p = await _get_project(session, uid, auth.user_id)
    if not p.edit_script_path:
        raise HTTPException(404, "Edit script not available yet")
    script_file = data_root() / p.edit_script_path
    if not script_file.exists():
        try:
            script_file = await ensure_local_output(uid, script_file.name)
        except FileNotFoundError as exc:
            raise HTTPException(404, "Edit script file not found") from exc
    return normalize_dub_edit_script(_json.loads(script_file.read_text(encoding="utf-8")))


@router.post("/{uid}/voiceover", response_model=VideoProjectOut)
async def upload_voiceover(
    uid: str,
    auth: CurrentUser,
    file: UploadFile = File(...),
    session: AsyncSession = Depends(db_session),
) -> VideoProjectOut:
    """Upload voiceover file for a dub_first project. Triggers plan_dub_timeline."""
    p = await _get_project(session, uid, auth.user_id)
    if p.mode != "dub_first":
        raise HTTPException(400, "Voiceover upload only supported for dub_first projects")
    if p.status != "waiting_vo":
        raise HTTPException(400, f"Project not waiting for voiceover (status: {p.status})")

    ext = pathlib.Path(file.filename or "voiceover.mp3").suffix or ".mp3"
    allowed = {".mp3", ".wav", ".m4a", ".aac", ".ogg"}
    if ext.lower() not in allowed:
        raise HTTPException(400, f"Unsupported audio format '{ext}'. Use mp3/wav/m4a/aac/ogg.")

    vo_dir = data_root() / "video_uploads" / uid
    vo_dir.mkdir(parents=True, exist_ok=True)
    vo_path = vo_dir / f"voiceover{ext}"
    vo_path.write_bytes(await file.read())

    rel_vo = str(vo_path.relative_to(data_root()))
    p.voiceover_path = rel_vo
    p.status = "processing"
    await session.commit()

    await push_uploads(uid, vo_dir)

    # Reuse the same job_id so the frontend can keep polling
    job_id = p.job_id or f"video_{uid[:8]}"
    from packages.db.models.core_auth import Job
    from sqlalchemy import select as _sel
    from packages.db.session import bind_tenant_search_path
    await session.execute(
        __import__("sqlalchemy", fromlist=["text"]).text("SET search_path TO core, public")
    )
    existing = (await session.execute(_sel(Job).where(Job.id == job_id))).scalar_one_or_none()
    if existing:
        existing.status = "queued"
        existing.progress = 2
        existing.result = {"step": "queued", "message": "อัปโหลด voiceover เสร็จแล้ว รอ worker วางแผน…"}
    await bind_tenant_search_path(session, auth.tenant_slug)
    await session.commit()

    await _enqueue(job_id, "plan_dub_timeline", project_uid=uid, tenant_slug=auth.tenant_slug)
    return _to_out(p)


@router.post("/{uid}/reference", response_model=VideoProjectOut)
async def upload_reference(
    uid: str,
    auth: CurrentUser,
    file: UploadFile = File(...),
    session: AsyncSession = Depends(db_session),
) -> VideoProjectOut:
    """Upload a reference TikTok clip to learn editing style. Enqueues analyze_reference."""
    p = await _get_project(session, uid, auth.user_id)

    ext = pathlib.Path(file.filename or "reference.mp4").suffix or ".mp4"
    allowed_video = {".mp4", ".mov", ".avi", ".mkv", ".webm"}
    if ext.lower() not in allowed_video:
        raise HTTPException(400, f"Unsupported video format '{ext}'. Use mp4/mov/avi/mkv/webm.")

    ref_dir = data_root() / "video_uploads" / uid
    ref_dir.mkdir(parents=True, exist_ok=True)
    ref_path = ref_dir / f"reference{ext}"
    ref_path.write_bytes(await file.read())

    rel_ref = str(ref_path.relative_to(data_root()))
    p.reference_clip_path = rel_ref
    await session.commit()

    await push_uploads(uid, ref_dir)

    ref_job_id = f"ref_{uid[:8]}"
    from packages.db.models.core_auth import Job as _Job
    from sqlalchemy import select as _sel
    await session.execute(
        __import__("sqlalchemy", fromlist=["text"]).text("SET search_path TO core, public")
    )
    existing_ref = (await session.execute(_sel(_Job).where(_Job.id == ref_job_id))).scalar_one_or_none()
    if existing_ref:
        existing_ref.status = "queued"
        existing_ref.progress = 2
        existing_ref.result = {"step": "analyze", "message": "อัปโหลด reference เสร็จแล้ว รอวิเคราะห์…"}
    else:
        from packages.db.session import bind_tenant_search_path as _bsp
        ref_job = _Job(
            id=ref_job_id,
            tenant_id=auth.tenant_id,
            type="analyze_reference",
            status="queued",
            progress=2,
            result={"step": "analyze", "message": "อัปโหลด reference เสร็จแล้ว รอวิเคราะห์…"},
        )
        session.add(ref_job)
    await bind_tenant_search_path(session, auth.tenant_slug)
    await session.commit()

    await _enqueue(ref_job_id, "analyze_reference", project_uid=uid, tenant_slug=auth.tenant_slug)
    return _to_out(p)


@router.post("/{uid}/product-marks", response_model=VideoProjectOut)
async def set_product_marks(
    uid: str,
    marks: list[ProductMark],
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
) -> VideoProjectOut:
    """Save product mark timestamps for overlay rendering.

    Marks will be picked up by plan_edit and rendered as popup overlays.
    Call this before or after upload — marks are stored and applied at render time.
    """
    p = await _get_project(session, uid, auth.user_id)
    p.product_marks = [m.model_dump() for m in marks]
    await session.commit()
    return _to_out(p)
