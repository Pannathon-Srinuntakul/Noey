"""Sign-in handoff between our web clients — one login for site and editor.

The account site (www, HttpOnly cookie session held by its server) and the
web editor (app, its own tokens in browser storage) are separate origins with
separate session storage. Instead of a shared cookie or a token in a URL, the
site's SERVER mints a one-time code as the signed-in user and sends the
browser to `<editor>/#handoff=<code>`; the editor redeems it for a pair.
Store and guarantees: packages/auth/handoff.py; the whole flow and its
security properties: docs/auth-handoff.md.

    POST /auth/handoff          Authorization: Bearer <ACCESS token>
        body {"target": "editor"}
        200 {"code": "<43 chars>", "expires_in": 60}
        401 not signed in · 422 unknown target · 429 rate limited
        503 store unreachable (nothing minted)

    POST /auth/handoff/redeem   (no credentials: the code is the credential)
        body {"code": "...", "target": "editor"}
        200 {access_token, refresh_token, token_type}  — exactly /auth/login's
        401 unknown / expired / already used / wrong target / the account
            was deactivated or deleted, or its password changed, since minting
        429 rate limited · 503 store unreachable

Redeeming issues the pair through `auth._tokens_for` — the same function
/auth/login and Google sign-in end in (refresh token registered in the
refresh store, `tv` = the user's token_version). There is no second session
system. Any Authorization header on /redeem is ignored: the user is the one
the code was minted for and nobody else, so a code can never sign in as, or
merge into, a different account than the one whose session minted it.
"""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.auth import handoff
from packages.auth.handoff import HandoffStoreUnavailable
from packages.core.logging import get_logger
from packages.db.models.core_auth import User
from services.api import ratelimit
from services.api.deps import CurrentUser, core_session
from services.api.routers.auth import TokenOut, _home_tenant, _tokens_for

log = get_logger(__name__)

router = APIRouter(prefix="/auth/handoff", tags=["auth"])

CoreSession = Annotated[AsyncSession, Depends(core_session)]

HandoffTarget = Literal["editor"]

_INVALID = "this sign-in link is invalid, has expired or was already used"
_STORE_DOWN = "sign-in is temporarily unavailable — please try again in a moment"


class HandoffIn(BaseModel):
    target: HandoffTarget = "editor"


class HandoffOut(BaseModel):
    code: str
    expires_in: int


class RedeemIn(BaseModel):
    code: str = Field(min_length=1, max_length=handoff.CODE_MAX_CHARS)
    target: HandoffTarget = "editor"


@router.post("", response_model=HandoffOut)
async def mint_handoff(auth: CurrentUser, body: HandoffIn | None = None) -> HandoffOut:
    """A one-time code for the CALLER's own account — never anyone else's."""
    target = body.target if body is not None else "editor"
    await ratelimit.enforce([(ratelimit.HANDOFF_MINT_ACCOUNT, str(auth.user_id))])
    try:
        code = await handoff.mint(auth.user_id, int(auth.user.token_version or 0), target)
    except HandoffStoreUnavailable:
        raise HTTPException(status_code=503, detail=_STORE_DOWN) from None
    log.info("handoff_minted", user_id=auth.user_id, target=target)
    return HandoffOut(code=code, expires_in=handoff.TTL_SEC)


@router.post("/redeem", response_model=TokenOut)
async def redeem_handoff(body: RedeemIn, request: Request, session: CoreSession) -> TokenOut:
    await ratelimit.enforce([(ratelimit.HANDOFF_REDEEM_IP, ratelimit.client_ip(request))])
    try:
        record = await handoff.redeem(body.code, body.target)
    except HandoffStoreUnavailable:
        raise HTTPException(status_code=503, detail=_STORE_DOWN) from None
    if record is None:
        raise HTTPException(status_code=401, detail=_INVALID)

    # The same checks a live session gets on every request (deps.current_user)
    # and at /auth/refresh: an account deactivated or deleted since the code
    # was minted, or whose password changed or was reset since (that bumps
    # `token_version` and signs out every session), gets nothing.
    user = (
        await session.execute(
            select(User).where(
                User.id == record.user_id,
                User.is_active.is_(True),
                User.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if user is None or int(user.token_version or 0) != record.token_version:
        log.info("handoff_refused", user_id=record.user_id, reason="account_state")
        raise HTTPException(status_code=401, detail=_INVALID)
    tenant = await _home_tenant(session, user)
    if tenant is None:
        raise HTTPException(status_code=403, detail="no tenant membership")

    log.info("handoff_redeemed", user_id=int(user.id), target=body.target)
    return await _tokens_for(user, tenant)
