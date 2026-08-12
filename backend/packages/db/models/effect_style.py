"""EffectStyle model — per-tenant schema.

A reusable, user-authored "editing style", distilled once and reused on later
AI runs. The table holds two kinds of style, discriminated by ``kind``:
``"effects"`` styles steer the effects-placement pass, ``"cut"`` styles steer
the cut stage. The user creates one in the central Studio by describing a look
and/or uploading a reference clip; a distillation AI pass
(packages/video/effects_style.py) watches/reads it ONCE and stores a
natural-language style prompt here. Every later run for any project can then
reuse that cheap stored text instead of re-uploading and re-analysing a
reference video each time.

Distinct from ``video_project.style_profile_path`` — that is the dub/cut-stage
Style Profile JSON (packages/video/style_profile.py), a different pipeline stage.
"""

import uuid as _uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from packages.db.base import Base

# Distillation lifecycle
EFFECT_STYLE_STATUS = ("pending", "ready", "error")

# Which pipeline stage the style steers
EFFECT_STYLE_KINDS = ("effects", "cut")

# Platforms a cut-style reference clip may target
CUT_STYLE_PLATFORMS = ("tiktok", "reels", "shorts", "youtube", "other")


class EffectStyle(Base):
    __tablename__ = "effect_styles"

    uid: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(_uuid.uuid4())
    )
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("core.users.id", ondelete="CASCADE"), index=True
    )
    tenant_slug: Mapped[str] = mapped_column(String(80), nullable=False)

    # Discriminator: "effects" (effects-placement pass) or "cut" (cut stage).
    kind: Mapped[str] = mapped_column(
        String(16), default="effects", server_default="effects", index=True
    )
    # Platform the reference targeted (cut styles only; informs distillation).
    target_platform: Mapped[str | None] = mapped_column(String(32), nullable=True)

    name: Mapped[str] = mapped_column(String(120), nullable=False)
    # What the user typed when creating the style (kept for display/regeneration).
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # The AI-distilled style block spliced verbatim into the effects prompt.
    # NULL until the distillation job finishes.
    system_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Relative path to the uploaded reference clip (kept for regeneration).
    reference_clip_path: Mapped[str | None] = mapped_column(Text, nullable=True)

    status: Mapped[str] = mapped_column(
        String(16), default="pending", server_default="pending", index=True
    )
    error_msg: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), index=True
    )
