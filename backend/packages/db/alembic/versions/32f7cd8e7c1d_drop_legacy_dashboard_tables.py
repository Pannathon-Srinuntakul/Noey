"""Drop the legacy dashboard's tables — the frontend that read them is deleted.

Removed 2026-09-09 with the `frontend/` 3D dashboard and its 13 API routers:
the TikTok-analytics CSV family, custom tables (registry + every dynamic
`udt_*` table), chat history, prompt-cron, scrape runs, and the market/catalog
tables. Nothing in the video product reads any of them.

HAND-EDITED from autogenerate output, deliberately (CLAUDE.md permits editing
generated files; this is also the case it reserves for raw SQL):

- Autogenerate cannot see these tables correctly here. This project's alembic
  runs schema-less against `public` and the STARTUP SEED relocates business
  tables into `tenant_default` — so the cross-schema diff flagged half the
  KEPT core tables (`users`, `jobs`, `memberships`, even `alembic_version`)
  as "removed". Executing that would have destroyed the live product.
- The `udt_*` tables are created dynamically per user and exist in no model,
  so no generator can enumerate them; only a catalog query can.

Drops are IF EXISTS across both schemas the tables have ever lived in
(`tenant_default` now, `public` before the multitenant seed) so the migration
is correct on any database regardless of which seeds it has run.

DOWNGRADE IS A NO-OP ON PURPOSE: this migration destroys data (the owner's
call, 2026-09-09 — "drop พวกที่กำพร้าออกให้หมด"). There is nothing honest a
downgrade could restore.

Revision ID: 32f7cd8e7c1d
Revises: daa132a95835
Create Date: 2026-09-09
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "32f7cd8e7c1d"
down_revision: str | None = "daa132a95835"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_SCHEMAS = ("tenant_default", "public")

_DASHBOARD_TABLES = (
    # chat (drop messages before sessions for the FK)
    "chat_messages",
    "chat_sessions",
    # TikTok-analytics CSV family
    "overview_daily",
    "video_content",
    "follower_history",
    "follower_activity",
    "follower_gender",
    "follower_territory",
    "viewers_daily",
    "csv_import_runs",
    # catalog / market (sales references products+creators — first)
    "sales_daily",
    "products",
    "creators",
    "market_trends",
    # prompt-cron + settings + scraper audit
    "ai_runs",
    "ai_prompts",
    "app_settings",
    "scrape_runs",
    # user-defined tables: registry last, after every udt_* is gone
    "custom_table_meta",
)


def upgrade() -> None:
    conn = op.get_bind()
    for schema in _SCHEMAS:
        # Every dynamic user-defined table (`udt_*`) in this schema. These are
        # per-user creations with no model — the catalog is the only registry.
        udt = [
            row[0]
            for row in conn.execute(
                sa.text(
                    "SELECT tablename FROM pg_tables"
                    " WHERE schemaname = :schema AND tablename LIKE 'udt\\_%' ESCAPE '\\'"
                ),
                {"schema": schema},
            )
        ]
        for table in [*udt, *_DASHBOARD_TABLES]:
            conn.execute(sa.text(f'DROP TABLE IF EXISTS "{schema}"."{table}" CASCADE'))


def downgrade() -> None:
    # Data-destroying migration — see the module docstring. Nothing to restore.
    pass
