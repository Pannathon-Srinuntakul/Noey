"""Add duration_mode column to video_projects.

Revision ID: f4a5b6c7d8e9
Revises: e3f4a5b6c7d8
Create Date: 2026-06-23
"""

from alembic import op
import sqlalchemy as sa

revision = "f4a5b6c7d8e9"
down_revision = "e3f4a5b6c7d8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "video_projects",
        sa.Column("duration_mode", sa.String(16), nullable=False, server_default="full"),
        schema="tenant_default",
    )


def downgrade() -> None:
    op.drop_column("video_projects", "duration_mode", schema="tenant_default")
