"""VideoProject model — per-tenant schema.

Tracks one AI video editing job from upload through render.
"""

import uuid as _uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from packages.db.base import Base

# Valid status values. ``paused_quota`` is NOT an error: the plan's window ran
# out mid-run (services/worker/tasks.py:_mark_stopped), everything the run
# produced is kept, and the project resumes from the stage it stopped at once
# the window rolls or the user spends their top-up balance. It must therefore
# be restartable wherever ``error`` is (routers/videos_local.py).
VIDEO_STATUS = (
    "pending", "processing", "waiting_vo", "done", "error", "paused_quota", "cancelled",
)
# Valid mode values
VIDEO_MODE = ("talking_head", "dub_first", "highlight")

# ── pipeline stages ──────────────────────────────────────────────────────────
#
# The boundaries a local-render run passes through. ``video_projects.stage``
# holds the furthest one the project has COMPLETED, so the server — not a
# project.json that lives in one browser's OPFS — knows where a paused run
# stopped and what it already has.
#
# Boundaries the SERVER does the work at (and therefore charges for) are
# ``analyze`` and ``transcribe``, plus the synchronous ``plan``. The rest is
# work the client does on the user's own machine and nothing is billed for.
#
# Client step names (web/src/lib/projectFlow.ts) map on as:
#   imported→imported  proxy→analyzing(before upload)  analyze→analyzing
#   render_silent→silent_rendering  voiceover→waiting_vo  plan→planning
#   render_final→final_rendering/rendering  extract_audio→extracting_audio
#   transcribe→transcribing  select→selecting  done→done
PIPELINE_STAGES = (
    "imported",
    "proxy",
    "analyze",
    "render_silent",
    "voiceover",
    "plan",
    "render_final",
    "extract_audio",
    "transcribe",
    "select",
    "done",
)

#: Per-mode order. Anything not listed (a mode added later) follows dub_first's.
STAGE_ORDER: dict[str, tuple[str, ...]] = {
    "dub_first": (
        "imported", "proxy", "analyze", "render_silent", "voiceover", "plan",
        "render_final", "done",
    ),
    # No voiceover: the silent cut IS the result.
    "highlight": ("imported", "proxy", "analyze", "render_silent", "done"),
    "talking_head": ("imported", "extract_audio", "transcribe", "render_final", "done"),
    "speech_highlights": (
        "imported", "extract_audio", "transcribe", "select", "render_final", "done",
    ),
    "speech_scenes": (
        "imported", "extract_audio", "transcribe", "select", "render_final", "done",
    ),
}

#: Stages that are a paid AI call, and therefore the only ones a run can pause
#: at. ``reedit`` / ``effects`` are paid too but sit OUTSIDE the linear
#: pipeline — they re-do an existing boundary rather than advance it, so they
#: never move ``stage`` forward.
PAID_STAGES = ("analyze", "transcribe", "select", "plan")
SIDE_STAGES = ("reedit", "effects")


def stage_order(mode: str | None) -> tuple[str, ...]:
    return STAGE_ORDER.get(mode or "", STAGE_ORDER["dub_first"])


def stage_index(mode: str | None, stage: str | None) -> int:
    """Position of ``stage`` in ``mode``'s order, or -1 when it has none."""
    order = stage_order(mode)
    try:
        return order.index(stage or "")
    except ValueError:
        return -1


def next_stage(mode: str | None, stage: str | None) -> str | None:
    """The boundary that comes after ``stage``. None at (or past) the end."""
    order = stage_order(mode)
    idx = stage_index(mode, stage)
    if idx < 0:
        return order[0] if stage is None else None
    return order[idx + 1] if idx + 1 < len(order) else None


def advance_stage(current: str | None, candidate: str | None, mode: str | None) -> str | None:
    """``current`` moved to ``candidate``, but only ever FORWARD.

    Stage means "the furthest boundary this project reached", so a late report
    from a client that is repeating an earlier step — an AI re-cut, a second
    local render — must not drag it backwards and make a resume redo work the
    project already has.
    """
    if candidate is None or candidate not in PIPELINE_STAGES:
        return current
    if stage_index(mode, candidate) < 0:
        return current
    return candidate if stage_index(mode, candidate) > stage_index(mode, current) else current


class VideoProject(Base):
    __tablename__ = "video_projects"

    uid: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(_uuid.uuid4())
    )
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("core.users.id", ondelete="CASCADE"), index=True
    )
    tenant_slug: Mapped[str] = mapped_column(String(80), nullable=False)
    mode: Mapped[str] = mapped_column(String(32), default="talking_head")

    # Optional cap for highlight mode (seconds). None = keep all speech.
    target_duration_sec: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # "full" = AI keeps all good speech | "auto" = Claude estimates duration | "custom" = user sets target_duration_sec
    duration_mode: Mapped[str] = mapped_column(String(16), default="full", server_default="full")

    status: Mapped[str] = mapped_column(String(32), default="pending", index=True)
    job_id: Mapped[str | None] = mapped_column(String(80), nullable=True)

    # JSON list of uploaded clip relative paths  e.g. ["uploads/{uid}/clip_0.mp4"]
    source_files: Mapped[list | None] = mapped_column(JSONB, nullable=True)

    brief: Mapped[str | None] = mapped_column(Text, nullable=True)
    user_script: Mapped[str | None] = mapped_column(Text, nullable=True)
    transcript_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    timeline_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    final_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    zip_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_msg: Mapped[str | None] = mapped_column(Text, nullable=True)
    edit_script_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    voiceover_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Dead since 2026-08-14, kept only because the columns still exist: the
    # reference-clip upload + Style Profile extraction were removed (Effect/Cut
    # Styles do that now) and product marks fed the popup overlays that went
    # away with the Remotion layer. Mapped so a stray row still loads; nothing
    # reads or writes them.
    reference_clip_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    style_profile_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    product_marks: Mapped[list | None] = mapped_column(JSONB, nullable=True)

    # User-chosen AI quality tiers — see packages/video/quality.py for what each
    # maps to. Persisted (not just passed per request) so a worker retry, a
    # resume, or "ให้ AI ตัดใหม่" repeats the choice the user paid for instead of
    # silently dropping back to the default. NULL = never chose one.
    engine: Mapped[str | None] = mapped_column(String(16), nullable=True)
    precision: Mapped[str | None] = mapped_column(String(16), nullable=True)

    # "local" = desktop app renders on the user's machine (video files never
    # reach the server; only frames/metadata do). NULL = classic server render.
    origin: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # Local-render clip metadata: {"clips": [{"id", "durationSec", "width", "height", "fps"}]}
    local_meta: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # talking_head burned-in caption choice: {"font", "mode", "color"}
    caption_style: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    # dub_first background music (server keeps a copy only for librosa beat
    # analysis — playback/mix at render time uses the desktop-local file path,
    # never this one). See packages/video/beat_analysis.py.
    music_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    # detect_beats() output: {"tempo": float, "beats": [float, ...], "durationSec": float}
    music_beats: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    # ── resume (docs: the contract in services/api/routers/videos_local.py) ──
    #
    # The furthest pipeline boundary this project has COMPLETED (PIPELINE_STAGES
    # above). NULL = a project from before resume existed; the resume endpoint
    # then infers the boundary from the artifacts the server holds instead.
    # It lives on the row rather than in the client's project.json because a
    # paused run must be resumable from any browser, on any device.
    stage: Mapped[str | None] = mapped_column(String(24), nullable=True)
    # The ticket for the stage currently being ATTEMPTED: which worker task and
    # kwargs would redo it, what it costs to price the remainder, and — once it
    # pauses — which window ran out and when it rolls. Written when a paid stage
    # starts, cleared when it succeeds, so a paused project carries exactly what
    # POST /videos/{uid}/resume needs and nothing that outlives it.
    resume_state: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), index=True
    )
