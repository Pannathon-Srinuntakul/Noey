"""Shared FastAPI dependencies — database sessions + auth."""

from collections.abc import AsyncIterator
from typing import Annotated

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from packages.auth.tokens import decode
from packages.db.models.core_auth import Membership, Tenant, User
from packages.db.session import get_sessionmaker, bind_tenant_search_path


# ── core (auth) session ───────────────────────────────────────────────────────

async def core_session() -> AsyncIterator[AsyncSession]:
    """Session scoped to the core schema (auth endpoints only)."""
    maker = get_sessionmaker()
    async with maker() as session:
        await session.execute(text("SET search_path TO core, public"))
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


# ── legacy alias (keeps existing routers working pre-auth) ───────────────────

async def db_session() -> AsyncIterator[AsyncSession]:
    """Tenant-scoped session using the default tenant (temporary — Phase 2 will
    derive tenant from the authenticated JWT claim in every request)."""
    maker = get_sessionmaker()
    async with maker() as session:
        # TODO Phase 2: replace 'default' with tenant from current_tenant dependency.
        await bind_tenant_search_path(session, "default")
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


# ── auth ──────────────────────────────────────────────────────────────────────

_bearer = HTTPBearer(auto_error=False)

_401 = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="not authenticated",
    headers={"WWW-Authenticate": "Bearer"},
)


class AuthUser:
    """Resolved from JWT — attached to every authenticated request."""

    def __init__(self, user: User, tenant: Tenant) -> None:
        self.user = user
        self.tenant = tenant

    @property
    def user_id(self) -> int:
        return int(self.user.id)

    @property
    def tenant_id(self) -> int:
        return int(self.tenant.id)

    @property
    def tenant_slug(self) -> str:
        return str(self.tenant.slug)


async def current_user(
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    session: Annotated[AsyncSession, Depends(core_session)],
) -> AuthUser:
    if creds is None:
        raise _401
    try:
        payload = decode(creds.credentials)
    except jwt.PyJWTError:
        raise _401

    if payload.get("type") != "access":
        raise _401

    user_id = int(payload["sub"])
    tenant_id = int(payload["tid"])

    user = (
        await session.execute(select(User).where(User.id == user_id, User.is_active.is_(True)))
    ).scalar_one_or_none()
    if user is None:
        raise _401

    tenant = (
        await session.execute(select(Tenant).where(Tenant.id == tenant_id))
    ).scalar_one_or_none()
    if tenant is None:
        raise _401

    # Verify membership still active
    mem = (
        await session.execute(
            select(Membership).where(
                Membership.user_id == user_id,
                Membership.tenant_id == tenant_id,
            )
        )
    ).scalar_one_or_none()
    if mem is None:
        raise _401

    return AuthUser(user=user, tenant=tenant)


# Convenient type alias for router parameters
CurrentUser = Annotated[AuthUser, Depends(current_user)]
