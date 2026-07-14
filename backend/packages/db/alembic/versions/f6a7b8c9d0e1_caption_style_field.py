"""Add caption_style field to video_projects.

Revision ID: f6a7b8c9d0e1
Revises: c2d3e4f5a6b7
Create Date: 2026-07-10
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "f6a7b8c9d0e1"
down_revision = "c2d3e4f5a6b7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "video_projects",
        sa.Column("caption_style", postgresql.JSONB(), nullable=True),
        schema="tenant_default",
    )


def downgrade() -> None:
    op.drop_column("video_projects", "caption_style", schema="tenant_default")
