"""video_projects

Add video_projects table to tenant_default schema.

Revision ID: a1b2c3d4e5f6
Revises: d4e5f6a7b8c9
Create Date: 2026-06-23

"""
from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB
from alembic import op

revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, Sequence[str], None] = 'd4e5f6a7b8c9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("CREATE SCHEMA IF NOT EXISTS tenant_default")

    op.create_table(
        'video_projects',
        sa.Column('uid', sa.String(36), nullable=False),
        sa.Column('user_id', sa.BigInteger(), nullable=False),
        sa.Column('tenant_slug', sa.String(80), nullable=False),
        sa.Column('mode', sa.String(32), nullable=False, server_default='talking_head'),
        sa.Column('status', sa.String(32), nullable=False, server_default='pending'),
        sa.Column('job_id', sa.String(80), nullable=True),
        sa.Column('source_files', JSONB(), nullable=True),
        sa.Column('transcript_path', sa.Text(), nullable=True),
        sa.Column('timeline_path', sa.Text(), nullable=True),
        sa.Column('final_path', sa.Text(), nullable=True),
        sa.Column('zip_path', sa.Text(), nullable=True),
        sa.Column('error_msg', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(
            ['user_id'], ['core.users.id'],
            name=op.f('fk_video_projects_user_id_users'), ondelete='CASCADE',
        ),
        sa.PrimaryKeyConstraint('uid', name=op.f('pk_video_projects')),
        schema='tenant_default',
    )
    op.create_index(
        op.f('ix_video_projects_user_id'), 'video_projects', ['user_id'],
        unique=False, schema='tenant_default',
    )
    op.create_index(
        op.f('ix_video_projects_status'), 'video_projects', ['status'],
        unique=False, schema='tenant_default',
    )
    op.create_index(
        op.f('ix_video_projects_updated_at'), 'video_projects', ['updated_at'],
        unique=False, schema='tenant_default',
    )


def downgrade() -> None:
    op.drop_index(op.f('ix_video_projects_updated_at'), table_name='video_projects', schema='tenant_default')
    op.drop_index(op.f('ix_video_projects_status'), table_name='video_projects', schema='tenant_default')
    op.drop_index(op.f('ix_video_projects_user_id'), table_name='video_projects', schema='tenant_default')
    op.drop_table('video_projects', schema='tenant_default')
