"""Add dub_first fields to video_projects.

Revision ID: c1d2e3f4a5b6
Revises: b2c3d4e5f6a7
Create Date: 2026-06-23
"""

from alembic import op
import sqlalchemy as sa

revision = "c1d2e3f4a5b6"
down_revision = "b2c3d4e5f6a7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("video_projects", sa.Column("brief", sa.Text(), nullable=True), schema="tenant_default")
    op.add_column("video_projects", sa.Column("edit_script_path", sa.Text(), nullable=True), schema="tenant_default")
    op.add_column("video_projects", sa.Column("voiceover_path", sa.Text(), nullable=True), schema="tenant_default")


def downgrade() -> None:
    op.drop_column("video_projects", "voiceover_path", schema="tenant_default")
    op.drop_column("video_projects", "edit_script_path", schema="tenant_default")
    op.drop_column("video_projects", "brief", schema="tenant_default")
