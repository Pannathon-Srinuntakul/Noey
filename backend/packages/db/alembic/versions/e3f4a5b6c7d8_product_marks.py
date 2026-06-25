"""Add product_marks JSONB column to video_projects.

Revision ID: e3f4a5b6c7d8
Revises: d2e3f4a5b6c7
Create Date: 2026-06-23
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "e3f4a5b6c7d8"
down_revision = "d2e3f4a5b6c7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("video_projects", sa.Column("product_marks", JSONB(), nullable=True), schema="tenant_default")


def downgrade() -> None:
    op.drop_column("video_projects", "product_marks", schema="tenant_default")
