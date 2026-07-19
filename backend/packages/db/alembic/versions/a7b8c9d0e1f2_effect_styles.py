"""effect_styles

Add effect_styles table to tenant_default schema — reusable per-user AI
editing styles for the effects-placement pass.

Revision ID: a7b8c9d0e1f2
Revises: f6a7b8c9d0e1
Create Date: 2026-07-18

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'a7b8c9d0e1f2'
down_revision: Union[str, Sequence[str], None] = 'f6a7b8c9d0e1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("CREATE SCHEMA IF NOT EXISTS tenant_default")

    op.create_table(
        'effect_styles',
        sa.Column('uid', sa.String(36), nullable=False),
        sa.Column('user_id', sa.BigInteger(), nullable=False),
        sa.Column('tenant_slug', sa.String(80), nullable=False),
        sa.Column('name', sa.String(120), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('system_prompt', sa.Text(), nullable=True),
        sa.Column('reference_clip_path', sa.Text(), nullable=True),
        sa.Column('status', sa.String(16), nullable=False, server_default='pending'),
        sa.Column('error_msg', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(
            ['user_id'], ['core.users.id'],
            name=op.f('fk_effect_styles_user_id_users'), ondelete='CASCADE',
        ),
        sa.PrimaryKeyConstraint('uid', name=op.f('pk_effect_styles')),
        schema='tenant_default',
    )
    op.create_index(
        op.f('ix_effect_styles_user_id'), 'effect_styles', ['user_id'],
        unique=False, schema='tenant_default',
    )
    op.create_index(
        op.f('ix_effect_styles_status'), 'effect_styles', ['status'],
        unique=False, schema='tenant_default',
    )
    op.create_index(
        op.f('ix_effect_styles_updated_at'), 'effect_styles', ['updated_at'],
        unique=False, schema='tenant_default',
    )


def downgrade() -> None:
    op.drop_index(op.f('ix_effect_styles_updated_at'), table_name='effect_styles', schema='tenant_default')
    op.drop_index(op.f('ix_effect_styles_status'), table_name='effect_styles', schema='tenant_default')
    op.drop_index(op.f('ix_effect_styles_user_id'), table_name='effect_styles', schema='tenant_default')
    op.drop_table('effect_styles', schema='tenant_default')
