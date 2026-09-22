"""Async engine + session factory with per-tenant search_path support."""

from collections.abc import AsyncIterator
from functools import lru_cache

from sqlalchemy import event, text
from sqlalchemy.pool import NullPool
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from packages.core.settings import get_settings
from packages.db.tenancy import set_search_path_sql


@lru_cache
def get_engine() -> AsyncEngine:
    settings = get_settings()
    return create_async_engine(
        settings.database_url,
        pool_pre_ping=True,
        # Sized from settings, never SQLAlchemy's 5+10 default — see
        # docs/load-test-2026-09-22.md: 15 connections per process was the
        # ceiling the whole stack hit first, at 4% CPU.
        pool_size=settings.db_pool_size,
        max_overflow=settings.db_max_overflow,
        pool_timeout=settings.db_pool_timeout_sec,
        pool_recycle=settings.db_pool_recycle_sec,
        # Dynamic DDL (ALTER TABLE) invalidates asyncpg prepared statement cache.
        # Disable caching so schema changes take effect immediately without a 500.
        connect_args={"prepared_statement_cache_size": 0},
    )


@lru_cache
def get_lifeline_engine() -> AsyncEngine:
    """A tiny, pool-free engine for writes that must not queue behind the pool.

    A worker task that dies *because* the pool is exhausted still has to record
    that failure — and its error handler used the same exhausted pool, so the
    job row stayed `running` forever and the user watched a spinner that would
    never stop (load test 2026-09-22: 28% of jobs at 50 users). This engine
    opens its own connection, uses it, and closes it.
    """
    settings = get_settings()
    return create_async_engine(
        settings.database_url,
        poolclass=NullPool,
        connect_args={"prepared_statement_cache_size": 0},
    )


@lru_cache
def get_lifeline_sessionmaker() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(get_lifeline_engine(), expire_on_commit=False)


@lru_cache
def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(get_engine(), expire_on_commit=False)


def _register_tenant_search_path_hook() -> None:
    """Re-apply tenant search_path whenever a new transaction begins.

    Without this, commit() returns the connection to the pool and the next
    query may run without tenant_<slug> in search_path (UndefinedTableError).
    """

    @event.listens_for(AsyncSession.sync_session_class, "after_begin")
    def _set_tenant_search_path(session, transaction, connection) -> None:  # noqa: ARG001
        slug = session.info.get("tenant_slug")
        if slug is not None:
            connection.execute(text(set_search_path_sql(slug)))


_register_tenant_search_path_hook()


async def bind_tenant_search_path(session: AsyncSession, tenant_slug: str) -> None:
    """Mark session as tenant-scoped and set search_path for the current transaction."""
    session.info["tenant_slug"] = tenant_slug
    await session.execute(text(set_search_path_sql(tenant_slug)))


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency: yields a session, commits on success, rolls back on error."""
    maker = get_sessionmaker()
    async with maker() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def get_tenant_session(tenant_slug: str) -> AsyncIterator[AsyncSession]:
    """Session with search_path scoped to a tenant's schema (+ core fallback)."""
    maker = get_sessionmaker()
    async with maker() as session:
        await bind_tenant_search_path(session, tenant_slug)
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
