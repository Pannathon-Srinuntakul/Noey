"""custom_table_position

Revision ID: febc57d54920
Revises: c54b0318503b
Create Date: 2026-06-21 14:34:39.870229

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = 'febc57d54920'
down_revision: Union[str, Sequence[str], None] = 'c54b0318503b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Add position column for sidebar display ordering.
    op.add_column('custom_table_meta', sa.Column('position', sa.Integer(), nullable=False, server_default='0'))
    op.create_index(op.f('ix_custom_table_meta_position'), 'custom_table_meta', ['position'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_custom_table_meta_position'), table_name='custom_table_meta')
    op.drop_column('custom_table_meta', 'position')
    op.create_table('users',
    sa.Column('id', sa.BIGINT(), autoincrement=True, nullable=False),
    sa.Column('email', sa.VARCHAR(length=255), autoincrement=False, nullable=False),
    sa.Column('password_hash', sa.VARCHAR(length=255), autoincrement=False, nullable=False),
    sa.Column('is_active', sa.BOOLEAN(), autoincrement=False, nullable=False),
    sa.Column('is_admin', sa.BOOLEAN(), autoincrement=False, nullable=False),
    sa.Column('created_at', postgresql.TIMESTAMP(timezone=True), server_default=sa.text('now()'), autoincrement=False, nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_users')),
    sa.UniqueConstraint('email', name=op.f('uq_users_email'), postgresql_include=[], postgresql_nulls_not_distinct=False)
    )
    op.create_table('memberships',
    sa.Column('id', sa.BIGINT(), autoincrement=True, nullable=False),
    sa.Column('user_id', sa.BIGINT(), autoincrement=False, nullable=False),
    sa.Column('tenant_id', sa.BIGINT(), autoincrement=False, nullable=False),
    sa.Column('role', sa.VARCHAR(length=32), autoincrement=False, nullable=False),
    sa.Column('created_at', postgresql.TIMESTAMP(timezone=True), server_default=sa.text('now()'), autoincrement=False, nullable=False),
    sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], name=op.f('fk_memberships_tenant_id_tenants'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_memberships_user_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_memberships')),
    sa.UniqueConstraint('user_id', 'tenant_id', name=op.f('uq_memberships_user_id_tenant_id'), postgresql_include=[], postgresql_nulls_not_distinct=False)
    )
    op.create_index(op.f('ix_core_memberships_user_id'), 'memberships', ['user_id'], unique=False)
    op.create_index(op.f('ix_core_memberships_tenant_id'), 'memberships', ['tenant_id'], unique=False)
    op.create_table('jobs',
    sa.Column('id', sa.VARCHAR(length=64), autoincrement=False, nullable=False),
    sa.Column('tenant_id', sa.BIGINT(), autoincrement=False, nullable=False),
    sa.Column('type', sa.VARCHAR(length=32), autoincrement=False, nullable=False),
    sa.Column('status', sa.VARCHAR(length=16), autoincrement=False, nullable=False),
    sa.Column('progress', sa.BIGINT(), autoincrement=False, nullable=False),
    sa.Column('result', postgresql.JSONB(astext_type=sa.Text()), autoincrement=False, nullable=True),
    sa.Column('error', sa.VARCHAR(length=512), autoincrement=False, nullable=True),
    sa.Column('created_at', postgresql.TIMESTAMP(timezone=True), server_default=sa.text('now()'), autoincrement=False, nullable=False),
    sa.Column('updated_at', postgresql.TIMESTAMP(timezone=True), server_default=sa.text('now()'), autoincrement=False, nullable=False),
    sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], name=op.f('fk_jobs_tenant_id_tenants'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_jobs'))
    )
    op.create_index(op.f('ix_core_jobs_tenant_id'), 'jobs', ['tenant_id'], unique=False)
    op.create_table('tenants',
    sa.Column('id', sa.BIGINT(), autoincrement=True, nullable=False),
    sa.Column('slug', sa.VARCHAR(length=63), autoincrement=False, nullable=False),
    sa.Column('name', sa.VARCHAR(length=128), autoincrement=False, nullable=False),
    sa.Column('ai_config', postgresql.JSONB(astext_type=sa.Text()), autoincrement=False, nullable=False),
    sa.Column('created_at', postgresql.TIMESTAMP(timezone=True), server_default=sa.text('now()'), autoincrement=False, nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_tenants')),
    sa.UniqueConstraint('slug', name=op.f('uq_tenants_slug'), postgresql_include=[], postgresql_nulls_not_distinct=False)
    )
    op.create_table('alembic_version',
    sa.Column('version_num', sa.VARCHAR(length=32), autoincrement=False, nullable=False),
    sa.PrimaryKeyConstraint('version_num', name=op.f('alembic_version_pkc')),
    schema='public'
    )
    # ### end Alembic commands ###
