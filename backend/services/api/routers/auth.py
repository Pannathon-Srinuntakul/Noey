"""Auth endpoints: login, refresh, me, register (disabled)."""

from typing import Annotated

import jwt
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, EmailStr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.auth.hashing import verify_password
from packages.auth.tokens import decode, encode_access, encode_refresh
from packages.core.settings import get_settings
from packages.db.models.core_auth import Membership, Tenant, User
from services.api.deps import CurrentUser, core_session

router = APIRouter(prefix="/auth", tags=["auth"])


# ── schemas ───────────────────────────────────────────────────────────────────

class LoginIn(BaseModel):
    email: str
    password: str


class RegisterIn(BaseModel):
    email: EmailStr
    password: str


class TokenOut(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class MeOut(BaseModel):
    user_id: int
    email: str
    tenant_id: int
    tenant_slug: str
    role: str
    is_admin: bool


# ── helpers ───────────────────────────────────────────────────────────────────

_bearer = HTTPBearer(auto_error=False)


async def _tokens_for(user: User, tenant: Tenant) -> TokenOut:
    return TokenOut(
        access_token=encode_access(int(user.id), int(tenant.id), str(tenant.slug)),
        refresh_token=encode_refresh(int(user.id), int(tenant.id)),
    )


# ── endpoints ─────────────────────────────────────────────────────────────────

@router.post("/login", response_model=TokenOut)
async def login(
    body: LoginIn,
    session: Annotated[AsyncSession, Depends(core_session)],
) -> TokenOut:
    user = (
        await session.execute(
            select(User).where(User.email == body.email, User.is_active.is_(True))
        )
    ).scalar_one_or_none()

    if user is None or not verify_password(body.password, str(user.password_hash)):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")

    mem = (
        await session.execute(
            select(Membership).where(Membership.user_id == user.id)
        )
    ).scalar_one_or_none()
    if mem is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="no tenant membership")

    tenant = (
        await session.execute(select(Tenant).where(Tenant.id == mem.tenant_id))
    ).scalar_one_or_none()
    if tenant is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="tenant not found")

    return await _tokens_for(user, tenant)


@router.post("/refresh", response_model=TokenOut)
async def refresh(
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    session: Annotated[AsyncSession, Depends(core_session)],
) -> TokenOut:
    if creds is None:
        raise HTTPException(status_code=401, detail="missing token")
    try:
        payload = decode(creds.credentials)
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="invalid token")

    if payload.get("type") != "refresh":
        raise HTTPException(status_code=401, detail="not a refresh token")

    user_id = int(payload["sub"])
    tenant_id = int(payload["tid"])

    user = (
        await session.execute(select(User).where(User.id == user_id, User.is_active.is_(True)))
    ).scalar_one_or_none()
    tenant = (
        await session.execute(select(Tenant).where(Tenant.id == tenant_id))
    ).scalar_one_or_none()

    if user is None or tenant is None:
        raise HTTPException(status_code=401, detail="user/tenant not found")

    return await _tokens_for(user, tenant)


@router.get("/me", response_model=MeOut)
async def me(
    auth: CurrentUser,
    session: Annotated[AsyncSession, Depends(core_session)],
) -> MeOut:
    mem = (
        await session.execute(
            select(Membership).where(
                Membership.user_id == auth.user_id,
                Membership.tenant_id == auth.tenant_id,
            )
        )
    ).scalar_one_or_none()
    return MeOut(
        user_id=auth.user_id,
        email=str(auth.user.email),
        tenant_id=auth.tenant_id,
        tenant_slug=auth.tenant_slug,
        role=str(mem.role) if mem else "unknown",
        is_admin=bool(auth.user.is_admin),
    )


@router.post("/register")
async def register() -> dict:
    """Registration endpoint — closed per requirements. Body not accepted until enabled."""
    if not get_settings().allow_registration:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="registration is currently closed",
        )
    raise HTTPException(status_code=501, detail="not implemented")
