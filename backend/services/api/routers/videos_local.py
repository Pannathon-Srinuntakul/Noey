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
POST  /videos/{uid}/reedit-dub-scenes  — dub: upload live-editor preview + instruction → arq reedit_dub_scenes_local → {job_id}
POST  /videos/{uid}/music              — dub: upload music/video → extract audio + librosa beat detection (sync)
DELETE /videos/{uid}/music             — dub: clear the attached music track
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from packages.core.logging import get_logger
from packages.db.models.core_auth import Job
from packages.db.models.video_project import VideoProject
from packages.db.session import bind_tenant_search_path
from packages.llm.usage import UsageCtx, reset_usage_ctx, set_usage_ctx
from packages.video.s3 import delete_output_file, push_project_files, resolve_stored_output
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


class CaptionStyleIn(BaseModel):
    font: Literal["kanit", "prompt", "sarabun", "anuphan"] = "kanit"
    mode: Literal["static", "word_pop", "typewriter"] = "static"
    color: str = "#FFFFFF"
    border_color: str = "#000000"
    size: int = Field(default=72, ge=24, le=140)


class LocalProjectIn(BaseModel):
    mode: str = "dub_first"
    brief: str | None = None
    user_script: str | None = None
    target_duration_sec: int | None = Field(default=None, ge=15, le=600)
    clips: list[LocalClipMeta] = Field(min_length=1)
    caption_style: CaptionStyleIn | None = None


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


class ReeditManifestIn(BaseModel):
    selectedLineIds: list[int] = Field(default_factory=list)
    instruction: str = Field(min_length=1, max_length=2000)


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
    if body.mode not in ("dub_first", "talking_head", "highlight"):
        raise HTTPException(400, "local-render รองรับเฉพาะโหมด dub_first / talking_head / highlight")

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
        caption_style=body.caption_style.model_dump() if body.caption_style else None,
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
    if proj.mode not in ("dub_first", "highlight"):
        raise HTTPException(400, "analyze-frames ใช้ได้เฉพาะโหมด dub_first / highlight")
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
    if proj.mode not in ("dub_first", "highlight"):
        raise HTTPException(400, "analyze-video ใช้ได้เฉพาะโหมด dub_first / highlight")
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
            edit_script, body.voDurationSec, body.clipDurations, music_beats=proj.music_beats
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


_MUSIC_VIDEO_SUFFIXES = {".mp4", ".mov", ".webm", ".mkv"}
_MUSIC_AUDIO_SUFFIXES = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"}


class MusicBeatsOut(BaseModel):
    tempo: float
    beats: list[float]
    durationSec: float


@router.post("/{uid}/music", response_model=MusicBeatsOut, status_code=201)
async def upload_music(
    uid: str,
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
    file: UploadFile = File(...),
) -> MusicBeatsOut:
    """dub_first: upload a music track (or a video to extract audio from) so the
    AI cut-decision steps can align scene changes to the beat (see dub_ai.py).

    This copy is for server-side librosa analysis ONLY — playback/mixing at
    render time uses the desktop-local file path, never this one (see plan).
    ffmpeg extraction and librosa beat-tracking are both blocking, CPU-bound
    calls — run off the event loop via asyncio.to_thread (same convention as
    packages/video/s3.py), or they freeze the ENTIRE server (every other
    request on this process) for however long they take, which is much worse
    than the couple seconds a warm librosa/numba JIT cache takes — cold-start
    numba compilation on the first call in a process's lifetime can take
    30s+ on its own.
    """
    proj = await _get_local_project(session, uid, auth.user_id)
    if proj.mode not in ("dub_first", "highlight"):
        raise HTTPException(400, "เพลงประกอบใช้ได้เฉพาะโหมด dub_first / highlight")

    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in _MUSIC_VIDEO_SUFFIXES and suffix not in _MUSIC_AUDIO_SUFFIXES:
        raise HTTPException(422, f"ไฟล์ประเภทนี้ไม่รองรับ ({suffix or 'ไม่ทราบนามสกุล'})")

    root = data_root()
    music_dir = root / "video_outputs" / uid / "music"
    music_dir.mkdir(parents=True, exist_ok=True)
    for stale in music_dir.iterdir():
        stale.unlink(missing_ok=True)

    raw_path = music_dir / f"upload{suffix}"
    raw_path.write_bytes(await file.read())

    import asyncio

    from packages.video.beat_analysis import detect_beats, extract_audio_for_analysis

    if suffix in _MUSIC_VIDEO_SUFFIXES:
        analysis_path = music_dir / "track.wav"
        await asyncio.to_thread(extract_audio_for_analysis, raw_path, analysis_path)
    else:
        analysis_path = raw_path

    try:
        beats = await asyncio.to_thread(detect_beats, analysis_path)
    except Exception as exc:
        raise HTTPException(422, f"วิเคราะห์จังหวะเพลงไม่สำเร็จ: {exc}") from exc

    proj.music_path = str(raw_path.relative_to(root))
    proj.music_beats = beats
    await session.commit()
    await push_project_files(uid)

    log.info("dub_music_uploaded", uid=uid, tempo=beats["tempo"], beats=len(beats["beats"]))
    return MusicBeatsOut(**beats)


@router.delete("/{uid}/music", status_code=204)
async def delete_music(
    uid: str,
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
) -> None:
    proj = await _get_local_project(session, uid, auth.user_id)
    proj.music_path = None
    proj.music_beats = None
    await session.commit()

    root = data_root()
    music_dir = root / "video_outputs" / uid / "music"
    if music_dir.is_dir():
        for f in music_dir.iterdir():
            f.unlink(missing_ok=True)
        music_dir.rmdir()
    log.info("dub_music_deleted", uid=uid)


@router.post("/{uid}/reedit-dub-scenes", response_model=AnalyzeFramesOut, status_code=202)
async def reedit_dub_scenes(
    uid: str,
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
    preview: UploadFile = File(...),
    manifest: str = Form(...),
) -> AnalyzeFramesOut:
    """dub_first: AI-assisted re-edit of the current edit script.

    `preview` is a freshly-encoded silent proxy of the LIVE (possibly unsaved)
    editor state — reflects exactly what the user is looking at right now.
    Raw source clip proxies are reused as-is from the initial analyze step
    (proxy_manifest.json on disk); no re-upload needed for those.
    """
    proj = await _get_local_project(session, uid, auth.user_id)
    if proj.mode not in ("dub_first", "highlight"):
        raise HTTPException(400, "reedit-dub-scenes ใช้ได้เฉพาะโหมด dub_first / highlight")
    if proj.status not in ("pending", "error", "waiting_vo", "done"):
        raise HTTPException(400, "โปรเจกต์กำลังประมวลผลอยู่")
    if not proj.edit_script_path:
        raise HTTPException(400, "ยังไม่มี edit script — ต้อง analyze ก่อน")

    try:
        body = ReeditManifestIn.model_validate(json.loads(manifest))
    except (json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(422, f"manifest ไม่ถูกต้อง: {exc}") from exc

    root = data_root()
    output_dir = root / "video_outputs" / uid
    proxy_manifest_file = output_dir / "proxy" / "proxy_manifest.json"
    if not proxy_manifest_file.is_file():
        raise HTTPException(400, "ไม่พบ proxy ของคลิปต้นฉบับ — กรุณา analyze ใหม่อีกครั้ง")

    reedit_dir = output_dir / "ai_reedit"
    reedit_dir.mkdir(parents=True, exist_ok=True)
    preview_path = reedit_dir / "edited_preview.mp4"
    preview_path.write_bytes(await preview.read())
    (reedit_dir / "reedit_request.json").write_text(
        json.dumps(body.model_dump(), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    await push_project_files(uid)  # preview MP4 + request JSON only

    job_id = f"vlocal_{uid[:8]}"
    await session.execute(text("SET search_path TO core, public"))
    existing = await session.get(Job, job_id)
    if existing:
        existing.status = "queued"
        existing.progress = 2
        existing.result = {"step": "queued", "message": "รับคำสั่งแก้ไขแล้ว รอ AI ประมวลผล…"}
        existing.error = None
    else:
        session.add(Job(
            id=job_id,
            tenant_id=auth.tenant_id,
            type="video_edit",
            status="queued",
            progress=2,
            result={"step": "queued", "message": "รับคำสั่งแก้ไขแล้ว รอ AI ประมวลผล…"},
        ))
    await bind_tenant_search_path(session, auth.tenant_slug)
    proj.status = "processing"
    proj.job_id = job_id
    await session.commit()

    await _enqueue(job_id, "reedit_dub_scenes_local", project_uid=uid, tenant_slug=auth.tenant_slug)
    return AnalyzeFramesOut(job_id=job_id)


# ── effects layer (Remotion) ────────────────────────────────────────────────

@router.post("/{uid}/plan-effects", response_model=AnalyzeFramesOut, status_code=202)
async def plan_effects(
    uid: str,
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
    proxy: UploadFile = File(...),
    prompt: str = Form(""),
    script: str = Form(""),
    style_uid: str = Form(""),
    cuts: str = Form(""),
    use_previous: bool = Form(False),
    reference: UploadFile | None = File(None),
    image_asset: UploadFile | None = File(None),
) -> AnalyzeFramesOut:
    """AI-assisted effects placement: receive a downscaled proxy of the finished
    cut video + an optional instruction + an optional timed script/transcript,
    enqueue the Gemini placement pass.

    ``script`` is the voiceover/transcript with output-timeline timing (built by
    the desktop app from the dub edit script or talking_head caption lines) —
    it lets the AI match effects to the exact spoken words, not just the visuals.

    ``cuts`` — an OPTIONAL JSON array of real scene-cut timestamps (output-
    timeline seconds, e.g. ``"[3.2, 9.5, 14.0]"``), built by the desktop app
    from the same edit script/timeline (see effectsCuts.ts buildEffectsCutPoints).
    Lets the AI place a whip-pan `transitions` sweep or an ambient `sceneDrifts`
    span AT a real cut boundary instead of an invented one — omitted (or
    unparseable), both features are always empty, same as before this existed.

    ``use_previous`` — when true and an effects.json already exists for this
    project, the AI is shown it as `<previous_attempt>` and asked to produce a
    different take (the "แก้ไข AI" edit button). When false (the default — the
    fresh "ให้ AI จัดทั้งคลิป" button), any existing effects.json is ignored
    entirely, giving a genuinely clean-slate placement pass.

    ``reference`` — an OPTIONAL video/image the user attached purely as style
    inspiration (the AI is told never to copy its literal content). ``image_asset``
    — an OPTIONAL image the user wants placed IN the clip as a sticker/popup; the
    AI only sees an ephemeral copy for vision judgment and never gets a real file
    path, so ANY instance it places using it comes back with a
    ``"__PENDING_ASSET__"`` sentinel in ``imagePath`` — the caller (desktop app)
    must substitute the real local file path (the one the user actually picked)
    and persist the corrected doc via the existing ``PUT /{uid}/effects``
    before rendering.

    The full-res video never leaves the user's machine — only this proxy is
    uploaded for the AI to watch (parallel to dub's proxy upload). Effects are a
    layer on top; the cut/timeline is untouched.
    """
    proj = await _get_local_project(session, uid, auth.user_id)
    if proj.status not in ("done", "waiting_vo", "error"):
        raise HTTPException(400, "ต้องมีวิดีโอที่ตัดเสร็จแล้วก่อนจึงจะวางเอฟเฟกต์ได้")

    root = data_root()
    effects_dir = root / "video_outputs" / uid / "effects"
    effects_dir.mkdir(parents=True, exist_ok=True)
    (effects_dir / "cut_proxy.mp4").write_bytes(await proxy.read())
    (effects_dir / "prompt.txt").write_text(prompt or "", encoding="utf-8")
    (effects_dir / "script.txt").write_text(script or "", encoding="utf-8")

    # Real scene-cut boundaries (see docstring) — cleared each run so a
    # de-selected/stale value never silently lingers. Only written when the
    # payload actually parses to a non-empty list of numbers; anything else
    # (missing, malformed, empty) leaves transitions/sceneDrifts disabled,
    # never raises — this is a nice-to-have enhancement, not a hard input.
    cuts_file = effects_dir / "cuts.json"
    cuts_file.unlink(missing_ok=True)
    if cuts.strip():
        try:
            parsed_cuts = json.loads(cuts)
            if isinstance(parsed_cuts, list) and parsed_cuts:
                cuts_file.write_text(
                    json.dumps([float(c) for c in parsed_cuts if isinstance(c, (int, float))]),
                    encoding="utf-8",
                )
        except (json.JSONDecodeError, TypeError, ValueError):
            log.warning("plan_effects_cuts_unparseable", uid=uid, cuts_raw=cuts[:200])

    # A chosen saved STYLE (packages/db/models/effect_style.py) — its distilled
    # prose is written to style.txt so plan_effects_local can splice it as the
    # authoritative <style> block. Cleared each run; a de-selected style this
    # time must not silently reuse last run's. Only ready styles carry prose.
    #
    # Also delete the S3 object when clearing: push_outputs never removes
    # orphans, so a later worker pull would resurrect last run's style.txt
    # (live report 2026-07-18: user picked drift style but AI followed a
    # stale zoom-hold style.txt from a prior attempt on the same project).
    style_file = effects_dir / "style.txt"
    style_file.unlink(missing_ok=True)
    await delete_output_file(uid, "effects/style.txt")
    chosen_style_uid = style_uid.strip()
    if chosen_style_uid:
        from packages.db.models.effect_style import EffectStyle

        style = await session.get(EffectStyle, chosen_style_uid)
        if style is None or style.user_id != auth.user_id:
            raise HTTPException(404, "ไม่พบสไตล์ที่เลือก")
        if style.system_prompt:
            style_file.write_text(style.system_prompt, encoding="utf-8")
            log.info(
                "plan_effects_style_selected",
                uid=uid,
                style_uid=chosen_style_uid,
                style_name=style.name,
                prompt_chars=len(style.system_prompt),
            )
        else:
            log.warning(
                "plan_effects_style_empty_prompt",
                uid=uid,
                style_uid=chosen_style_uid,
                style_name=style.name,
            )
    else:
        log.info("plan_effects_style_none", uid=uid)

    # Reference/asset are OPTIONAL and named by their real extension (the AI
    # call needs a real suffix to guess mime type) — any stale file from a
    # previous run is removed first so an omitted param this time doesn't
    # silently reuse last run's attachment.
    for stale in effects_dir.glob("reference.*"):
        stale.unlink(missing_ok=True)
        await delete_output_file(uid, f"effects/{stale.name}")
    for stale in effects_dir.glob("image_asset.*"):
        stale.unlink(missing_ok=True)
        await delete_output_file(uid, f"effects/{stale.name}")
    if reference is not None:
        suffix = Path(reference.filename or "").suffix or ".mp4"
        (effects_dir / f"reference{suffix}").write_bytes(await reference.read())
    if image_asset is not None:
        suffix = Path(image_asset.filename or "").suffix or ".jpg"
        (effects_dir / f"image_asset{suffix}").write_bytes(await image_asset.read())

    await push_project_files(uid)  # proxy MP4 + prompt + script + optional reference/asset

    job_id = f"vlocal_{uid[:8]}"
    await session.execute(text("SET search_path TO core, public"))
    existing = await session.get(Job, job_id)
    queued = {
        "step": "queued",
        "message": "รับวิดีโอแล้ว รอ AI วางเอฟเฟกต์…",
        "style_uid": chosen_style_uid or None,
    }
    if existing:
        existing.status = "queued"
        existing.progress = 2
        existing.result = queued
        existing.error = None
    else:
        session.add(Job(
            id=job_id, tenant_id=auth.tenant_id, type="video_edit",
            status="queued", progress=2, result=queued,
        ))
    await session.commit()

    # style_uid travels with the job so the worker can re-apply from DB AFTER
    # s3_pull (belt-and-suspenders against a stale style.txt resurrected from
    # an older outputs/ prefix).
    await _enqueue(
        job_id,
        "plan_effects_local",
        project_uid=uid,
        tenant_slug=auth.tenant_slug,
        style_uid=chosen_style_uid,
        use_previous=use_previous,
    )
    return AnalyzeFramesOut(job_id=job_id)


@router.get("/{uid}/effects")
async def get_effects(
    uid: str,
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
) -> dict:
    """Return the stored effects.json (empty doc if none yet)."""
    from packages.video.effects import empty_effects_doc, normalize_effects_doc

    await _get_local_project(session, uid, auth.user_id)
    try:
        f = await resolve_stored_output(uid, f"video_outputs/{uid}/effects.json")
    except FileNotFoundError:
        return empty_effects_doc().model_dump()
    return normalize_effects_doc(json.loads(f.read_text(encoding="utf-8"))).model_dump()


class EffectsIn(BaseModel):
    version: int = 1
    instances: list[dict] = Field(default_factory=list)


@router.put("/{uid}/effects")
async def put_effects(
    uid: str,
    auth: CurrentUser,
    body: EffectsIn,
    session: AsyncSession = Depends(db_session),
) -> dict:
    """Persist a locally-edited effects.json (manual editor sync). Never renders."""
    from packages.video.effects import normalize_effects_doc

    await _get_local_project(session, uid, auth.user_id)
    doc = normalize_effects_doc(body.model_dump())
    root = data_root()
    output_dir = root / "video_outputs" / uid
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "effects.json").write_text(
        json.dumps(doc.model_dump(), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    await push_project_files(uid)
    return {"uid": uid, "instances": len(doc.instances)}


@router.post("/effects/generate-component")
async def generate_effect_component_global(
    auth: CurrentUser,
    prompt: str = Form(""),
    reference: UploadFile | None = File(None),
) -> dict:
    """Project-independent variant of the codegen route below, for the desktop
    Effects Studio (global component library): same model call, same UNTRUSTED
    output contract — the desktop side must still validate with
    codegenValidate.mjs before ever rendering. No project row is touched; the
    reference image goes to a per-user scratch file, not a project dir.
    """
    import tempfile

    from packages.video.effects_codegen import generate_effect_component

    if not prompt.strip() and reference is None:
        raise HTTPException(400, "ต้องมี prompt หรือรูป reference อย่างน้อยหนึ่งอย่าง")

    ref_path = None
    if reference is not None:
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
            tmp.write(await reference.read())
            ref_path = Path(tmp.name)

    usage_token = set_usage_ctx(
        UsageCtx(
            user_id=auth.user_id,
            tenant_id=auth.tenant_id,
            feature="video_edit",
            reference_id="effects_studio",
        )
    )
    try:
        source = await generate_effect_component(
            prompt, reference_image_path=ref_path, project_uid="effects_studio"
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    finally:
        reset_usage_ctx(usage_token)
        if ref_path is not None:
            ref_path.unlink(missing_ok=True)

    return {"componentSource": source}


@router.post("/{uid}/generate-effect-component")
async def generate_effect_component_route(
    uid: str,
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
    prompt: str = Form(""),
    reference: UploadFile | None = File(None),
) -> dict:
    """Ask the model for a brand-new Remotion overlay component's source, from
    a text prompt and/or a reference image — REMOTION_EFFECTS_REQUIREMENTS.md
    §6 extension (custom template/effect/component creation).

    Returns the raw (UNTRUSTED) source text as `componentSource`. This
    response is NOT safe to render as-is — the desktop app MUST re-validate it
    with codegenValidate.mjs before ever bundling/executing it; nothing about
    a 200 response here means the code is safe.
    """
    from packages.video.effects_codegen import generate_effect_component

    await _get_local_project(session, uid, auth.user_id)
    if not prompt.strip() and reference is None:
        raise HTTPException(400, "ต้องมี prompt หรือรูป reference อย่างน้อยหนึ่งอย่าง")

    root = data_root()
    ref_path = None
    if reference is not None:
        effects_dir = root / "video_outputs" / uid / "effects"
        effects_dir.mkdir(parents=True, exist_ok=True)
        ref_path = effects_dir / "codegen_reference.jpg"
        ref_path.write_bytes(await reference.read())

    usage_token = set_usage_ctx(
        UsageCtx(user_id=auth.user_id, tenant_id=auth.tenant_id, feature="video_edit", reference_id=uid)
    )
    try:
        source = await generate_effect_component(
            prompt, reference_image_path=ref_path, project_uid=uid
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    finally:
        reset_usage_ctx(usage_token)

    return {"componentSource": source}
