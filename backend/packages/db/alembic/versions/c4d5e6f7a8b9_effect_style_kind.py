"""effect_style_kind

Add kind + target_platform columns to effect_styles — the table now holds
both effects-pass styles and cut-stage styles, discriminated by ``kind``.

Revision ID: c4d5e6f7a8b9
Revises: b3c4d5e6f7a8
Create Date: 2026-08-06

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'c4d5e6f7a8b9'
down_revision: Union[str, Sequence[str], None] = 'b3c4d5e6f7a8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'effect_styles',
        sa.Column('kind', sa.String(16), nullable=False, server_default='effects'),
        schema='tenant_default',
    )
    op.add_column(
        'effect_styles',
        sa.Column('target_platform', sa.String(32), nullable=True),
        schema='tenant_default',
    )
    op.create_index(
        op.f('ix_effect_styles_kind'), 'effect_styles', ['kind'],
        unique=False, schema='tenant_default',
    )


def downgrade() -> None:
    op.drop_index(op.f('ix_effect_styles_kind'), table_name='effect_styles', schema='tenant_default')
    op.drop_column('effect_styles', 'target_platform', schema='tenant_default')
    op.drop_column('effect_styles', 'kind', schema='tenant_default')
