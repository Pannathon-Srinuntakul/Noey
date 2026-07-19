"""video_projects music_path + music_beats

dub_first background music: server-side copy path for librosa beat analysis, and
the detected beats ({"tempo", "beats", "durationSec"}) used to steer AI cut timing.

Revision ID: b3c4d5e6f7a8
Revises: a7b8c9d0e1f2
Create Date: 2026-07-19

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "b3c4d5e6f7a8"
down_revision: Union[str, Sequence[str], None] = "a7b8c9d0e1f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "video_projects",
        sa.Column("music_path", sa.Text(), nullable=True),
        schema="tenant_default",
    )
    op.add_column(
        "video_projects",
        sa.Column("music_beats", postgresql.JSONB(), nullable=True),
        schema="tenant_default",
    )


def downgrade() -> None:
    op.drop_column("video_projects", "music_beats", schema="tenant_default")
    op.drop_column("video_projects", "music_path", schema="tenant_default")
