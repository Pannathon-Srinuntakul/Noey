"""custom_table_uid

Revision ID: cc4e9bb11bc6
Revises: 91ff965c44aa
Create Date: 2026-06-21 21:13:16.589689

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import text as _text


# revision identifiers, used by Alembic.
revision: str = 'cc4e9bb11bc6'
down_revision: Union[str, Sequence[str], None] = '91ff965c44aa'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add uid UUID to custom_table_meta; migrate udt_* row PKs from BIGSERIAL id → UUID uid."""
    # ── 1. custom_table_meta.uid ─────────────────────────────────────────
    op.add_column('custom_table_meta', sa.Column('uid', sa.Text(), nullable=True), schema='tenant_default')
    op.execute("UPDATE tenant_default.custom_table_meta SET uid = gen_random_uuid()::text WHERE uid IS NULL")
    op.alter_column('custom_table_meta', 'uid', nullable=False, schema='tenant_default')
    op.create_unique_constraint('uq_custom_table_meta_uid', 'custom_table_meta', ['uid'], schema='tenant_default')
    op.create_index('ix_custom_table_meta_uid', 'custom_table_meta', ['uid'], unique=True, schema='tenant_default')

    # ── 2. Migrate udt_* tables: id BIGSERIAL → uid UUID PK + seq for ordering ──
    # Use sa.text() so SQLAlchemy doesn't interpret '%' as psycopg param placeholders.
    op.execute(_text("""
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'tenant_default' AND tablename LIKE 'udt_%'
  LOOP
    EXECUTE format('ALTER TABLE tenant_default.%I ADD COLUMN IF NOT EXISTS uid UUID DEFAULT gen_random_uuid()', t);
    EXECUTE format('UPDATE tenant_default.%I SET uid = gen_random_uuid() WHERE uid IS NULL', t);
    EXECUTE format('ALTER TABLE tenant_default.%I ALTER COLUMN uid SET NOT NULL', t);
    EXECUTE format('ALTER TABLE tenant_default.%I DROP CONSTRAINT IF EXISTS %I', t, t || '_pkey');
    EXECUTE format('ALTER TABLE tenant_default.%I ADD PRIMARY KEY (uid)', t);
    EXECUTE format('ALTER TABLE tenant_default.%I DROP COLUMN IF EXISTS id', t);
    EXECUTE format('ALTER TABLE tenant_default.%I ADD COLUMN IF NOT EXISTS seq BIGSERIAL', t);
  END LOOP;
END $$;
"""))


def downgrade() -> None:
    """Downgrade is intentionally limited — uid removal only."""
    op.drop_index('ix_custom_table_meta_uid', table_name='custom_table_meta', schema='tenant_default')
    op.drop_constraint('uq_custom_table_meta_uid', 'custom_table_meta', schema='tenant_default')
    op.drop_column('custom_table_meta', 'uid', schema='tenant_default')
