"""Tenant provisioning: create/drop per-tenant PostgreSQL schemas.

Each tenant owns a schema ``tenant_<slug>``. The tenant business tables
(``video_projects``, ``effect_styles``) are Alembic-managed and exist in ONE
schema only, ``tenant_default`` — every migration that touches them names that
schema. Rows are isolated per user by ``user_id``, which every router filters
on; the API's ``db_session`` binds ``default`` for every caller.

A tenant created later (self-service registration) therefore gets its schema
but no tables of its own, and its search path falls back to the shared data
schema — see ``set_search_path_sql``. Giving each tenant real tables is a
separate project: every tenant-table migration would have to fan out over all
tenant schemas, and the API would have to bind the caller's tenant.

The ``core`` schema holds auth (users, tenants, memberships, jobs) and billing.
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


#: Where the tenant business tables live — for every tenant, today.
SHARED_DATA_SCHEMA = tenant_schema(DEFAULT_TENANT_SLUG)


async def create_tenant_schema(session: AsyncSession, slug: str) -> None:
    """Create the per-tenant schema (idempotent)."""
    schema = tenant_schema(slug)
    await session.execute(text(f'CREATE SCHEMA IF NOT EXISTS "{schema}"'))


async def drop_tenant_schema(session: AsyncSession, slug: str) -> None:
    """Drop the per-tenant schema and all its tables (DESTRUCTIVE)."""
    schema = tenant_schema(slug)
    await session.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))


def set_search_path_sql(slug: str) -> str:
    """Return the SET search_path statement for a tenant request.

    The shared data schema follows the tenant's own, so the tenant tables
    resolve for EVERY tenant. Without it, a tenant other than ``default``
    resolves ``video_projects`` to nothing: the routers that re-bind the
    caller's tenant after writing a core Job row, and every worker task (which
    binds the job's tenant), would fail on that tenant's first AI job — while
    ``db_session`` had created the project in the shared schema. For
    ``default`` the statement is exactly what it always was.
    """
    schema = tenant_schema(slug)
    if schema == SHARED_DATA_SCHEMA:
        return f'SET search_path TO "{schema}", {CORE_SCHEMA}'
    return f'SET search_path TO "{schema}", "{SHARED_DATA_SCHEMA}", {CORE_SCHEMA}'
