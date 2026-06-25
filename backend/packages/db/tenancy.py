"""Tenant provisioning: create/drop per-tenant PostgreSQL schemas.

Each tenant gets a schema ``tenant_<slug>`` containing:
- All dynamic user tables (udt_*) and their custom_table_meta registry
- Analytics tables (overview_daily, video_content, follower_*, viewers_daily,
  csv_import_runs, products, creators, sales_daily, market_trends, scrape_runs,
  ai_prompts, ai_runs, app_settings)

The ``core`` schema holds auth (users, tenants, memberships, jobs).
"""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

CORE_SCHEMA = "core"
DEFAULT_TENANT_SLUG = "default"


def tenant_schema(slug: str) -> str:
    """Safe schema name for a tenant slug (no user input in DDL)."""
    if not slug.replace("-", "").replace("_", "").isalnum():
        raise ValueError(f"invalid tenant slug: {slug!r}")
    return f"tenant_{slug}"


async def create_tenant_schema(session: AsyncSession, slug: str) -> None:
    """Create the per-tenant schema (idempotent)."""
    schema = tenant_schema(slug)
    await session.execute(text(f'CREATE SCHEMA IF NOT EXISTS "{schema}"'))


async def drop_tenant_schema(session: AsyncSession, slug: str) -> None:
    """Drop the per-tenant schema and all its tables (DESTRUCTIVE)."""
    schema = tenant_schema(slug)
    await session.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))


def set_search_path_sql(slug: str) -> str:
    """Return the SET search_path statement for a tenant request."""
    schema = tenant_schema(slug)
    return f'SET search_path TO "{schema}", {CORE_SCHEMA}'
