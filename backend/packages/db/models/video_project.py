"""VideoProject model — per-tenant schema.

Tracks one AI video editing job from upload through render.
"""

import uuid as _uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from packages.db.base import Base

# Valid status values
VIDEO_STATUS = ("pending", "processing", "waiting_vo", "done", "error", "cancelled")
# Valid mode values
VIDEO_MODE = ("talking_head", "dub_first", "highlight")


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
    reference_clip_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    style_profile_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    # [{"sourceClip": str, "at": float, "productName": str, "price": str}]
    product_marks: Mapped[list | None] = mapped_column(JSONB, nullable=True)

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

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), index=True
    )
