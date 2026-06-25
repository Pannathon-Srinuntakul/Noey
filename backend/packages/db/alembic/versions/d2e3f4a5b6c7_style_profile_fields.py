"""Add reference style profile fields to video_projects.

Revision ID: d2e3f4a5b6c7
Revises: c1d2e3f4a5b6
Create Date: 2026-06-23
"""

from alembic import op
import sqlalchemy as sa

revision = "d2e3f4a5b6c7"
down_revision = "c1d2e3f4a5b6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("video_projects", sa.Column("reference_clip_path", sa.Text(), nullable=True), schema="tenant_default")
    op.add_column("video_projects", sa.Column("style_profile_path", sa.Text(), nullable=True), schema="tenant_default")


def downgrade() -> None:
    op.drop_column("video_projects", "style_profile_path", schema="tenant_default")
    op.drop_column("video_projects", "reference_clip_path", schema="tenant_default")
