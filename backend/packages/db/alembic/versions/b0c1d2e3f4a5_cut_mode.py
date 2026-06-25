"""Add cut_mode column to video_projects.

Revision ID: b0c1d2e3f4a5
Revises: a5b6c7d8e9f0
Create Date: 2026-06-25
"""

from alembic import op
import sqlalchemy as sa

revision = "b0c1d2e3f4a5"
down_revision = "b1c2d3e4f5a6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "video_projects",
        sa.Column(
            "cut_mode",
            sa.String(16),
            nullable=False,
            server_default="accurate",
        ),
        schema="tenant_default",
    )


def downgrade() -> None:
    op.drop_column("video_projects", "cut_mode", schema="tenant_default")
