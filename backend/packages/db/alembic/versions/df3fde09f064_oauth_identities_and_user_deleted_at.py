"""OAuth identities (Sign in with Google) and users.deleted_at (self-service deletion).

Revision ID: df3fde09f064
Revises: 60aadc49ba17
Create Date: 2026-09-30 02:50:16.609832

Generated with `alembic revision --autogenerate` against the local database.
Autogenerate also picked up this repo's known per-tenant drift (creating
video_projects/effect_styles in the default schema, dropping the
tenant_default copies and alembic_version); all of that was removed by hand.
What remains is exactly the generated DDL for:

- core.oauth_identities — packages/db/models/oauth_identity.py
- core.users.deleted_at  — packages/db/models/core_auth.py
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'df3fde09f064'
down_revision: Union[str, Sequence[str], None] = '60aadc49ba17'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('oauth_identities',
    sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
    sa.Column('user_id', sa.BigInteger(), nullable=False),
    sa.Column('provider', sa.String(length=32), nullable=False),
    sa.Column('subject', sa.String(length=255), nullable=False),
    sa.Column('email', sa.String(length=255), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('last_login_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['user_id'], ['core.users.id'], name=op.f('fk_oauth_identities_user_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_oauth_identities')),
    sa.UniqueConstraint('provider', 'subject', name='uq_oauth_identities_provider_subject'),
    sa.UniqueConstraint('user_id', 'provider', name='uq_oauth_identities_user_id_provider'),
    schema='core'
    )
    op.create_index(op.f('ix_core_oauth_identities_user_id'), 'oauth_identities', ['user_id'], unique=False, schema='core')
    op.add_column('users', sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True), schema='core')


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('users', 'deleted_at', schema='core')
    op.drop_index(op.f('ix_core_oauth_identities_user_id'), table_name='oauth_identities', schema='core')
    op.drop_table('oauth_identities', schema='core')
