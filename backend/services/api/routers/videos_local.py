"""Local-render (desktop app) video endpoints.

The desktop app renders on the user's machine: video bytes never reach the
server. These endpoints keep the server in the loop only for what it owns —
the VideoProject record (so the web dashboard lists projects), the two LLM
calls (Vision edit-script generation, dub timeline planning), and status.

POST  /videos/local                    — create a metadata-only project (origin="local")
POST  /videos/{uid}/analyze-frames     — dub: upload frame JPEGs + manifest → arq analyze_dub_local → {job_id}
POST  /videos/{uid}/analyze-video      — dub: upload proxy MP4s + manifest → arq analyze_dub_video_local → {job_id}
POST  /videos/{uid}/plan-dub           — dub: VO duration + clip durations → timeline JSON (sync LLM call)
POST  /videos/{uid}/transcribe-audio   — talking_head: upload WAVs → arq plan_talking_local → {job_id}
GET   /videos/{uid}/local-timeline     — fetch the planned timeline.json
PUT   /videos/{uid}/local-timeline     — sync locally-edited timeline.json (never renders)
PATCH /videos/{uid}/local-status       — desktop reports render progress/completion
PUT   /videos/{uid}/local-edit-script  — sync locally-edited edit_script.json to the server record
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from packages.core.logging import get_logger
from packages.db.models.core_auth import Job
from packages.db.models.video_project import VideoProject
from packages.db.session import bind_tenant_search_path
from packages.llm.usage import UsageCtx, reset_usage_ctx, set_usage_ctx
from packages.video.s3 import push_project_files, resolve_stored_output
from packages.video.storage import data_root
from packages.video.timeline import cuts_duration, normalize_dub_edit_script
from services.api.deps import CurrentUser, db_session
from services.api.routers.videos import _enqueue, _get_project

router = APIRouter(prefix="/videos", tags=["videos-local"])
log = get_logger(__name__)

LOCAL_STATUSES = ("processing", "waiting_vo", "done", "error")


# ── schemas ───────────────────────────────────────────────────────────────────

class LocalClipMeta(BaseModel):
    id: str
    durationSec: float = Field(gt=0)
    width: int = 0
    height: int = 0
    fps: int = 30


class LocalProjectIn(BaseModel):
    mode: str = "dub_first"
    brief: str | None = None
    user_script: str | None = None
    target_duration_sec: int | None = Field(default=None, ge=15, le=600)
    clips: list[LocalClipMeta] = Field(min_length=1)


class LocalProjectOut(BaseModel):
    uid: str


class FrameManifestEntry(BaseModel):
    name: str
    clip_id: str
    time: float
    scene_idx: int = 0
    scene_start: float = 0.0
    scene_end: float = 0.0
    edge: str | None = None


class AnalyzeFramesOut(BaseModel):
    job_id: str


class ProxyManifestEntry(BaseModel):
    clip_id: str
    file: str
    durationSec: float = Field(gt=0)
    order: int = 0


class PlanDubIn(BaseModel):
    voDurationSec: float = Field(gt=0)
    clipDurations: list[float] = Field(min_length=1)


class LocalStatusIn(BaseModel):
    status: str
    error_msg: str | None = None


# ── helpers ───────────────────────────────────────────────────────────────────

async def _get_local_project(session: AsyncSession, uid: str, user_id: int) -> VideoProject:
    proj = await _get_project(session, uid, user_id)
    if proj.origin != "local":
        raise HTTPException(400, "endpoint นี้ใช้ได้เฉพาะโปรเจกต์ local-render")
    return proj


# ── endpoints ─────────────────────────────────────────────────────────────────

@router.post("/local", response_model=LocalProjectOut, status_code=201)
async def create_local_project(
    auth: CurrentUser,
    body: LocalProjectIn,
    session: AsyncSession = Depends(db_session),
) -> LocalProjectOut:
    if body.mode not in ("dub_first", "talking_head"):
        raise HTTPException(400, "local-render รองรับเฉพาะโหมด dub_first / talking_head")

    proj = VideoProject(
        user_id=auth.user_id,
        tenant_slug=auth.tenant_slug,
        mode=body.mode,
        status="pending",
        origin="local",
        brief=body.brief or None,
        user_script=body.user_script or None,
        target_duration_sec=body.target_duration_sec,
        # duration_mode only ever mattered for talking_head's now-removed highlight
        # mode; dub_first's own target_duration_sec (script length) is independent
        # of this column. Always "full" — see plan_core.build_talking_head_timeline.
        duration_mode="full",
        local_meta={"clips": [c.model_dump() for c in body.clips]},
        source_files=[],
    )
    session.add(proj)
    await session.flush()
    await session.commit()
    log.info("local_project_created", uid=proj.uid, clips=len(body.clips))
    return LocalProjectOut(uid=proj.uid)


@router.post("/{uid}/analyze-frames", response_model=AnalyzeFramesOut, status_code=202)
async def analyze_frames(
    uid: str,
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
    files: list[UploadFile] = File(...),
    manifest: str = Form(...),
) -> AnalyzeFramesOut:
    proj = await _get_local_project(session, uid, auth.user_id)
    if proj.mode != "dub_first":
        raise HTTPException(400, "analyze-frames ใช้ได้เฉพาะโหมด dub_first")
    if proj.status not in ("pending", "error", "waiting_vo", "done"):
        raise HTTPException(400, "โปรเจกต์กำลังประมวลผลอยู่")

    try:
        entries = [FrameManifestEntry.model_validate(e) for e in json.loads(manifest)]
    except (json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(422, f"manifest ไม่ถูกต้อง: {exc}") from exc

    by_name = {e.name: e for e in entries}
    uploaded_names = [f.filename for f in files]
    missing = set(by_name) - set(uploaded_names)
    extra = set(uploaded_names) - set(by_name)
    if missing or extra:
        raise HTTPException(422, f"manifest/ไฟล์ไม่ตรงกัน (missing={sorted(missing)}, extra={sorted(extra)})")

    root = data_root()
    frames_dir = root / "video_outputs" / uid / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    manifest_records: list[dict] = []
    for f in files:
        entry = by_name[f.filename or ""]
        safe_name = f"{entry.clip_id}_{entry.time:.2f}.jpg".replace("/", "_")
        dest = frames_dir / safe_name
        dest.write_bytes(await f.read())
        manifest_records.append({**entry.model_dump(), "file": f"frames/{safe_name}"})

    (frames_dir / "frames_manifest.json").write_text(
        json.dumps(manifest_records, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    await push_project_files(uid)  # JPEGs + manifest only — no video bytes

    job_id = f"vlocal_{uid[:8]}"
    await session.execute(text("SET search_path TO core, public"))
    existing = await session.get(Job, job_id)
    if existing:
        existing.status = "queued"
        existing.progress = 2
        existing.result = {"step": "queued", "message": "รับ frames แล้ว รอ worker วิเคราะห์…"}
        existing.error = None
    else:
        session.add(Job(
            id=job_id,
            tenant_id=auth.tenant_id,
            type="video_edit",
            status="queued",
            progress=2,
            result={"step": "queued", "message": "รับ frames แล้ว รอ worker วิเคราะห์…"},
        ))
    await bind_tenant_search_path(session, auth.tenant_slug)
    proj.status = "processing"
    proj.job_id = job_id
    await session.commit()

    await _enqueue(job_id, "analyze_dub_local", project_uid=uid, tenant_slug=auth.tenant_slug)
    return AnalyzeFramesOut(job_id=job_id)


@router.post("/{uid}/analyze-video", response_model=AnalyzeFramesOut, status_code=202)
async def analyze_video(
    uid: str,
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
    files: list[UploadFile] = File(...),
    manifest: str = Form(...),
) -> AnalyzeFramesOut:
    """dub_first: receive per-clip proxy MP4s (Gemini native-video path)."""
    proj = await _get_local_project(session, uid, auth.user_id)
    if proj.mode != "dub_first":
        raise HTTPException(400, "analyze-video ใช้ได้เฉพาะโหมด dub_first")
    if proj.status not in ("pending", "error", "waiting_vo", "done"):
        raise HTTPException(400, "โปรเจกต์กำลังประมวลผลอยู่")

    try:
        entries = [ProxyManifestEntry.model_validate(e) for e in json.loads(manifest)]
    except (json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(422, f"manifest ไม่ถูกต้อง: {exc}") from exc

    by_file = {e.file: e for e in entries}
    uploaded_names = [f.filename for f in files]
    missing = set(by_file) - set(uploaded_names)
    extra = set(uploaded_names) - set(by_file)
    if missing or extra:
        raise HTTPException(422, f"manifest/ไฟล์ไม่ตรงกัน (missing={sorted(missing)}, extra={sorted(extra)})")

    root = data_root()
    proxy_dir = root / "video_outputs" / uid / "proxy"
    proxy_dir.mkdir(parents=True, exist_ok=True)
    manifest_records: list[dict] = []
    for f in files:
        entry = by_file[f.filename or ""]
        dest = proxy_dir / entry.file
        dest.write_bytes(await f.read())
        manifest_records.append(entry.model_dump())

    (proxy_dir / "proxy_manifest.json").write_text(
        json.dumps(manifest_records, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    await push_project_files(uid)  # proxy MP4s + manifest only

    job_id = f"vlocal_{uid[:8]}"
    await session.execute(text("SET search_path TO core, public"))
    existing = await session.get(Job, job_id)
    if existing:
        existing.status = "queued"
        existing.progress = 2
        existing.result = {"step": "queued", "message": "รับวิดีโอแล้ว รอ worker วิเคราะห์…"}
        existing.error = None
    else:
        session.add(Job(
            id=job_id,
            tenant_id=auth.tenant_id,
            type="video_edit",
            status="queued",
            progress=2,
            result={"step": "queued", "message": "รับวิดีโอแล้ว รอ worker วิเคราะห์…"},
        ))
    await bind_tenant_search_path(session, auth.tenant_slug)
    proj.status = "processing"
    proj.job_id = job_id
    await session.commit()

    await _enqueue(job_id, "analyze_dub_video_local", project_uid=uid, tenant_slug=auth.tenant_slug)
    return AnalyzeFramesOut(job_id=job_id)


@router.post("/{uid}/plan-dub")
async def plan_dub(
    uid: str,
    auth: CurrentUser,
    body: PlanDubIn,
    session: AsyncSession = Depends(db_session),
) -> dict:
    proj = await _get_local_project(session, uid, auth.user_id)
    if not proj.edit_script_path:
        raise HTTPException(400, "ยังไม่มี edit script — ต้อง analyze ก่อน")

    root = data_root()
    try:
        edit_script_file = await resolve_stored_output(uid, proj.edit_script_path)
    except FileNotFoundError as exc:
        raise HTTPException(404, "edit_script.json หายจาก server") from exc
    edit_script = json.loads(edit_script_file.read_text(encoding="utf-8"))

    from packages.video.dub_ai import plan_dub_timeline_cuts

    usage_token = set_usage_ctx(
        UsageCtx(user_id=auth.user_id, tenant_id=auth.tenant_id, feature="video_edit", reference_id=uid)
    )
    try:
        render_cuts = await plan_dub_timeline_cuts(
            edit_script, body.voDurationSec, body.clipDurations
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    finally:
        reset_usage_ctx(usage_token)

    clips_meta = (proj.local_meta or {}).get("clips", [])
    first = clips_meta[0] if clips_meta else {}
    timeline = {
        "mode": "dub_first",
        "editMode": "dub_first",
        "sources": [{"id": f"clip{i}", "file": f"normalized/norm_{i:03d}.mp4"}
                    for i in range(len(body.clipDurations))],
        "timeline": render_cuts,
        "captions": [],
        "output": {
            "width": int(first.get("width", 0)),
            "height": int(first.get("height", 0)),
            "fps": int(first.get("fps", 30)),
            "targetDurationSec": round(body.voDurationSec, 1),
            "maxDurationSec": round(cuts_duration(render_cuts), 1),
            "clipCount": len(body.clipDurations),
        },
    }

    output_dir = root / "video_outputs" / uid
    output_dir.mkdir(parents=True, exist_ok=True)
    timeline_path = output_dir / "timeline.json"
    timeline_path.write_text(json.dumps(timeline, ensure_ascii=False, indent=2), encoding="utf-8")
    proj.timeline_path = str(timeline_path.relative_to(root))
    await session.commit()
    await push_project_files(uid)

    log.info("local_plan_dub_done", uid=uid, cuts=len(render_cuts))
    return timeline


@router.post("/{uid}/transcribe-audio", response_model=AnalyzeFramesOut, status_code=202)
async def transcribe_audio(
    uid: str,
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
    files: list[UploadFile] = File(...),
    video_files: list[UploadFile] = File(default=[]),
) -> AnalyzeFramesOut:
    """talking_head: receive speech WAVs (+ optional downscaled proxy MP4s, WITH audio,
    for Gemini's per-clip video review) → transcribe + plan on the server → timeline.

    ``video_files`` is optional so older desktop builds (or a run with the Gemini
    review disabled) keep working audio-only — the worker falls back to
    code-only cuts when no proxy video is present for a clip.
    """
    proj = await _get_local_project(session, uid, auth.user_id)
    if proj.mode != "talking_head":
        raise HTTPException(400, "transcribe-audio ใช้ได้เฉพาะโหมด talking_head")
    if proj.status not in ("pending", "error", "done"):
        raise HTTPException(400, "โปรเจกต์กำลังประมวลผลอยู่")

    import re

    name_re = re.compile(r"^audio_\d{3}\.wav$")
    for f in files:
        if not f.filename or not name_re.match(f.filename):
            raise HTTPException(422, f"ชื่อไฟล์เสียงต้องเป็น audio_NNN.wav (ได้ {f.filename})")
    video_re = re.compile(r"^clip\d+\.mp4$")
    for f in video_files:
        if not f.filename or not video_re.match(f.filename):
            raise HTTPException(422, f"ชื่อไฟล์วิดีโอต้องเป็น clipN.mp4 (ได้ {f.filename})")

    root = data_root()
    audio_dir = root / "video_outputs" / uid / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    for stale in audio_dir.glob("audio_*.wav"):
        stale.unlink(missing_ok=True)
    for f in files:
        (audio_dir / f.filename).write_bytes(await f.read())

    if video_files:
        proxy_dir = root / "video_outputs" / uid / "proxy"
        proxy_dir.mkdir(parents=True, exist_ok=True)
        for stale in proxy_dir.glob("clip*.mp4"):
            stale.unlink(missing_ok=True)
        for f in video_files:
            (proxy_dir / f.filename).write_bytes(await f.read())

    await push_project_files(uid)  # WAVs (+ proxy MP4s if provided)

    job_id = f"vlocal_{uid[:8]}"
    await session.execute(text("SET search_path TO core, public"))
    existing = await session.get(Job, job_id)
    if existing:
        existing.status = "queued"
        existing.progress = 2
        existing.result = {"step": "queued", "message": "รับไฟล์เสียงแล้ว รอ worker ถอดเสียง…"}
        existing.error = None
    else:
        session.add(Job(
            id=job_id,
            tenant_id=auth.tenant_id,
            type="video_edit",
            status="queued",
            progress=2,
            result={"step": "queued", "message": "รับไฟล์เสียงแล้ว รอ worker ถอดเสียง…"},
        ))
    await bind_tenant_search_path(session, auth.tenant_slug)
    proj.status = "processing"
    proj.job_id = job_id
    await session.commit()

    await _enqueue(job_id, "plan_talking_local", project_uid=uid, tenant_slug=auth.tenant_slug)
    return AnalyzeFramesOut(job_id=job_id)


@router.get("/{uid}/local-timeline")
async def get_local_timeline(
    uid: str,
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
) -> dict:
    proj = await _get_local_project(session, uid, auth.user_id)
    if not proj.timeline_path:
        raise HTTPException(404, "ยังไม่มี timeline — รอ AI วางแผนก่อน")
    try:
        timeline_file = await resolve_stored_output(uid, proj.timeline_path)
    except FileNotFoundError as exc:
        raise HTTPException(404, "timeline.json หายจาก server") from exc
    return json.loads(timeline_file.read_text(encoding="utf-8"))


@router.put("/{uid}/local-timeline")
async def put_local_timeline(
    uid: str,
    auth: CurrentUser,
    body: dict,
    session: AsyncSession = Depends(db_session),
) -> dict:
    """Sync a locally-edited timeline.json to the server record. Never renders."""
    proj = await _get_local_project(session, uid, auth.user_id)
    cuts = [c for c in body.get("timeline", []) if isinstance(c, dict) and c.get("type") == "cut"]
    if not cuts:
        raise HTTPException(422, "timeline ต้องมีอย่างน้อย 1 cut")
    for c in cuts:
        try:
            if float(c["out"]) <= float(c["in"]) or float(c["in"]) < 0:
                raise ValueError
        except (KeyError, TypeError, ValueError):
            raise HTTPException(422, f"cut ไม่ถูกต้อง: {c}") from None

    root = data_root()
    output_dir = root / "video_outputs" / uid
    output_dir.mkdir(parents=True, exist_ok=True)
    timeline_path = output_dir / "timeline.json"
    timeline_path.write_text(json.dumps(body, ensure_ascii=False, indent=2), encoding="utf-8")
    proj.timeline_path = str(timeline_path.relative_to(root))
    await session.commit()
    await push_project_files(uid)
    return {"uid": uid, "cuts": len(cuts)}


@router.patch("/{uid}/local-status")
async def patch_local_status(
    uid: str,
    auth: CurrentUser,
    body: LocalStatusIn,
    session: AsyncSession = Depends(db_session),
) -> dict:
    if body.status not in LOCAL_STATUSES:
        raise HTTPException(422, f"status ต้องเป็นหนึ่งใน {LOCAL_STATUSES}")
    proj = await _get_local_project(session, uid, auth.user_id)
    proj.status = body.status
    proj.error_msg = body.error_msg if body.status == "error" else None
    await session.commit()
    log.info("local_status_updated", uid=uid, status=body.status)
    return {"uid": uid, "status": body.status}


@router.put("/{uid}/local-edit-script")
async def put_local_edit_script(
    uid: str,
    auth: CurrentUser,
    body: dict,
    session: AsyncSession = Depends(db_session),
) -> dict:
    proj = await _get_local_project(session, uid, auth.user_id)
    try:
        edit_script = normalize_dub_edit_script(body)
    except Exception as exc:
        raise HTTPException(422, f"edit script ไม่ถูกต้อง: {exc}") from exc
    if not edit_script.get("segments"):
        raise HTTPException(422, "edit script ต้องมีอย่างน้อย 1 segment")

    root = data_root()
    output_dir = root / "video_outputs" / uid
    output_dir.mkdir(parents=True, exist_ok=True)
    edit_script_path = output_dir / "edit_script.json"
    edit_script_path.write_text(
        json.dumps(edit_script, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    proj.edit_script_path = str(edit_script_path.relative_to(root))
    await session.commit()
    await push_project_files(uid)
    return {"uid": uid, "segments": len(edit_script["segments"])}
