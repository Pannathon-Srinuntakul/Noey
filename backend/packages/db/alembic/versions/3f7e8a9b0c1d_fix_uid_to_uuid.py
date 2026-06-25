"""fix_uid_to_uuid

Regenerate any custom_table_meta.uid values that are not proper UUIDs
(e.g. rows that were set to id::text by an earlier migration draft).

Revision ID: 3f7e8a9b0c1d
Revises: cc4e9bb11bc6
Create Date: 2026-06-22

"""
from typing import Sequence, Union

from alembic import op
from sqlalchemy import text as _text

revision: str = '3f7e8a9b0c1d'
down_revision: Union[str, Sequence[str], None] = 'cc4e9bb11bc6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_UUID_RE = r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'


def upgrade() -> None:
    # Ensure the column exists (idempotent — harmless if cc4e9bb11bc6 already added it).
    op.execute(_text("""
        ALTER TABLE tenant_default.custom_table_meta
        ADD COLUMN IF NOT EXISTS uid TEXT
    """))

    # Replace NULL or non-UUID values (e.g. integer strings like "42") with real UUIDs.
    op.execute(_text(f"""
        UPDATE tenant_default.custom_table_meta
        SET uid = gen_random_uuid()::text
        WHERE uid IS NULL OR uid !~ '{_UUID_RE}'
    """))

    # Make NOT NULL (idempotent in PostgreSQL — no error if already set).
    op.execute(_text("""
        ALTER TABLE tenant_default.custom_table_meta
        ALTER COLUMN uid SET NOT NULL
    """))

    # Unique constraint — only add if missing.
    op.execute(_text("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint c
                JOIN pg_namespace n ON n.oid = c.connamespace
                WHERE c.conname = 'uq_custom_table_meta_uid'
                  AND n.nspname = 'tenant_default'
            ) THEN
                ALTER TABLE tenant_default.custom_table_meta
                ADD CONSTRAINT uq_custom_table_meta_uid UNIQUE (uid);
            END IF;
        END $$
    """))


def downgrade() -> None:
    # No safe downgrade — UIDs have changed.
    pass
