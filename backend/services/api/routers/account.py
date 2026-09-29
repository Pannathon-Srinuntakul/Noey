"""Self-service account deletion (PDPA). The deleting itself, and what is kept
and why, is packages/auth/account_deletion.py.

    POST /auth/delete-account     Authorization: Bearer <ACCESS token>
        body: {"password": "...", "reauth_token": "...", "forfeit_wallet_balance": false}
        One of `password` (accounts that have one) or `reauth_token` (from
        POST /auth/google/callback with intent "reauth" — the way for a
        Google-only account, allowed for any account with Google linked).
        204  deleted: every token of the account is dead from now on; the
             client drops its stored tokens and signs out locally.
        400  {code: "reauth_required" | "wrong_password" | "reauth_invalid"}
        403  {code: "admin_account"} — an admin is demoted by another admin first
        409  {code: "wallet_balance", balance_satang} — prepaid balance would
             be forfeited; repeat with forfeit_wallet_balance: true
        429  throttled; 502/503 {code: "billing_cancel_failed" |
             "billing_unavailable" | "deletion_incomplete"} — the account is
             not deleted (some content may be), sign-in still works: try again
"""

from __future__ import annotations

import asyncio
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from packages.auth.account_deletion import DeletionRefused, delete_account
from packages.auth.accounts import has_usable_password
from packages.auth.tokens import reauth_matches
from packages.billing import wallet
from packages.core.logging import get_logger
from packages.email import templates
from packages.email.message import Address, OutgoingEmail
from services.api import ratelimit
from services.api.deps import CurrentUser, OptionalMailerDep, core_session
from services.api.routers.auth import _brand, _password_matches, _send_quietly
from services.api.routers.billing import OptionalStripeDep

log = get_logger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

CoreSession = Annotated[AsyncSession, Depends(core_session)]


class DeleteAccountIn(BaseModel):
    password: str | None = Field(default=None, max_length=1024)
    reauth_token: str | None = Field(default=None, max_length=4096)
    forfeit_wallet_balance: bool = False


def _refuse(status_code: int, code: str, message: str, **extra: object) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message, **extra})


@router.post("/delete-account", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
async def delete_my_account(
    body: DeleteAccountIn,
    request: Request,
    background: BackgroundTasks,
    auth: CurrentUser,
    session: CoreSession,
    mailer: OptionalMailerDep,
    stripe_client: OptionalStripeDep,
) -> None:
    await ratelimit.enforce([(ratelimit.DELETE_ACCOUNT_ACCOUNT, str(auth.user_id))])
    user = auth.user
    if user.is_admin:
        raise _refuse(
            403, "admin_account",
            "บัญชีผู้ดูแลระบบลบเองไม่ได้ — ให้ผู้ดูแลระบบคนอื่นถอดสิทธิ์ผู้ดูแลก่อน",
        )

    # Re-authentication: the access token alone is not enough to erase an account.
    if body.reauth_token:
        if not reauth_matches(body.reauth_token, user_id=auth.user_id, token_version=int(user.token_version or 0)):
            raise _refuse(400, "reauth_invalid", "การยืนยันตัวตนกับ Google หมดอายุ — กรุณายืนยันใหม่อีกครั้ง")
    elif body.password:
        ok = await asyncio.to_thread(_password_matches, body.password, str(user.password_hash))
        if not ok:
            raise _refuse(400, "wrong_password", "รหัสผ่านไม่ถูกต้อง")
    else:
        how = "รหัสผ่านปัจจุบัน" if has_usable_password(user.password_hash) else "การยืนยันตัวตนกับ Google"
        raise _refuse(400, "reauth_required", f"กรุณายืนยันตัวตนด้วย{how}ก่อนลบบัญชี")

    balance = await wallet.balance(session, auth.user_id)
    if balance > 0 and not body.forfeit_wallet_balance:
        raise _refuse(
            409, "wallet_balance",
            "ยังมียอดเงินคงเหลือในกระเป๋า ซึ่งจะหายไปเมื่อลบบัญชี — กรุณายืนยันอีกครั้งหากต้องการลบ",
            balance_satang=int(balance),
        )

    try:
        report = await delete_account(session, user, stripe_client=stripe_client)
    except DeletionRefused as exc:
        raise _refuse(exc.status_code, exc.code, exc.message) from None
    if report.already_deleted or not report.former_email:
        return

    if mailer is not None:
        background.add_task(_send_quietly, mailer, OutgoingEmail(
            to=Address(report.former_email, report.former_display_name),
            content=templates.account_deleted(brand=_brand()),
            category="account_deleted",
        ))
    else:
        log.warning("account_deleted_email_skipped", user_id=auth.user_id, reason="email not configured")
