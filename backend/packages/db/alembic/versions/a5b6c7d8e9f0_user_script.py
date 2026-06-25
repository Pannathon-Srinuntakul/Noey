"""Add user_script column to video_projects.

Revision ID: a5b6c7d8e9f0
Revises: f4a5b6c7d8e9
Create Date: 2026-06-23
"""

from alembic import op
import sqlalchemy as sa

revision = "a5b6c7d8e9f0"
down_revision = "f4a5b6c7d8e9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "video_projects",
        sa.Column("user_script", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("video_projects", "user_script")
