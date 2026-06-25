"""Move all public-schema business tables to tenant_default schema,
create the default tenant + admin user, seed membership.

Safe to re-run (idempotent). Runs automatically on API startup.
Also runnable manually: python -m scripts.migrate_to_multitenant
"""

import asyncio
import os

from packages.auth.hashing import hash_password
from packages.core.logging import get_logger
from packages.db.session import get_engine
from packages.db.tenancy import DEFAULT_TENANT_SLUG, tenant_schema
from sqlalchemy import text

log = get_logger(__name__)

BUSINESS_TABLES = [
    "ai_prompts", "ai_runs", "app_settings", "creators", "csv_import_runs",
    "custom_table_meta", "follower_activity", "follower_gender", "follower_history",
    "follower_territory", "market_trends", "overview_daily", "products",
    "sales_daily", "scrape_runs", "video_content", "viewers_daily",
]

ADMIN_EMAIL = os.getenv("SEED_EMAIL", "admin@noey.local")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "ChangeMe123!")

TARGET_SCHEMA = tenant_schema(DEFAULT_TENANT_SLUG)


async def main() -> None:
    engine = get_engine()

    async with engine.begin() as conn:
        # Step 1: create tenant_default schema
        await conn.execute(text(f'CREATE SCHEMA IF NOT EXISTS "{TARGET_SCHEMA}"'))
        log.info("schema_ready", schema=TARGET_SCHEMA)

        # Step 2: move business tables public → tenant_default
        existing = {row[0] for row in await conn.execute(
            text("SELECT tablename FROM pg_tables WHERE schemaname='public'")
        )}
        already_moved = {row[0] for row in await conn.execute(
            text(f"SELECT tablename FROM pg_tables WHERE schemaname='{TARGET_SCHEMA}'")
        )}

        for table in BUSINESS_TABLES:
            if table in already_moved or table not in existing:
                continue
            await conn.execute(text(f'ALTER TABLE public."{table}" SET SCHEMA "{TARGET_SCHEMA}"'))
            log.info("table_moved", table=table, schema=TARGET_SCHEMA)

        # Move leftover udt_* tables
        udt_tables = [row[0] for row in await conn.execute(
            text("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'udt_%'")
        )]
        for table in udt_tables:
            await conn.execute(text(f'ALTER TABLE public."{table}" SET SCHEMA "{TARGET_SCHEMA}"'))
            log.info("udt_moved", table=table)

        # Step 3: seed tenant
        existing_tenant = (await conn.execute(
            text("SELECT id FROM core.tenants WHERE slug = :slug"), {"slug": DEFAULT_TENANT_SLUG}
        )).scalar_one_or_none()

        if existing_tenant is None:
            res = await conn.execute(
                text("INSERT INTO core.tenants (slug, name, ai_config) VALUES (:slug, :name, :cfg) RETURNING id"),
                {"slug": DEFAULT_TENANT_SLUG, "name": "Noey TikTok", "cfg": "{}"},
            )
            tenant_id: int = res.scalar_one()
            log.info("tenant_created", slug=DEFAULT_TENANT_SLUG, id=tenant_id)
        else:
            tenant_id = existing_tenant
            log.info("tenant_exists", slug=DEFAULT_TENANT_SLUG)

        # Step 4: seed admin user
        existing_user = (await conn.execute(
            text("SELECT id FROM core.users WHERE email = :email"), {"email": ADMIN_EMAIL}
        )).scalar_one_or_none()

        if existing_user is None:
            res = await conn.execute(
                text("INSERT INTO core.users (email, password_hash, is_active, is_admin) VALUES (:email, :hash, true, true) RETURNING id"),
                {"email": ADMIN_EMAIL, "hash": hash_password(ADMIN_PASSWORD)},
            )
            user_id: int = res.scalar_one()
            log.info("admin_created", email=ADMIN_EMAIL)
        else:
            user_id = existing_user
            log.info("admin_exists", email=ADMIN_EMAIL)

        # Step 5: seed membership
        existing_mem = (await conn.execute(
            text("SELECT id FROM core.memberships WHERE user_id = :uid AND tenant_id = :tid"),
            {"uid": user_id, "tid": tenant_id},
        )).scalar_one_or_none()

        if existing_mem is None:
            await conn.execute(
                text("INSERT INTO core.memberships (user_id, tenant_id, role) VALUES (:uid, :tid, 'owner')"),
                {"uid": user_id, "tid": tenant_id},
            )
            log.info("membership_created", role="owner")

    # Step 6: default workspace tables (custom_table_meta + udt_*) — idempotent
    await _provision_default_workspace()

    log.info("seed_complete", email=ADMIN_EMAIL, schema=TARGET_SCHEMA)


async def _provision_default_workspace() -> None:
    """Create 5 default TikTok Affiliate tables when tenant_default has none yet."""
    from sqlalchemy import func, select

    from packages.db.models.custom_table import CustomTableMeta
    from packages.db.session import bind_tenant_search_path, get_sessionmaker
    from packages.tables.workspace import provision_workspace

    maker = get_sessionmaker()
    async with maker() as session:
        await bind_tenant_search_path(session, DEFAULT_TENANT_SLUG)
        before = (await session.execute(select(func.count()).select_from(CustomTableMeta))).scalar_one()
        await provision_workspace(session, DEFAULT_TENANT_SLUG)
        after = (await session.execute(select(func.count()).select_from(CustomTableMeta))).scalar_one()
    if after > before:
        log.info("workspace_provisioned", table_count=after)
    else:
        log.info("workspace_already_provisioned", table_count=after)


if __name__ == "__main__":
    from packages.core.logging import configure_logging
    configure_logging()
    async def _run() -> None:
        await main()
        await get_engine().dispose()
    asyncio.run(_run())
