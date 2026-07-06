"""Add origin + local_meta to video_projects (desktop local-render mode).

Revision ID: c2d3e4f5a6b7
Revises: b0c1d2e3f4a5
Create Date: 2026-07-03
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "c2d3e4f5a6b7"
down_revision = "b0c1d2e3f4a5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "video_projects", sa.Column("origin", sa.String(16), nullable=True), schema="tenant_default"
    )
    op.add_column(
        "video_projects", sa.Column("local_meta", JSONB(), nullable=True), schema="tenant_default"
    )


def downgrade() -> None:
    op.drop_column("video_projects", "local_meta", schema="tenant_default")
    op.drop_column("video_projects", "origin", schema="tenant_default")
