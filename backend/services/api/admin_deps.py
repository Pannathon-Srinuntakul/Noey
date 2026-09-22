"""The ONE guard every /admin/* route sits behind.

``admin_ip_allowed`` runs on every admin route (the router's dependency);
``current_admin`` additionally on every route that is not a login step. It
re-reads the admin session row and the user on each request — is_admin,
is_active, token_version, idle and absolute expiry — so demoting, deactivating
or signing out takes effect on the very next request, whatever the token says.
tests/test_admin_security.py walks app.routes and proves every protected route
refuses anything but a live admin session.
"""

from dataclasses import dataclass
from typing import Annotated

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.admin import auth as admin_auth
from packages.core.settings import get_settings
from packages.db.models.admin import AdminSession
from packages.db.models.core_auth import User
from services.api import ratelimit
from services.api.deps import core_session

_bearer = HTTPBearer(auto_error=False)

_401 = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="admin session required",
    headers={"WWW-Authenticate": "Bearer"},
)


def admin_ip_allowed(request: Request) -> str:
    """403 when ADMIN_IP_ALLOWLIST is set and the client is not on it."""
    ip = ratelimit.client_ip(request)
    allow = get_settings().admin_ip_allowlist_set
    if allow and ip not in allow:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="forbidden")
    return ip


@dataclass
class AdminContext:
    user: User
    session: AdminSession
    ip: str
    user_agent: str | None

    @property
    def user_id(self) -> int:
        return int(self.user.id)


async def current_admin(
    request: Request,
    ip: Annotated[str, Depends(admin_ip_allowed)],
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    db: Annotated[AsyncSession, Depends(core_session)],
) -> AdminContext:
    if creds is None:
        raise _401
    try:
        payload = admin_auth.decode_admin_token(creds.credentials, admin_auth.ACCESS_TYPE)
        user_id = int(payload["sub"])
        tv = payload.get("tv")
        sid = str(payload["sid"])
    except (jwt.PyJWTError, KeyError, TypeError, ValueError):
        raise _401 from None
    if isinstance(tv, bool) or not isinstance(tv, int):
        raise _401

    sess = (await db.execute(select(AdminSession).where(AdminSession.id == sid))).scalar_one_or_none()
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if sess is None or user is None or sess.user_id != user_id or sess.token_version != tv:
        raise _401
    if not admin_auth.session_alive(sess, user):
        raise _401
    admin_auth.touch(sess)
    return AdminContext(user=user, session=sess, ip=ip, user_agent=request.headers.get("user-agent"))


CurrentAdmin = Annotated[AdminContext, Depends(current_admin)]
