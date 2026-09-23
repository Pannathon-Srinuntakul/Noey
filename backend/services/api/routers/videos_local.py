"""Local-render (desktop app) video endpoints.

The desktop app renders on the user's machine: video bytes never reach the
server. These endpoints keep the server in the loop only for what it owns —
the VideoProject record (so the web dashboard lists projects), the two LLM
calls (Vision edit-script generation, dub timeline planning), and status.

POST  /videos/local                    — create a metadata-only project (origin="local")
POST  /videos/{uid}/analyze-frames     — dub: upload frame JPEGs + manifest → arq analyze_dub_local → {job_id}
POST  /videos/{uid}/analyze-video      — dub: upload proxy MP4s + manifest → arq analyze_dub_video_local → {job_id}
POST  /videos/{uid}/plan-dub           — dub: VO duration + clip durations → timeline JSON (sync LLM call)
POST  /videos/transcode               — web: upload ONE clip the browser cannot decode → arq transcode_for_web
GET   /videos/transcode/{token}        — web: download the converted MP4
DELETE /videos/transcode/{token}       — web: drop both files once collected
GET   /videos/storage                 — web: bytes used vs the plan's allowance
POST  /videos/poster                  — web: one key packet → a JPEG poster frame
GET   /videos/{uid}/files              — web: manifest of what the server holds
PUT   /videos/{uid}/files/{path}       — web: store one project file
GET   /videos/{uid}/files/{path}       — web: stream one project file (Range)
DELETE /videos/{uid}/files/{path}      — web: drop one project file
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

import asyncio
import json
import pathlib
import re
import uuid
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi import Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from packages.core.errors import format_exception_message
from packages.core.logging import get_logger
from packages.core.settings import get_settings
from packages.db.models.core_auth import Job, User
from packages.db.models.video_project import VideoProject
from packages.db.session import bind_tenant_search_path
from packages.llm.usage import UsageCtx, reset_usage_ctx, set_usage_ctx
from packages.video.quality import normalize_engine, normalize_precision
from packages.video.s3 import (
    delete_output_file,
    delete_scratch,
    list_output_files,
    open_output_range,
    output_relpath,
    pull_scratch_file,
    push_output_file,
    push_scratch_file,
    push_project_files,
    resolve_stored_output,
)
from packages.video.storage import data_root
from packages.video.timeline import cuts_duration, normalize_dub_edit_script
from packages.billing import estimate as estimator
from packages.billing import plan_features
from services.api.billing_start import load_run, release_on_error, settle_run, start_paid_run
from services.api.deps import CurrentUser, db_session
from services.api.routers.videos import _enqueue, _get_project

# Statuses a run may be (re)started from. "cancelled" is what pressing หยุดงาน
# leaves behind, so leaving it out made a stopped project permanently
# unstartable — every retry got a 400 while the app sat on its last progress
# message forever (live 2026-08-13). Only "processing" genuinely blocks a new
# start; everything else is a finished or abandoned run.
RESTARTABLE_STATUSES = ("pending", "error", "waiting_vo", "done", "cancelled")

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
    # AI quality tiers — see packages/video/quality.py. Unset/unknown values are
    # normalized to the defaults there rather than rejected: a client sending a
    # tier this server does not know yet must not fail project creation.
    engine: str | None = None
    precision: str | None = None


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
    #: The upload's name — matched against the multipart file names only. The
    #: server stores each proxy under a name of its own (``proxy_NNN.mp4``).
    file: str
    #: What the CLIENT says; kept for the prompt's clip bounds, never priced.
    durationSec: float = Field(gt=0)
    order: int = 0


class PlanDubIn(BaseModel):
    voDurationSec: float = Field(gt=0)
    clipDurations: list[float] = Field(min_length=1)
    # Where the attached music sits on the output timeline, so beat times
    # (measured on the whole file) can be moved to output time. Optional with
    # "untrimmed track at 0" defaults — clients that do not send them keep the
    # old behaviour. Same names the client's mix-music call uses.
    musicOffsetSec: float = Field(0.0, ge=0)
    musicTrimInSec: float = Field(0.0, ge=0)
    musicTrimOutSec: float | None = Field(None, gt=0)
    #: Continue on the top-up balance when the plan's windows are exhausted.
    allow_wallet: bool = False


def _music_window_kwargs(
    offset_sec: float, trim_in_sec: float, trim_out_sec: float | None
) -> dict[str, float]:
    """Job kwargs placing the music on the output timeline (music_beats_on_output).

    Empty for the default window, so the enqueued job keeps its old kwargs and
    a worker still running the previous code never sees an argument it does
    not accept.
    """
    if trim_out_sec is not None and trim_out_sec <= trim_in_sec:
        raise HTTPException(422, "ช่วงตัดเพลงไม่ถูกต้อง — จุดจบต้องอยู่หลังจุดเริ่ม")
    kwargs: dict[str, float] = {}
    if offset_sec:
        kwargs["music_offset_sec"] = offset_sec
    if trim_in_sec:
        kwargs["music_trim_in_sec"] = trim_in_sec
    if trim_out_sec is not None:
        kwargs["music_trim_out_sec"] = trim_out_sec
    return kwargs


class ReeditManifestIn(BaseModel):
    selectedLineIds: list[int] = Field(default_factory=list)
    instruction: str = Field(min_length=1, max_length=2000)


class LocalStatusIn(BaseModel):
    status: str
    error_msg: str | None = None


# ── helpers ───────────────────────────────────────────────────────────────────

#: Client proxies are 480 px tall (web/src/engine/jobs/extractProxy.ts, the
#: desktop sidecar's proxy.py), so their SHORT side is at most 480; +2 for the
#: even-width rounding. A bigger file is not a proxy: it costs upload time and
#: storage, and full-resolution footage at a high sampling rate is exactly what
#: the provider refuses outright — after billing the input (packages/llm/files.py).
PROXY_MAX_SHORT_SIDE = 482


async def _measure_upload(
    path: Path, *, label: str, max_short_side: int | None = None, max_sec: float | None = None
) -> float:
    """Length of a file the server just received, FAIL CLOSED (422).

    Every AI start is priced on footage the SERVER measured: a length the
    client states (``local_meta.clips``, a manifest's ``durationSec``) could be
    anything, while the provider bills the whole file. A file whose length
    cannot be read — not even by decoding it — is refused instead of counted
    as zero seconds (docs/token-billing-design.md §15, 2026-09-22 review)."""
    import asyncio

    from packages.video.ffmpeg_bin import MediaUnmeasurable, measure_media

    try:
        m = await asyncio.to_thread(measure_media, path)
    except MediaUnmeasurable:
        raise HTTPException(422, f"อ่านความยาวไฟล์{label}ไม่ได้ — กรุณาส่งไฟล์วิดีโอที่เปิดได้") from None
    if max_short_side and m.width and m.height and min(m.width, m.height) > max_short_side:
        raise HTTPException(422, f"ไฟล์{label}ความละเอียดสูงเกินไป — กรุณาสร้างไฟล์พรีวิวใหม่จากแอป")
    if max_sec is not None and m.duration_sec > max_sec:
        raise HTTPException(422, f"ไฟล์{label}ยาวเกิน {int(max_sec // 60)} นาที")
    return m.duration_sec


_REFERENCE_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}


class _StagedProxies:
    """Proxies written to a private staging folder and measured, waiting for
    the reservation. ``records`` are the manifest rows the worker will read
    (server-made file names; ``measuredSec`` = the probed length)."""

    def __init__(self, folder: Path, records: list[dict]) -> None:
        self.folder = folder
        self.records = records

    def discard(self) -> None:
        import shutil

        shutil.rmtree(self.folder, ignore_errors=True)

    def install(self, proxy_dir: Path) -> None:
        """Replace ``proxy_dir``'s proxies + manifest with the staged ones."""
        proxy_dir.mkdir(parents=True, exist_ok=True)
        for stale in proxy_dir.glob("proxy_*.mp4"):
            stale.unlink(missing_ok=True)
        for rec in self.records:
            (self.folder / rec["file"]).replace(proxy_dir / rec["file"])
        (proxy_dir / "proxy_manifest.json").write_text(
            json.dumps(self.records, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        self.discard()


async def _stage_proxies(
    uid: str, uploads: list[tuple[ProxyManifestEntry, UploadFile]]
) -> _StagedProxies:
    """Write each upload under a server-made name and measure it (422 when a
    file is unreadable or bigger than a proxy). The destination NAME is ours,
    never the client's: ``entry.file`` is free text from the request, and
    ``proxy_dir / "../../x"`` keeps the traversal while ``proxy_dir / "C:/..."``
    discards the base entirely — an arbitrary write on the API host, which
    also runs the worker and holds the provider keys."""
    folder = data_root() / "video_outputs" / uid / f".incoming-{uuid.uuid4().hex}"
    folder.mkdir(parents=True, exist_ok=True)
    records: list[dict] = []
    try:
        for idx, (entry, upload) in enumerate(uploads):
            stored = f"proxy_{idx:03d}.mp4"
            dest = folder / stored
            dest.write_bytes(await upload.read())
            seconds = await _measure_upload(dest, label="พรีวิวคลิป", max_short_side=PROXY_MAX_SHORT_SIDE)
            # The worker reads the file back through the manifest, so record the
            # name that actually exists on disk.
            records.append({**entry.model_dump(), "file": stored, "measuredSec": round(seconds, 3)})
    except BaseException:
        import shutil

        shutil.rmtree(folder, ignore_errors=True)
        raise
    return _StagedProxies(folder, records)


async def _measure_stored_proxies(proxy_dir: Path, manifest_file: Path) -> list[float]:
    """Measure the proxies an earlier upload left on disk (a re-edit that did
    not re-send them). The manifest is ours, but its lengths may be what a
    client stated before measuring existed — so the FILES are measured."""
    try:
        records = json.loads(manifest_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(400, "ไม่พบ proxy ของคลิปต้นฉบับ — กรุณา analyze ใหม่อีกครั้ง") from exc
    out: list[float] = []
    for rec in records if isinstance(records, list) else []:
        name = str((rec or {}).get("file") or "")
        path = proxy_dir / Path(name).name
        if name and path.is_file():
            out.append(await _measure_upload(path, label="พรีวิวคลิป"))
    if not out:
        raise HTTPException(400, "ไม่พบ proxy ของคลิปต้นฉบับ — กรุณา analyze ใหม่อีกครั้ง")
    return out


def _safe_upload_name(name: str) -> str:
    """A client file name used only as a KEY (manifest ↔ upload), never as a
    path. Refuses anything that is not a bare file name."""
    if (
        not name
        or name in (".", "..")
        or "/" in name
        or "\\" in name
        or ".." in name
        or ":" in name
        or name.startswith(".")
    ):
        raise HTTPException(422, f"ชื่อไฟล์ไม่ถูกต้อง: {name[:80]!r}")
    return name


async def _get_local_project(session: AsyncSession, uid: str, user_id: int) -> VideoProject:
    proj = await _get_project(session, uid, user_id)
    if proj.origin != "local":
        raise HTTPException(400, "endpoint นี้ใช้ได้เฉพาะโปรเจกต์ local-render")
    return proj


async def enforce_new_project(
    session: AsyncSession, user: User, *, declared_sec: float | None = None, adding: int = 1
) -> None:
    """A NEW project on this plan (docs/token-billing-plan.md §8): 403
    ``project_limit`` when the account already keeps the plan's maximum —
    existing projects are never touched — and 422 ``footage_over_limit`` when
    the footage the client declares is over the per-project cap. The declared
    length is only an early refusal; every start route re-checks the footage
    it measures itself (services/api/billing_start.py)."""
    if declared_sec is not None:
        refusal = plan_features.check_footage(user, float(declared_sec))
        if refusal is not None:
            raise HTTPException(422, refusal)
    if plan_features.project_limit(user) is None:
        return
    from sqlalchemy import func

    existing = (
        await session.execute(select(func.count()).select_from(VideoProject).where(VideoProject.user_id == user.id))
    ).scalar_one()
    refusal = plan_features.check_new_project(user, int(existing or 0), adding)
    if refusal is not None:
        raise HTTPException(403, refusal)


def enforce_feature(user: User, feature: plan_features.Feature) -> None:
    """403 ``plan_feature`` when the plan does not include ``feature``."""
    refusal = plan_features.check_feature(user, feature)
    if refusal is not None:
        raise HTTPException(403, refusal)


# ── endpoints ─────────────────────────────────────────────────────────────────

@router.post("/local", response_model=LocalProjectOut, status_code=201)
async def create_local_project(
    auth: CurrentUser,
    body: LocalProjectIn,
    session: AsyncSession = Depends(db_session),
) -> LocalProjectOut:
    allowed = ("dub_first", "talking_head", "highlight", "speech_highlights", "speech_scenes")
    if body.mode not in allowed:
        raise HTTPException(400, f"local-render รองรับเฉพาะโหมด {', '.join(allowed)}")
    await enforce_new_project(session, auth.user, declared_sec=sum(c.durationSec for c in body.clips))

    proj = VideoProject(
        user_id=auth.user_id,
        tenant_slug=auth.tenant_slug,
        mode=body.mode,
        status="pending",
        origin="local",
        brief=body.brief or None,
        user_script=body.user_script or None,
        # speech_highlights has no target length: a highlight that stands on its
        # own ends where the thought ends, so a number fixed before the clip is
        # read leaves the selector only bad options — pad past the ending or cut
        # before it (owner, 2026-09-23). Dropped HERE rather than only in the
        # web UI, because a client that still sends one — a desktop build from
        # before the change — must get the same cut.
        target_duration_sec=(
            None if body.mode == "speech_highlights" else body.target_duration_sec
        ),
        # duration_mode only ever mattered for talking_head's now-removed highlight
        # mode; dub_first's own target_duration_sec (script length) is independent
        # of this column. Always "full" — see plan_core.build_talking_head_timeline.
        duration_mode="full",
        local_meta={"clips": [c.model_dump() for c in body.clips]},
        caption_style=body.caption_style.model_dump() if body.caption_style else None,
        engine=normalize_engine(body.engine) if body.engine else None,
        precision=normalize_precision(body.precision) if body.precision else None,
        source_files=[],
    )
    session.add(proj)
    await session.flush()
    await session.commit()
    log.info(
        "local_project_created",
        uid=proj.uid,
        clips=len(body.clips),
        engine=proj.engine,
        precision=proj.precision,
        target_duration_sec=proj.target_duration_sec,
    )
    return LocalProjectOut(uid=proj.uid)


@router.post("/{uid}/analyze-frames", response_model=AnalyzeFramesOut, status_code=202)
async def analyze_frames(
    uid: str,
    auth: CurrentUser,
    request: Request,
    session: AsyncSession = Depends(db_session),
    files: list[UploadFile] = File(...),
    manifest: str = Form(...),
    music_offset_sec: float = Form(0.0, ge=0),
    music_trim_in_sec: float = Form(0.0, ge=0),
    music_trim_out_sec: float | None = Form(None, gt=0),
    allow_wallet: bool = Form(False),
) -> AnalyzeFramesOut:
    proj = await _get_local_project(session, uid, auth.user_id)
    if proj.mode not in ("dub_first", "highlight"):
        raise HTTPException(400, "analyze-frames ใช้ได้เฉพาะโหมด dub_first / highlight")
    music_window = _music_window_kwargs(music_offset_sec, music_trim_in_sec, music_trim_out_sec)
    if proj.status not in RESTARTABLE_STATUSES:
        raise HTTPException(400, f"โปรเจกต์นี้ยังทำงานอยู่ (สถานะ {proj.status}) — กดหยุดงานก่อนถ้าจะเริ่มใหม่")

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

    # Reserve BEFORE anything is stored (docs/token-billing-design.md §6.1),
    # priced on the frames this request actually carries — each is one image
    # to the model — not on clip lengths the client stated.
    run_id = await start_paid_run(
        auth, request,
        estimator.estimate_run(
            kind="analyze_frames", engine=proj.engine, precision=proj.precision,
            frame_count=len(files),
        ),
        allow_wallet=allow_wallet, job_id=f"vlocal_{uid[:8]}", reference_id=uid,
        mode=proj.mode, engine=proj.engine, precision=proj.precision,
    )
    async with release_on_error(run_id):
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

        await _enqueue(
            job_id, "analyze_dub_local",
            project_uid=uid, tenant_slug=auth.tenant_slug, run_id=run_id, **music_window, user=auth.user,
        )
    return AnalyzeFramesOut(job_id=job_id)


@router.post("/{uid}/analyze-video", response_model=AnalyzeFramesOut, status_code=202)
async def analyze_video(
    uid: str,
    auth: CurrentUser,
    request: Request,
    session: AsyncSession = Depends(db_session),
    files: list[UploadFile] = File(...),
    manifest: str = Form(...),
    style_uid: str = Form(""),
    brief: str = Form(""),
    engine: str = Form(""),
    precision: str = Form(""),
    music_offset_sec: float = Form(0.0, ge=0),
    music_trim_in_sec: float = Form(0.0, ge=0),
    music_trim_out_sec: float | None = Form(None, gt=0),
    allow_wallet: bool = Form(False),
) -> AnalyzeFramesOut:
    """dub_first: receive per-clip proxy MP4s (Gemini native-video path).

    ``style_uid`` — an OPTIONAL saved kind="cut" EffectStyle whose distilled
    prose steers the edit-script prompt. It travels with the job as a kwarg
    and the worker resolves the prose from the DB at run time — nothing is
    persisted to disk/S3 (a stale style file resurrected by an S3 pull must
    never override the user's current choice; see plan-effects' 2026-07-18
    note).

    ``brief`` — OPTIONAL replacement for the stored brief, for this run and
    every later one. The desktop "ให้ AI ตัดใหม่" flow sends the original brief
    with the user's recut comments appended; the brief only reaches the model
    through the project row (create-time is the only other place it is set), so
    a re-analyze with no way to update it would silently drop the comments.
    Empty means "keep what is stored" — never blank an existing brief.

    ``music_offset_sec`` / ``music_trim_in_sec`` / ``music_trim_out_sec`` —
    OPTIONAL placement of the attached music on the output timeline, so the
    stored beat times (file time) reach the prompt as output time. Same
    contract on analyze-frames and reedit-dub-scenes; defaults = untrimmed
    track at 0.
    """
    proj = await _get_local_project(session, uid, auth.user_id)
    if proj.mode not in ("dub_first", "highlight"):
        raise HTTPException(400, "analyze-video ใช้ได้เฉพาะโหมด dub_first / highlight")
    music_window = _music_window_kwargs(music_offset_sec, music_trim_in_sec, music_trim_out_sec)
    if proj.status not in RESTARTABLE_STATUSES:
        raise HTTPException(400, f"โปรเจกต์นี้ยังทำงานอยู่ (สถานะ {proj.status}) — กดหยุดงานก่อนถ้าจะเริ่มใหม่")

    new_brief = brief.strip()
    if new_brief and new_brief != (proj.brief or ""):
        proj.brief = new_brief
        await session.flush()
        log.info("analyze_video_brief_updated", uid=uid, chars=len(new_brief))

    # Quality tiers travel with the run AND are persisted: the worker reads the
    # project row, so a retry or resume repeats the tier the user paid for.
    # Empty means "keep what is stored" — a re-analyze that omits them must not
    # silently downgrade a Pro project, same rule as `brief` above.
    if engine.strip():
        proj.engine = normalize_engine(engine)
    if precision.strip():
        proj.precision = normalize_precision(precision)
    if engine.strip() or precision.strip():
        await session.flush()
        log.info(
            "analyze_video_tiers", uid=uid, engine=proj.engine, precision=proj.precision
        )

    chosen_style_uid = style_uid.strip()
    if chosen_style_uid:
        from packages.db.models.effect_style import EffectStyle

        style = await session.get(EffectStyle, chosen_style_uid)
        if style is None or style.user_id != auth.user_id:
            raise HTTPException(404, "ไม่พบสไตล์นี้")
        if style.kind != "cut":
            raise HTTPException(400, "สไตล์นี้ไม่ใช่สไตล์การตัด")
        if style.system_prompt:
            log.info(
                "analyze_video_style_selected",
                uid=uid,
                style_uid=chosen_style_uid,
                style_name=style.name,
                prompt_chars=len(style.system_prompt),
            )
        else:
            # Not distilled yet (or distillation failed) — proceed with the
            # default prompt; the worker treats an empty prose as no style.
            log.warning(
                "analyze_video_style_empty_prompt",
                uid=uid,
                style_uid=chosen_style_uid,
                style_name=style.name,
            )

    try:
        entries = [ProxyManifestEntry.model_validate(e) for e in json.loads(manifest)]
    except (json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(422, f"manifest ไม่ถูกต้อง: {exc}") from exc

    by_file = {_safe_upload_name(e.file): e for e in entries}
    uploaded_names = [f.filename for f in files]
    missing = set(by_file) - set(uploaded_names)
    extra = set(uploaded_names) - set(by_file)
    if missing or extra:
        raise HTTPException(422, f"manifest/ไฟล์ไม่ตรงกัน (missing={sorted(missing)}, extra={sorted(extra)})")

    # The footage is measured BEFORE the reservation, because the reservation
    # is priced on it: the proxies land in a staging folder, are probed, and
    # only move into place once the run is reserved (a refused start leaves
    # nothing behind — docs/token-billing-design.md §6.1).
    root = data_root()
    staging = await _stage_proxies(uid, [(by_file[f.filename or ""], f) for f in files])
    try:
        run_id = await start_paid_run(
            auth, request,
            estimator.estimate_run(
                kind="analyze_video", engine=proj.engine, precision=proj.precision,
                clip_secs=[rec["measuredSec"] for rec in staging.records],
            ),
            allow_wallet=allow_wallet, job_id=f"vlocal_{uid[:8]}", reference_id=uid,
            mode=proj.mode, engine=proj.engine, precision=proj.precision,
        )
    except BaseException:
        staging.discard()
        raise
    async with release_on_error(run_id):
        staging.install(root / "video_outputs" / uid / "proxy")
        await push_project_files(uid)  # proxy MP4s + manifest only

        job_id = f"vlocal_{uid[:8]}"
        await session.execute(text("SET search_path TO core, public"))
        existing = await session.get(Job, job_id)
        queued = {
            "step": "queued",
            "message": "รับวิดีโอแล้ว รอ worker วิเคราะห์…",
            "style_uid": chosen_style_uid or None,
        }
        if existing:
            existing.status = "queued"
            existing.progress = 2
            existing.result = queued
            existing.error = None
        else:
            session.add(Job(
                id=job_id,
                tenant_id=auth.tenant_id,
                type="video_edit",
                status="queued",
                progress=2,
                result=queued,
            ))
        await bind_tenant_search_path(session, auth.tenant_slug)
        proj.status = "processing"
        proj.job_id = job_id
        await session.commit()

        # style_uid travels with the job; the worker resolves the prose from the
        # DB at run time (DB is the only source — no style file on disk/S3).
        await _enqueue(
            job_id,
            "analyze_dub_video_local",
            project_uid=uid,
            tenant_slug=auth.tenant_slug,
            style_uid=chosen_style_uid,
            run_id=run_id,
            **music_window, user=auth.user,
        )
    return AnalyzeFramesOut(job_id=job_id)


@router.post("/{uid}/plan-dub")
async def plan_dub(
    uid: str,
    auth: CurrentUser,
    body: PlanDubIn,
    request: Request,
    session: AsyncSession = Depends(db_session),
) -> dict:
    proj = await _get_local_project(session, uid, auth.user_id)
    if not proj.edit_script_path:
        raise HTTPException(400, "ยังไม่มี edit script — ต้อง analyze ก่อน")
    # Validation only — the values go to plan_dub_timeline_cuts directly.
    _music_window_kwargs(body.musicOffsetSec, body.musicTrimInSec, body.musicTrimOutSec)

    root = data_root()
    try:
        edit_script_file = await resolve_stored_output(uid, proj.edit_script_path)
    except FileNotFoundError as exc:
        raise HTTPException(404, "edit_script.json หายจาก server") from exc
    edit_script = json.loads(edit_script_file.read_text(encoding="utf-8"))

    from packages.billing import guard
    from packages.video.dub_ai import plan_dub_timeline_cuts

    # The only route that calls a model itself: it reserves, meters and
    # settles inline instead of in a worker (docs/token-billing-design.md §6.1).
    run_id = await start_paid_run(
        auth, request, estimator.estimate_run(kind="plan_dub", engine=proj.engine, precision=proj.precision),
        allow_wallet=body.allow_wallet, job_id=None, reference_id=uid,
        mode=proj.mode, engine=proj.engine, precision=proj.precision,
    )
    run = await load_run(run_id)
    usage_token = set_usage_ctx(
        UsageCtx(
            user_id=auth.user_id, tenant_id=auth.tenant_id, feature="video_cut", reference_id=uid, run_id=run_id,
        )
    )
    outcome = "our_failure"
    meter_token = guard.set_meter(guard.meter_for_run(run) if run is not None else None)
    try:
        render_cuts = await plan_dub_timeline_cuts(
            edit_script,
            body.voDurationSec,
            body.clipDurations,
            music_beats=proj.music_beats,
            music_offset_sec=body.musicOffsetSec,
            music_trim_in_sec=body.musicTrimInSec,
            music_trim_out_sec=body.musicTrimOutSec,
        )
        outcome = "ok"
    except guard.RunBudgetExceeded as exc:
        outcome = "limit_stop"
        raise HTTPException(
            402, {"code": "limit_stop", "message": guard.LIMIT_STOP_MESSAGE},
        ) from exc
    except guard.ServicePaused as exc:
        raise HTTPException(
            503, {"code": "service_paused", "message": guard.SERVICE_PAUSED_MESSAGE},
        ) from exc
    except ValueError as exc:
        outcome = "user_error"
        # Through the SAME funnel the Exception arm below uses. `str(exc)`
        # forwarded the raiser's literal text -- which named the vendor -- into
        # a persisted error the project card then displayed in every browser.
        raise HTTPException(422, format_exception_message(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        # This is the only route that calls a model synchronously — everywhere
        # else the worker catches and stores the reason. Letting a provider
        # error escape here does not produce a 500: it propagates out of the
        # ASGI app, uvicorn drops the connection, and the browser reports it as
        # a missing CORS header (measured 2026-09-08 with an exhausted API
        # credit balance). The client then shows "HTTP 0" for what is actually
        # "เครดิต AI หมด".
        log.warning("local_plan_dub_failed", uid=uid, error=str(exc))
        raise HTTPException(502, format_exception_message(exc)) from exc
    finally:
        guard.reset_meter(meter_token)
        reset_usage_ctx(usage_token)
        await settle_run(run_id, outcome)

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


# ── web-only: convert a clip the browser cannot decode ───────────────────────
#
# The web build renders on the user's machine and uploads no video. This is the
# one exception, and it exists because a browser simply cannot decode some
# codecs — HEVC above all, which every recent iPhone records by default. The
# client sends ONLY clips it failed to open; H.264 is remuxed locally and never
# arrives here.
#
# Deliberately NOT project-scoped. A conversion is stateless — one file in, one
# file out — and tying it to a project row would force the row to exist before
# the import that creates it. The scratch lives under the user's own id and is
# deleted the moment the client collects the result: the server is a converter,
# not a store.

_TRANSCODE_SUFFIXES = {".mov", ".mp4", ".m4v", ".mkv", ".avi", ".webm", ".3gp", ".mts", ".m2ts"}

#: A single key packet in a container. Measured at 48 KB for a 1080x1920 HEVC
#: frame; the cap is generous enough for a 4K one and far below a real clip.
POSTER_MAX_BYTES = 8 * 1024 * 1024


class TranscodeOut(BaseModel):
    job_id: str
    token: str


def _transcode_dir(user_id: int, token: str) -> Path:
    """Scratch for one conversion. `token` is validated by the caller."""
    return data_root() / "video_transcode" / str(user_id) / token


def _safe_token(token: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,64}", token):
        raise HTTPException(400, "token ไม่ถูกต้อง")
    return token


@router.post("/transcode", response_model=TranscodeOut, status_code=202)
async def transcode_clip(
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
    file: UploadFile = File(...),
) -> TranscodeOut:
    enforce_feature(auth.user, "transcode")
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in _TRANSCODE_SUFFIXES:
        raise HTTPException(422, f"ไฟล์ประเภทนี้ไม่รองรับ ({suffix or 'ไม่ทราบนามสกุล'})")

    token = uuid.uuid4().hex
    base = _transcode_dir(auth.user_id, token)
    base.mkdir(parents=True, exist_ok=True)

    name = f"source{suffix}"
    dest = base / name
    # Streamed in chunks: these are whole camera files, and reading one into
    # memory to write it straight back out is a needless copy of hundreds of MB.
    size = 0
    with dest.open("wb") as out:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            out.write(chunk)

    # The worker may be a different machine (Railway runs api and worker as
    # separate services). No-op on a single host.
    await push_scratch_file(auth.user_id, token, dest)

    job_id = f"vtrans_{token[:12]}"
    session.add(Job(
        id=job_id,
        tenant_id=auth.tenant_id,
        type="video_transcode",
        status="queued",
        progress=2,
        result={"step": "queued", "message": "รอคิวแปลงไฟล์…"},
    ))
    await session.commit()

    await _enqueue(
        job_id,
        "transcode_for_web",
        user_id=auth.user_id,
        token=token,
        filename=name, user=auth.user,
    )
    log.info("transcode_queued", user_id=auth.user_id, token=token, bytes=size)
    return TranscodeOut(job_id=job_id, token=token)


@router.get("/transcode/{token}")
async def download_transcoded(token: str, auth: CurrentUser) -> FileResponse:
    out = _transcode_dir(auth.user_id, _safe_token(token)) / "converted.mp4"
    # The worker wrote this, possibly on another host.
    if not await pull_scratch_file(auth.user_id, _safe_token(token), out):
        raise HTTPException(404, "ยังไม่มีไฟล์ที่แปลงแล้ว")
    return FileResponse(str(out), media_type="video/mp4", filename="converted.mp4")


@router.delete("/transcode/{token}", status_code=204)
async def drop_transcoded(token: str, auth: CurrentUser) -> Response:
    """Called the moment the client has the bytes. The server keeps no video."""
    import asyncio
    import shutil

    base = _transcode_dir(auth.user_id, _safe_token(token))
    if base.is_dir():
        await asyncio.to_thread(shutil.rmtree, base, True)
    # Both copies, always — the local tree may be empty on this host while the
    # objects are still costing storage.
    await delete_scratch(auth.user_id, _safe_token(token))
    log.info("transcode_dropped", user_id=auth.user_id, token=token)
    return Response(status_code=204)


# ── web-only: a poster frame for a clip the browser cannot decode ────────────
#
# HEVC demuxes everywhere and decodes only where the platform has an HEVC
# decoder, so on most of Windows the browser can read a clip's packets but not
# turn any of them into a picture. The client therefore cuts the FIRST KEY
# PACKET into a tiny self-contained MP4 (~48 KB out of a 9 MB source, 11 ms)
# and sends only that.
#
# One ffmpeg frame decode, answered inline: the input is a few tens of KB, so a
# queue would cost more than the work. Nothing is kept — the file is written to
# a temp dir and deleted in the same request.

@router.post("/poster", response_class=Response)
async def decode_poster_frame(
    auth: CurrentUser,
    file: UploadFile = File(...),
) -> Response:
    import asyncio
    import shutil
    import tempfile

    raw = await file.read(POSTER_MAX_BYTES + 1)
    if len(raw) > POSTER_MAX_BYTES:
        # A whole clip does not belong here; the client sends one key packet.
        raise HTTPException(413, "ไฟล์ใหญ่เกินสำหรับดึงภาพตัวอย่าง")

    tmpdir = pathlib.Path(tempfile.mkdtemp(prefix="poster-"))
    try:
        src = tmpdir / "in.mp4"
        src.write_bytes(raw)
        out = tmpdir / "poster.jpg"

        def _extract() -> None:
            import ffmpeg

            from packages.video.ffmpeg_bin import run_ffmpeg

            stream = ffmpeg.input(str(src)).output(
                str(out), vframes=1, format="image2", vcodec="mjpeg",
                **{"q:v": 4, "vf": "scale=-2:256"},
            )
            run_ffmpeg(stream.overwrite_output(), label="poster_frame")

        await asyncio.to_thread(_extract)
        if not out.is_file():
            raise HTTPException(422, "ดึงภาพตัวอย่างจากไฟล์นี้ไม่ได้")
        data = out.read_bytes()
        log.info("poster_frame_made", user_id=auth.user_id, in_bytes=len(raw), out_bytes=len(data))
        return Response(content=data, media_type="image/jpeg")
    finally:
        await asyncio.to_thread(shutil.rmtree, tmpdir, True)


# ── web-only: the server as the home of a project's files ────────────────────
#
# The web build renders on the user's machine, and that has not changed. What
# changed (2026-09-08) is where the FILES live. Browser storage is per profile:
# a project made in one browser does not exist in another, and Safari discards
# it after seven unused days. Nothing client-side fixes that.
#
# So the server stores the bytes and the browser keeps a cache in front of
# them. It still does not edit: no cut, no AI, no render happens here.
#
# The desktop build never calls any of this — it owns a real folder.

#: Everything a web project can store. A path outside this list is refused
#: rather than written: the store must not become a place to put arbitrary
#: files, and every real name is already known.
_WEB_FILE_ROOTS = ("normalized", "clips", "highlights", "captions", "voiceover", "music", "fx")
_WEB_FILE_NAMES = (
    "project.json",
    "final.mp4",
    "final_silent.mp4",
    "final_silent_music.mp4",
    "final_fx.mp4",
    "script.txt",
    "dub_bundle.zip",
    "final_bundle.zip",
    "capcut_bundle.zip",
    "manifest.json",
    "upload_sources.json",
    "edit_script.json",
    "timeline.json",
    "effects.json",
)


def _web_file_path(uid: str, rel: str) -> Path:
    """Resolve a project-relative path, refusing anything that escapes it."""
    cleaned = rel.strip().lstrip("/")
    segments = cleaned.split("/")
    if not cleaned or ".." in segments:
        raise HTTPException(400, "path ไม่ถูกต้อง")
    # Dot-prefixed names are the atomic-write staging convention on every side
    # of this system. One that reached the store was invisible to the manifest,
    # the quota and the stale sweep -- storable, hidden, undeletable.
    if any(seg.startswith(".") for seg in segments):
        raise HTTPException(400, "path ไม่ถูกต้อง")
    head = cleaned.split("/")[0]
    if head not in _WEB_FILE_ROOTS and cleaned not in _WEB_FILE_NAMES:
        raise HTTPException(400, f"ไฟล์นี้เก็บบนเซิร์ฟเวอร์ไม่ได้: {cleaned}")

    base = (data_root() / "video_outputs" / uid).resolve()
    target = (base / cleaned).resolve()
    # Belt and braces: the `..` check above is on the request string, this is on
    # the resolved path, and a symlink could still land outside without it.
    if base != target and base not in target.parents:
        raise HTTPException(400, "path ไม่ถูกต้อง")
    return target


def _rel_of(path: Path, uid: str) -> str:
    """A stored path back to its project-relative form, for the S3 key."""
    return path.relative_to((data_root() / "video_outputs" / uid).resolve()).as_posix()


def _human_bytes(n: int) -> str:
    """A size a person can read. Picks the unit rather than assuming GB — a
    quota set in MB rendered as "0 GB", which reads as a bug rather than a
    limit."""
    for unit, step in (("GB", 1024**3), ("MB", 1024**2), ("KB", 1024)):
        if n >= step:
            return f"{n / step:.1f} {unit}"
    return f"{n} B"


class StorageOut(BaseModel):
    used_bytes: int
    quota_bytes: int
    plan: str
    project_count: int


async def _project_files(uid: str) -> dict[str, int]:
    """Every stored file for one project as {relative path: bytes}.

    Local disk AND object storage, merged by path. Either can be the only copy:
    on a single host nothing is in S3, and on an ephemeral container the local
    tree is empty after a redeploy while every byte is still in the bucket. A
    reader that consults one of them reports a project as empty exactly when it
    matters most.
    """
    import asyncio

    base = data_root() / "video_outputs" / uid

    def _walk() -> dict[str, int]:
        found: dict[str, int] = {}
        if not base.is_dir():
            return found
        for f in base.rglob("*"):
            if f.is_file() and not f.name.startswith("."):
                found[f.relative_to(base).as_posix()] = f.stat().st_size
        return found

    merged = await asyncio.to_thread(_walk)
    for rel, size in await list_output_files(uid):
        merged.setdefault(rel, size)
    return merged


#: user_id -> (monotonic deadline, used_bytes, project_count). A sync uploads
#: dozens of files back to back, and the walk behind the quota check touches
#: every project on the account (an S3 LIST each). Within one sync the answer
#: barely moves, and the projection adds the incoming file's own size anyway --
#: so a short cache turns O(files x projects) back into O(projects).
_USED_CACHE: dict[int, tuple[float, int, int]] = {}
_USED_CACHE_TTL_SEC = 20.0
#: The last measured value per user, kept past the TTL: a read-only meter
#: (GET /usage/me) shows this instead of waiting on a fresh walk.
_USED_LAST: dict[int, tuple[int, int]] = {}
#: Projects measured at once. One S3 LIST each; sequential, 40 projects cost
#: seconds on every settings-page load (2026-09-22).
_USED_WALK_CONCURRENCY = 8


async def _storage_used(session: AsyncSession, user_id: int) -> tuple[int, int]:
    """Bytes this user's projects occupy on the server, and how many there are.

    Measured from the files rather than a running total: a total that drifts is
    worse than one that costs a walk, and the files are the only thing that
    actually consumes the storage.

    The COUNT is of projects that still hold files, not of rows. An account
    that has been in use for a while accumulates rows for runs that left
    nothing behind — cancelled, errored, or cleaned up long ago — and counting
    those made the panel report "162 โปรเจกต์" to someone looking at two.
    A number the user cannot reconcile with what they see reads as a bug in the
    quota, which is the one number here that has to be believed.
    """
    import time

    cached = _USED_CACHE.get(user_id)
    if cached and cached[0] > time.monotonic():
        return cached[1], cached[2]

    rows = (
        await session.execute(
            select(VideoProject.uid).where(VideoProject.user_id == user_id)
        )
    ).scalars().all()
    return await _walk_storage(user_id, list(rows))


async def _walk_storage(user_id: int, rows: list[str]) -> tuple[int, int]:
    """Measure the given projects' files — no database access, so it can run
    on after the request that started it has moved on."""
    import time

    gate = asyncio.Semaphore(_USED_WALK_CONCURRENCY)

    async def _size(uid: str) -> int:
        async with gate:
            return sum((await _project_files(uid)).values())

    sizes = await asyncio.gather(*(_size(uid) for uid in rows))
    total = sum(sizes)
    stored = sum(1 for size in sizes if size)
    _USED_CACHE[user_id] = (time.monotonic() + _USED_CACHE_TTL_SEC, total, stored)
    _USED_LAST[user_id] = (total, stored)
    return total, stored


async def storage_used_for_display(
    session: AsyncSession, user_id: int, *, wait_sec: float = 1.5
) -> tuple[int, int] | None:
    """`_storage_used` for a meter that must not stall a page.

    Waits at most `wait_sec` for a fresh walk; past that, answers with the last
    measured value (None if there has never been one) and lets the walk finish
    in the background, so the next load has it. Quota ENFORCEMENT keeps calling
    `_storage_used` directly — only display may be a little stale. The project
    list is read here, on the request's session; only the file walk (no
    database) outlives the request.
    """
    import time

    cached = _USED_CACHE.get(user_id)
    if cached and cached[0] > time.monotonic():
        return cached[1], cached[2]
    rows = (
        await session.execute(
            select(VideoProject.uid).where(VideoProject.user_id == user_id)
        )
    ).scalars().all()
    task = asyncio.ensure_future(_walk_storage(user_id, list(rows)))
    try:
        return await asyncio.wait_for(asyncio.shield(task), timeout=wait_sec)
    except TimeoutError:
        return _USED_LAST.get(user_id)


async def _quota_for(session: AsyncSession, user_id: int) -> tuple[int, str]:
    """The plan's storage allowance for this user. 0 means unlimited.

    Per plan from packages/billing/limits.py (Free 1 GB … Max 100 GB). Admin /
    internal accounts are unlimited like enterprise. A downgrade that leaves
    an account over its new allowance only refuses NEW bytes — nothing is
    ever deleted automatically (owner, 2026-09-22).
    """
    user = await session.get(User, user_id)
    plan = str(getattr(user, "plan", None) or "free")
    if bool(getattr(user, "is_admin", False)):
        return 0, plan
    return get_settings().plan_storage_limit(plan), plan


async def enforce_storage_quota(session: AsyncSession, user_id: int, incoming_bytes: int) -> None:
    """507 when ``incoming_bytes`` more would take the account past its plan's
    storage. For routes that keep uploaded bytes on the server (the server
    pipeline's uploads); ``put_web_file`` does its own replace-aware check."""
    quota, _plan = await _quota_for(session, user_id)
    if not quota:
        return
    used, _ = await _storage_used(session, user_id)
    projected = used + max(0, int(incoming_bytes))
    if projected > quota:
        raise HTTPException(
            507,
            f"พื้นที่เก็บเต็มแล้ว ({_human_bytes(projected)} จาก "
            f"{_human_bytes(quota)}) — ลบโปรเจกต์เก่าออกก่อน",
        )


@router.get("/storage", response_model=StorageOut)
async def get_storage(
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
) -> StorageOut:
    """What this account is using on the server, and what its plan allows."""
    used, count = await _storage_used(session, auth.user_id)
    quota, plan = await _quota_for(session, auth.user_id)
    return StorageOut(used_bytes=used, quota_bytes=quota, plan=plan, project_count=count)


class WebFileEntry(BaseModel):
    path: str
    bytes: int


@router.get("/{uid}/files", response_model=list[WebFileEntry])
async def list_web_files(
    uid: str,
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
) -> list[WebFileEntry]:
    """What the server holds for this project — the manifest a fresh browser reads."""
    await _get_local_project(session, uid, auth.user_id)
    out: list[WebFileEntry] = []
    for rel, size in sorted((await _project_files(uid)).items()):
        head = rel.split("/")[0]
        if head not in _WEB_FILE_ROOTS and rel not in _WEB_FILE_NAMES:
            continue
        out.append(WebFileEntry(path=rel, bytes=size))
    return out


@router.put("/{uid}/files/{rel:path}", response_model=WebFileEntry)
async def put_web_file(
    uid: str,
    rel: str,
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
    file: UploadFile = File(...),
) -> WebFileEntry:
    await _get_local_project(session, uid, auth.user_id)
    dest = _web_file_path(uid, rel)
    dest.parent.mkdir(parents=True, exist_ok=True)

    # The plan's allowance, checked BEFORE the bytes are accepted. A file that
    # is replacing one already there costs only the difference, so re-rendering
    # the same project forever cannot creep over the line.
    #
    # quota == 0 means unlimited -- and skips the walk entirely: the check used
    # to enumerate EVERY project on the account (one S3 LIST each) on EVERY
    # file of every sync, which made saving a render O(projects × files).
    quota, plan = await _quota_for(session, auth.user_id)
    replacing = dest.stat().st_size if dest.is_file() else 0

    # Staged then renamed: a half-written file that another browser starts
    # streaming would be indistinguishable from a complete one.
    tmp = dest.with_name(f".{dest.name}.part")
    size = 0
    try:
        with tmp.open("wb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                out.write(chunk)

        if quota:
            # `_project_files` skips dot-prefixed names, so the staged `.part`
            # is NOT in `used` -- the incoming size has to be added explicitly.
            # The old arithmetic left it out, so every plan could be overshot
            # by one whole render.
            used, _ = await _storage_used(session, auth.user_id)
            projected = used + size - replacing
            if projected > quota:
                raise HTTPException(
                    507,
                    f"พื้นที่เก็บเต็มแล้ว ({_human_bytes(projected)} จาก "
                    f"{_human_bytes(quota)}) — ลบโปรเจกต์เก่าออกก่อน",
                )
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    tmp.replace(dest)
    _ = plan

    # ONE object, not the whole tree: `push_project_files` re-uploads every
    # output the project has, so calling it per PUT made a sync of N files cost
    # N²/2 object writes.
    await push_output_file(uid, _rel_of(dest, uid), dest)
    log.info("web_file_stored", uid=uid, path=rel, bytes=size)
    return WebFileEntry(path=rel, bytes=size)


@router.get("/{uid}/files/{rel:path}", response_model=None)
async def get_web_file(
    uid: str,
    rel: str,
    request: Request,
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
) -> Response:
    """Stream one file. `FileResponse` answers Range requests, which is what
    lets a `<video>` in another browser seek without downloading the whole
    clip first."""
    await _get_local_project(session, uid, auth.user_id)
    dest = _web_file_path(uid, rel)
    if not dest.is_file():
        # Only on S3 (another host rendered it, or this container is fresh
        # after a deploy): serve the requested byte range straight from the
        # bucket instead of downloading the whole clip first.
        ranged = await open_output_range(uid, output_relpath(uid, f"video_outputs/{uid}/{rel}"), request.headers.get("range"))
        if ranged is not None:
            import mimetypes

            from fastapi.responses import StreamingResponse

            media_type = mimetypes.guess_type(dest.name)[0] or "application/octet-stream"
            return StreamingResponse(
                ranged.iter_chunks(), status_code=ranged.status, headers=ranged.headers, media_type=media_type
            )
        raise HTTPException(404, "ไม่พบไฟล์นี้")
    return FileResponse(str(dest), filename=dest.name)


@router.delete("/{uid}/files/{rel:path}", status_code=204)
async def delete_web_file(
    uid: str,
    rel: str,
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
) -> Response:
    await _get_local_project(session, uid, auth.user_id)
    dest = _web_file_path(uid, rel)
    if dest.is_file():
        dest.unlink()
    # ALWAYS, not only when this host held a local copy: on an ephemeral or
    # multi-host deploy the file often exists only in the bucket, and gating
    # the S3 delete on the local unlink returned a silent 204 no-op -- the
    # object stayed in the bucket, in the manifest and in the quota forever.
    await delete_output_file(uid, rel)
    log.info("web_file_deleted", uid=uid, path=rel)
    return Response(status_code=204)


@router.post("/{uid}/transcribe-audio", response_model=AnalyzeFramesOut, status_code=202)
async def transcribe_audio(
    uid: str,
    auth: CurrentUser,
    request: Request,
    session: AsyncSession = Depends(db_session),
    files: list[UploadFile] = File(...),
    style_uid: str = Form(""),
    allow_wallet: bool = Form(False),
) -> AnalyzeFramesOut:
    """Speech modes: receive speech WAVs → transcribe + plan on the server.

    talking_head (silence cut) plus the R17 speech modes — all three decide
    their cuts from word timings, so no video ever leaves the creator's
    machine here. ``style_uid`` is only read by ``speech_scenes`` (a saved
    kind="cut" style); the other modes ignore it. Older desktop builds that
    still attach ``video_files`` are unaffected — FastAPI ignores multipart
    fields the signature does not declare.
    """
    proj = await _get_local_project(session, uid, auth.user_id)
    speech_modes = ("talking_head", "speech_scenes", "speech_highlights")
    if proj.mode not in speech_modes:
        raise HTTPException(
            400, f"transcribe-audio ใช้ได้เฉพาะโหมดที่ตัดจากเสียง ({', '.join(speech_modes)})"
        )
    if proj.status not in RESTARTABLE_STATUSES:
        raise HTTPException(400, f"โปรเจกต์นี้ยังทำงานอยู่ (สถานะ {proj.status}) — กดหยุดงานก่อนถ้าจะเริ่มใหม่")

    import re

    name_re = re.compile(r"^audio_\d{3}\.wav$")
    for f in files:
        if not f.filename or not name_re.match(f.filename):
            raise HTTPException(422, f"ชื่อไฟล์เสียงต้องเป็น audio_NNN.wav (ได้ {f.filename})")

    # The WAVs ARE what gets transcribed (and billed per second), so they are
    # measured before the reservation, which is priced on them — never on the
    # clip lengths the client stated. They wait in staging until then.
    root = data_root()
    staging = root / "video_outputs" / uid / f".incoming-audio-{uuid.uuid4().hex}"
    try:
        staging.mkdir(parents=True, exist_ok=True)
        audio_secs: list[float] = []
        for f in files:
            dest = staging / str(f.filename)
            dest.write_bytes(await f.read())
            audio_secs.append(await _measure_upload(dest, label="เสียง"))
        run_id = await start_paid_run(
            auth, request,
            estimator.estimate_run(
                kind="transcribe_audio", engine=proj.engine, precision=proj.precision,
                clip_secs=audio_secs,
            ),
            allow_wallet=allow_wallet, job_id=f"vlocal_{uid[:8]}", reference_id=uid,
            mode=proj.mode, engine=proj.engine, precision=proj.precision,
        )
    except BaseException:
        import shutil

        shutil.rmtree(staging, ignore_errors=True)
        raise
    async with release_on_error(run_id):
        audio_dir = root / "video_outputs" / uid / "audio"
        audio_dir.mkdir(parents=True, exist_ok=True)
        for stale in audio_dir.glob("audio_*.wav"):
            stale.unlink(missing_ok=True)
        for wav in staging.glob("audio_*.wav"):
            wav.replace(audio_dir / wav.name)
        import shutil

        shutil.rmtree(staging, ignore_errors=True)

        await push_project_files(uid)  # WAVs only

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

        if proj.mode == "talking_head":
            await _enqueue(
                job_id, "plan_talking_local", project_uid=uid, tenant_slug=auth.tenant_slug, run_id=run_id, user=auth.user,
            )
        else:
            await _enqueue(
                job_id, "plan_speech_local",
                project_uid=uid, tenant_slug=auth.tenant_slug, style_uid=style_uid.strip(), run_id=run_id, user=auth.user,
            )
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
    # Only the file that changed. `push_project_files` re-uploads the whole
    # project (20 files, ~1 min measured 2026-09-21), and the editor's draft
    # autosave lands here on every edit.
    await push_output_file(uid, "timeline.json", timeline_path)
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
    # Only the file that changed — see put_local_timeline. Re-uploading the
    # whole project made every draft save take about a minute, which the web
    # client's 60s request timeout turned into "HTTP 0" (live 2026-09-21).
    await push_output_file(uid, "edit_script.json", edit_script_path)
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
    enforce_feature(auth.user, "music")
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

    # The BEATS are what the pipeline uses from here on (worker tasks read
    # `music_beats`; the mix happens on the client, from the client's own copy
    # of the track). Nothing reads the uploaded audio again, so it goes now
    # rather than sitting on our disk — the file was only ever here so librosa
    # could look at it.
    proj.music_beats = beats
    proj.music_path = None
    await session.commit()

    from packages.video.s3 import delete_output_subdir
    from packages.video.storage import purge_uploaded_media

    await asyncio.to_thread(purge_uploaded_media, uid, ("music",))
    await delete_output_subdir(uid, "music")

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
    request: Request,
    session: AsyncSession = Depends(db_session),
    preview: UploadFile = File(...),
    manifest: str = Form(...),
    proxies: list[UploadFile] = File(default_factory=list),
    proxy_manifest: str = Form(""),
    style_uid: str = Form(""),
    music_offset_sec: float = Form(0.0, ge=0),
    music_trim_in_sec: float = Form(0.0, ge=0),
    music_trim_out_sec: float | None = Form(None, gt=0),
    allow_wallet: bool = Form(False),
) -> AnalyzeFramesOut:
    """dub_first: AI-assisted re-edit of the current edit script.

    `preview` is a freshly-encoded silent proxy of the LIVE (possibly unsaved)
    editor state — reflects exactly what the user is looking at right now.

    `proxies` are the raw source clip proxies, re-uploaded on every call. They
    used to be reused from whatever the analyze step had left on disk, which
    forced the server to keep every user's uploaded footage indefinitely. The
    client has them locally and analyze re-sends the same files anyway, so
    resending here costs nothing and lets the analyze step purge its copies.
    Omitting them still works when a previous upload happens to be on disk.

    ``style_uid`` — an OPTIONAL saved kind="cut" EffectStyle, same contract as
    POST /{uid}/analyze-video: it travels with the job as a kwarg and the
    worker resolves the prose from the DB at run time — nothing is persisted
    to disk/S3.
    """
    proj = await _get_local_project(session, uid, auth.user_id)
    if proj.mode not in ("dub_first", "highlight"):
        raise HTTPException(400, "reedit-dub-scenes ใช้ได้เฉพาะโหมด dub_first / highlight")
    music_window = _music_window_kwargs(music_offset_sec, music_trim_in_sec, music_trim_out_sec)
    if proj.status not in RESTARTABLE_STATUSES:
        raise HTTPException(400, f"โปรเจกต์นี้ยังทำงานอยู่ (สถานะ {proj.status}) — กดหยุดงานก่อนถ้าจะเริ่มใหม่")
    if not proj.edit_script_path:
        raise HTTPException(400, "ยังไม่มี edit script — ต้อง analyze ก่อน")

    chosen_style_uid = style_uid.strip()
    if chosen_style_uid:
        from packages.db.models.effect_style import EffectStyle

        style = await session.get(EffectStyle, chosen_style_uid)
        if style is None or style.user_id != auth.user_id:
            raise HTTPException(404, "ไม่พบสไตล์นี้")
        if style.kind != "cut":
            raise HTTPException(400, "สไตล์นี้ไม่ใช่สไตล์การตัด")
        if style.system_prompt:
            log.info(
                "reedit_dub_style_selected",
                uid=uid,
                style_uid=chosen_style_uid,
                style_name=style.name,
                prompt_chars=len(style.system_prompt),
            )
        else:
            # Not distilled yet (or distillation failed) — proceed with the
            # default prompt; the worker treats an empty prose as no style.
            log.warning(
                "reedit_dub_style_empty_prompt",
                uid=uid,
                style_uid=chosen_style_uid,
                style_name=style.name,
            )

    try:
        body = ReeditManifestIn.model_validate(json.loads(manifest))
    except (json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(422, f"manifest ไม่ถูกต้อง: {exc}") from exc

    root = data_root()
    output_dir = root / "video_outputs" / uid
    proxy_dir = output_dir / "proxy"
    proxy_manifest_file = proxy_dir / "proxy_manifest.json"

    # Everything the model will watch is measured BEFORE the reservation,
    # which is priced on it: the re-uploaded (or stored) source proxies AND
    # the live preview. Uploads wait in staging until the run is reserved.
    staged: _StagedProxies | None = None
    if proxies:
        try:
            proxy_entries = [ProxyManifestEntry.model_validate(e) for e in json.loads(proxy_manifest)]
        except (json.JSONDecodeError, ValueError) as exc:
            raise HTTPException(422, f"proxy_manifest ไม่ถูกต้อง: {exc}") from exc
        by_name = {f.filename: f for f in proxies}
        pairs: list[tuple[ProxyManifestEntry, UploadFile]] = []
        for entry in proxy_entries:
            up = by_name.get(_safe_upload_name(entry.file))
            if up is None:
                raise HTTPException(422, f"ไม่พบไฟล์ proxy {entry.file} ในคำขอ")
            pairs.append((entry, up))
        staged = await _stage_proxies(uid, pairs)
        proxy_secs = [float(rec["measuredSec"]) for rec in staged.records]
    elif proxy_manifest_file.is_file():
        proxy_secs = await _measure_stored_proxies(proxy_dir, proxy_manifest_file)
    else:
        raise HTTPException(400, "ไม่พบ proxy ของคลิปต้นฉบับ — กรุณา analyze ใหม่อีกครั้ง")

    preview_stage = output_dir / f".incoming-preview-{uuid.uuid4().hex}.mp4"
    try:
        output_dir.mkdir(parents=True, exist_ok=True)
        preview_stage.write_bytes(await preview.read())
        preview_sec = await _measure_upload(preview_stage, label="พรีวิว", max_short_side=PROXY_MAX_SHORT_SIDE)
        run_id = await start_paid_run(
            auth, request,
            estimator.estimate_run(
                # The re-edit call samples every file at the provider default,
                # whatever the project's precision.
                kind="reedit", engine=proj.engine, precision="standard",
                clip_secs=[*proxy_secs, preview_sec],
            ),
            allow_wallet=allow_wallet, job_id=f"vlocal_{uid[:8]}", reference_id=uid,
            mode=proj.mode, engine=proj.engine, precision=proj.precision,
        )
    except BaseException:
        preview_stage.unlink(missing_ok=True)
        if staged is not None:
            staged.discard()
        raise
    async with release_on_error(run_id):
        if staged is not None:
            staged.install(proxy_dir)

        reedit_dir = output_dir / "ai_reedit"
        reedit_dir.mkdir(parents=True, exist_ok=True)
        preview_path = reedit_dir / "edited_preview.mp4"
        preview_stage.replace(preview_path)
        (reedit_dir / "reedit_request.json").write_text(
            json.dumps(body.model_dump(), ensure_ascii=False, indent=2), encoding="utf-8"
        )
        await push_project_files(uid)  # preview MP4 + request JSON only

        job_id = f"vlocal_{uid[:8]}"
        await session.execute(text("SET search_path TO core, public"))
        existing = await session.get(Job, job_id)
        queued = {
            "step": "queued",
            "message": "รับคำสั่งแก้ไขแล้ว รอ AI ประมวลผล…",
            "style_uid": chosen_style_uid or None,
        }
        if existing:
            existing.status = "queued"
            existing.progress = 2
            existing.result = queued
            existing.error = None
        else:
            session.add(Job(
                id=job_id,
                tenant_id=auth.tenant_id,
                type="video_edit",
                status="queued",
                progress=2,
                result=queued,
            ))
        await bind_tenant_search_path(session, auth.tenant_slug)
        proj.status = "processing"
        proj.job_id = job_id
        await session.commit()

        # style_uid travels with the job; the worker resolves the prose from the
        # DB at run time (DB is the only source — no style file on disk/S3).
        await _enqueue(
            job_id,
            "reedit_dub_scenes_local",
            project_uid=uid,
            tenant_slug=auth.tenant_slug,
            style_uid=chosen_style_uid,
            run_id=run_id,
            **music_window, user=auth.user,
        )
    return AnalyzeFramesOut(job_id=job_id)


# ── effects layer (Remotion) ────────────────────────────────────────────────

@router.post("/{uid}/plan-effects", response_model=AnalyzeFramesOut, status_code=202)
async def plan_effects(
    uid: str,
    auth: CurrentUser,
    request: Request,
    session: AsyncSession = Depends(db_session),
    proxy: UploadFile = File(...),
    prompt: str = Form(""),
    script: str = Form(""),
    style_uid: str = Form(""),
    cuts: str = Form(""),
    use_previous: bool = Form(False),
    reference: UploadFile | None = File(None),
    allow_wallet: bool = Form(False),
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
    inspiration (the AI is told never to copy its literal content, only its
    camera-motion rhythm).

    The full-res video never leaves the user's machine — only this proxy is
    uploaded for the AI to watch (parallel to dub's proxy upload). Effects are a
    layer on top; the cut/timeline is untouched.
    """
    proj = await _get_local_project(session, uid, auth.user_id)
    if proj.status not in ("done", "waiting_vo", "error", "cancelled"):
        raise HTTPException(400, "ต้องมีวิดีโอที่ตัดเสร็จแล้วก่อนจึงจะวางเอฟเฟกต์ได้")

    root = data_root()
    effects_dir = root / "video_outputs" / uid / "effects"
    effects_dir.mkdir(parents=True, exist_ok=True)
    (effects_dir / "cut_proxy.mp4").write_bytes(await proxy.read())
    (effects_dir / "prompt.txt").write_text(prompt or "", encoding="utf-8")
    (effects_dir / "script.txt").write_text(script or "", encoding="utf-8")

    # Reserve before the rest is stored, priced on EVERY video the model will
    # watch, as measured here: the cut proxy and, when attached, the style
    # reference (capped like a style's, it is billed per second too). A file
    # whose length cannot be read is refused, never counted as zero
    # (docs/token-billing-design.md §6.1, §15).
    settings = get_settings()
    staged_ref: Path | None = None
    try:
        media_secs = [await _measure_upload(effects_dir / "cut_proxy.mp4", label="วิดีโอที่ตัดแล้ว")]
        image_refs = 0
        if reference is not None:
            ref_suffix = Path(reference.filename or "").suffix.lower() or ".mp4"
            if not re.fullmatch(r"\.[a-z0-9]{1,5}", ref_suffix):
                raise HTTPException(422, "นามสกุลไฟล์อ้างอิงไม่ถูกต้อง")
            staged_ref = effects_dir / f".incoming-reference{ref_suffix}"
            staged_ref.write_bytes(await reference.read())
            if ref_suffix in _REFERENCE_IMAGE_SUFFIXES:
                image_refs = 1
            else:
                media_secs.append(await _measure_upload(
                    staged_ref, label="อ้างอิง", max_sec=float(settings.reference_max_sec),
                ))
        run_id = await start_paid_run(
            auth, request,
            estimator.estimate_run(
                # The placement call samples at the provider default.
                kind="plan_effects", engine=proj.engine, precision="standard",
                clip_secs=media_secs, frame_count=image_refs,
            ),
            allow_wallet=allow_wallet, job_id=f"vlocal_{uid[:8]}", reference_id=uid,
            mode=proj.mode, engine=proj.engine, precision=proj.precision,
        )
    except BaseException:
        if staged_ref is not None:
            staged_ref.unlink(missing_ok=True)
        raise
    async with release_on_error(run_id):
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

        # The reference is OPTIONAL and named by its real extension (the AI call
        # needs a real suffix to guess mime type) — any stale file from a previous
        # run is removed first so an omitted param this time doesn't silently
        # reuse last run's attachment.
        for stale in effects_dir.glob("reference.*"):
            stale.unlink(missing_ok=True)
            await delete_output_file(uid, f"effects/{stale.name}")
        if staged_ref is not None:
            staged_ref.replace(effects_dir / f"reference{staged_ref.suffix}")

        await push_project_files(uid)  # proxy MP4 + prompt + script + optional reference

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
            run_id=run_id, user=auth.user,
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


