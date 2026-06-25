"""video_projects target_duration_sec

Optional output length limit for highlight editing mode.

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-06-23

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b2c3d4e5f6a7"
down_revision: Union[str, Sequence[str], None] = "a1b2c3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "video_projects",
        sa.Column("target_duration_sec", sa.Integer(), nullable=True),
        schema="tenant_default",
    )


def downgrade() -> None:
    op.drop_column("video_projects", "target_duration_sec", schema="tenant_default")
