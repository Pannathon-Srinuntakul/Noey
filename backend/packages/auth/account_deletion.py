"""Self-service account deletion (PDPA right to erasure).

POST /auth/delete-account (services/api/routers/account.py) checks who is
asking; this module does the deleting. Order matters — every step before the
last is safe to repeat, and the last is one transaction:

1. **Stripe** — every subscription that could still bill is cancelled NOW
   (packages/billing/service.py:cancel_subscriptions_now). First, because it
   is the one step that can refuse: if Stripe says no, nothing has been
   deleted yet and the person can simply try again. With billing not
   configured on this server, an account that still has a live subscription
   on record is REFUSED (503 naming STRIPE_SECRET_KEY): deleting it would
   leave Stripe charging a customer who no longer exists for us.
2. **Content** — each video project: in-flight job marked cancelled, local
   upload + output folders removed, the S3 prefix removed, then the row
   (committed per project, so a failure halfway resumes where it stopped).
   Effect/cut styles with their stored reference clip. The user's transcode
   scratch in S3.
3. **The account row, in ONE transaction** — anonymised, not deleted (see
   "kept" below); OAuth identities and emailed tokens deleted; the tenant's
   own schema dropped when the tenant is theirs alone; `token_version`
   bumped (every access and refresh token dies at once).
4. **After commit, best effort** — the refresh-token store is emptied for the
   user (step 3 already made every token useless; this only tidies Redis),
   the Stripe customer's name/email are redacted, and the confirmation mail
   goes to the address the account had.

A second call for an account that is already deleted does nothing (its
`deleted_at` is set) — two racing requests end in one deletion.

What is KEPT, and why (accounting records — Thai Revenue Code s.87/3 and the
Accounting Act B.E. 2543 s.14 expect supporting records to be kept for
5 years; PDPA s.24(6)/s.33 allow keeping data a legal obligation requires):

- ``core.users`` row: kept as an anonymous tombstone — email replaced by
  ``deleted-<id>@deleted.invalid``, no password, no display name, no
  sign-up IP/device hashes, not verified, inactive, plan free. It must stay:
  every row below references it with ON DELETE CASCADE, so deleting it would
  delete the accounting records with it.
- ``core.ai_runs``, ``core.llm_usage_logs``, ``core.stt_usage_logs`` — what
  was used and what it cost (no personal fields; the user id now points at
  the tombstone).
- ``core.wallet_lots`` / ``core.wallet_ledger`` — money received, spent,
  refunded; any remaining balance is forfeited (the caller made the person
  confirm that) and stays visible on the ledger as it was.
- ``core.billing_accounts`` — the Stripe customer id (to reconcile invoices,
  refunds and disputes); the stored card brand/last-4 are cleared.
- ``core.usage_accounts`` — window counters and the wallet cache for the
  runs above (no personal fields).
- ``core.tenants`` row — its name (the display name or email at sign-up) is
  anonymised; the row stays because the usage rows reference it (CASCADE).
- ``core.admin_audit_events`` — security log; the email copy is removed from
  events about this account, the event itself stays.
"""

from __future__ import annotations

import asyncio
import shutil
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession
from stripe import StripeClient

from packages.auth import refresh_store
from packages.auth.accounts import UNUSABLE_PASSWORD_HASH
from packages.auth.refresh_store import RefreshStoreUnavailable
from packages.billing import service as billing_service
from packages.billing.catalog import is_live
from packages.billing.client import billing_config_problem
from packages.billing.service import BillingError
from packages.core.logging import get_logger
from packages.db.models.admin import AdminAuditEvent
from packages.db.models.auth_token import AuthToken
from packages.db.models.billing import BillingAccount
from packages.db.models.core_auth import Job, Membership, Tenant, User
from packages.db.models.effect_style import EffectStyle
from packages.db.models.oauth_identity import OAuthIdentity
from packages.db.models.video_project import VideoProject
from packages.db.session import bind_tenant_search_path, get_sessionmaker
from packages.db.tenancy import DEFAULT_TENANT_SLUG, drop_tenant_schema
from packages.video import s3
from packages.video.storage import data_root, delete_project_files

log = get_logger(__name__)

DELETED_EMAIL_DOMAIN = "deleted.invalid"


def tombstone_email(user_id: int) -> str:
    """Unique per id, and `.invalid` can never receive mail (RFC 2606)."""
    return f"deleted-{int(user_id)}@{DELETED_EMAIL_DOMAIN}"


class DeletionRefused(Exception):
    """Deletion cannot proceed; nothing irreversible has happened yet."""

    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


@dataclass
class DeletionReport:
    user_id: int
    already_deleted: bool = False
    subscriptions_cancelled: int = 0
    projects_deleted: int = 0
    styles_deleted: int = 0
    schema_dropped: bool = False
    #: The address the account had — for the confirmation mail only.
    former_email: str | None = None
    former_display_name: str | None = None
    warnings: list[str] = field(default_factory=list)


# ── step 1: Stripe ────────────────────────────────────────────────────────────

async def _cancel_billing(
    core: AsyncSession, user: User, stripe_client: StripeClient | None, report: DeletionReport
) -> None:
    account = (
        await core.execute(select(BillingAccount).where(BillingAccount.user_id == user.id))
    ).scalar_one_or_none()
    if account is None:
        return
    if stripe_client is None:
        if is_live(account.status) or account.status in ("past_due", "unpaid", "incomplete"):
            problem = billing_config_problem() or "billing is not configured on this server"
            raise DeletionRefused(
                503,
                "billing_unavailable",
                "ยังลบบัญชีไม่ได้ เพราะระบบชำระเงินไม่พร้อมยกเลิกการสมัครสมาชิก — "
                f"กรุณาลองใหม่ภายหลัง ({problem})",
            )
        return
    try:
        report.subscriptions_cancelled = await billing_service.cancel_subscriptions_now(
            core, stripe_client, user
        )
    except BillingError as exc:
        raise DeletionRefused(
            exc.status_code,
            "billing_cancel_failed",
            "ยกเลิกการสมัครสมาชิกไม่สำเร็จ บัญชียังไม่ถูกลบ — กรุณาลองใหม่อีกครั้ง",
        ) from exc
    await core.commit()


# ── step 2: content ──────────────────────────────────────────────────────────

async def _cancel_jobs(user_id: int) -> None:
    """Mark the user's queued/running jobs cancelled (the worker may still be
    mid-task; it will find its project gone and stop)."""
    from packages.db import job_cache

    maker = get_sessionmaker()
    async with maker() as session:
        await session.execute(text("SET search_path TO core, public"))
        ids = (
            await session.execute(
                update(Job)
                .where(Job.user_id == user_id, Job.status.in_(("queued", "running")))
                .values(status="error", progress=0, error="account deleted",
                        result={"step": "cancelled", "message": "บัญชีถูกลบ"})
                .returning(Job.id)
            )
        ).scalars().all()
        await session.commit()
    for job_id in ids:
        await job_cache.drop(job_id)


async def _delete_content(user_id: int, report: DeletionReport) -> None:
    await _cancel_jobs(user_id)
    maker = get_sessionmaker()
    async with maker() as session:
        # Tenant tables live in the shared data schema (packages/db/tenancy.py).
        await bind_tenant_search_path(session, DEFAULT_TENANT_SLUG)
        projects = (
            await session.execute(select(VideoProject).where(VideoProject.user_id == user_id))
        ).scalars().all()
        for p in projects:
            uid = str(p.uid)
            source_files = list(p.source_files or []) if isinstance(p.source_files, list) else None
            try:
                await asyncio.to_thread(delete_project_files, uid, source_files=source_files)
            except Exception:  # same rule as DELETE /videos/{uid}: the row and S3 still go
                log.exception("account_delete_files_failed", uid=uid)
                report.warnings.append(f"local files of project {uid} could not be removed")
            # S3 is NOT best effort: a failure raises and the row stays, so a
            # retry finds the project again and removes the prefix then.
            await s3.delete_project(uid)
            await session.delete(p)
            await session.commit()
            await bind_tenant_search_path(session, DEFAULT_TENANT_SLUG)
            report.projects_deleted += 1

        styles = (
            await session.execute(select(EffectStyle).where(EffectStyle.user_id == user_id))
        ).scalars().all()
        for style in styles:
            shutil.rmtree(data_root() / "effect_styles" / str(style.uid), ignore_errors=True)
            await session.delete(style)
            report.styles_deleted += 1
        await session.commit()
    await s3.delete_user_scratch(user_id)


# ── step 3: the account row ──────────────────────────────────────────────────

async def _anonymise(core: AsyncSession, user_id: int, report: DeletionReport) -> bool:
    """One transaction. False when another request already finished it."""
    user = (
        await core.execute(
            select(User).where(User.id == user_id).with_for_update().execution_options(populate_existing=True)
        )
    ).scalar_one()
    if user.deleted_at is not None:
        return False
    old_email = str(user.email)
    now = datetime.now(UTC)

    memberships = (
        await core.execute(select(Membership).where(Membership.user_id == user_id))
    ).scalars().all()
    for mem in memberships:
        tenant = (await core.execute(select(Tenant).where(Tenant.id == mem.tenant_id))).scalar_one_or_none()
        if tenant is None or tenant.slug == DEFAULT_TENANT_SLUG:
            continue
        members = (
            await core.execute(select(func.count(Membership.id)).where(Membership.tenant_id == tenant.id))
        ).scalar_one()
        if int(members) == 1:
            # Theirs alone: its schema holds nothing anyone else needs (and
            # today holds no tables at all — tenancy.py). The ROW stays: the
            # usage rows reference it with ON DELETE CASCADE.
            await drop_tenant_schema(core, str(tenant.slug))
            tenant.name = f"deleted-{user_id}"
            tenant.ai_config = {}
            report.schema_dropped = True

    await core.execute(delete(OAuthIdentity).where(OAuthIdentity.user_id == user_id))
    await core.execute(delete(AuthToken).where(AuthToken.user_id == user_id))
    await core.execute(
        update(BillingAccount).where(BillingAccount.user_id == user_id).values(pm_brand=None, pm_last4=None)
    )
    await core.execute(
        update(AdminAuditEvent)
        .where(func.lower(AdminAuditEvent.email) == old_email.lower())
        .values(email=None)
    )
    await core.execute(
        update(User)
        .where(User.id == user_id)
        .values(
            email=tombstone_email(user_id),
            password_hash=UNUSABLE_PASSWORD_HASH,
            display_name=None,
            email_verified_at=None,
            signup_ip_hash=None,
            signup_device_hash=None,
            is_active=False,
            is_admin=False,
            plan="free",
            deleted_at=now,
            token_version=User.token_version + 1,
        )
        .execution_options(synchronize_session=False)
    )
    await core.commit()
    return True


# ── the whole thing ──────────────────────────────────────────────────────────

async def delete_account(
    core: AsyncSession, user: User, *, stripe_client: StripeClient | None
) -> DeletionReport:
    """Delete ``user`` (already re-authenticated by the caller). Raises
    ``DeletionRefused`` before anything irreversible when it cannot proceed.

    ``stripe_client`` is None while billing is not configured on this server
    (services/api/routers/billing.py:optional_stripe_client — the same rule
    every billing route follows)."""
    user_id = int(user.id)
    report = DeletionReport(user_id=user_id)
    if user.deleted_at is not None:
        report.already_deleted = True
        return report
    report.former_email = str(user.email)
    report.former_display_name = user.display_name

    await _cancel_billing(core, user, stripe_client, report)
    try:
        await _delete_content(user_id, report)
    except Exception as exc:
        # Storage or the database failed partway. What is gone is gone; the
        # account itself is untouched, so the person can sign in and retry,
        # and the retry resumes with whatever is left.
        log.exception("account_delete_content_failed", user_id=user_id)
        raise DeletionRefused(
            503,
            "deletion_incomplete",
            "ลบข้อมูลได้ไม่ครบในครั้งนี้ บัญชียังไม่ถูกลบ — กรุณาลองใหม่อีกครั้ง",
        ) from exc
    stripe_customer = stripe_client is not None and (
        await core.execute(select(BillingAccount.user_id).where(BillingAccount.user_id == user_id))
    ).scalar_one_or_none() is not None
    if not await _anonymise(core, user_id, report):
        report.already_deleted = True
        return report
    log.info(
        "account_deleted",
        user_id=user_id,
        projects=report.projects_deleted,
        styles=report.styles_deleted,
        subscriptions_cancelled=report.subscriptions_cancelled,
        schema_dropped=report.schema_dropped,
    )

    try:
        await refresh_store.get_store().revoke_all(user_id)
    except RefreshStoreUnavailable:
        report.warnings.append("refresh store unreachable (tokens are revoked by token_version anyway)")
    if stripe_customer and stripe_client is not None:
        await billing_service.redact_customer(core, stripe_client, user)
    return report
