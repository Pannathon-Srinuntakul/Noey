"""Self-service account provisioning: user + own tenant + owner membership.

One registration = one ``core.users`` row, one ``core.tenants`` row with its
own ``tenant_<slug>`` schema (``packages/db/tenancy.create_tenant_schema`` — the
only schema-creation path), and an ``owner`` membership, all inside the
caller's transaction so a failure leaves nothing behind (PostgreSQL DDL is
transactional, the CREATE SCHEMA included).

The new tenant's business rows live in the shared data schema like everyone
else's — see ``packages/db/tenancy.py``.
"""

import secrets

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.db.models.core_auth import Membership, Tenant, User
from packages.db.tenancy import create_tenant_schema, tenant_schema

PASSWORD_MIN_CHARS = 8
#: bcrypt only reads 72 bytes, and bcrypt>=5 raises instead of truncating —
#: a longer password would otherwise be a 500 at hash time.
PASSWORD_MAX_BYTES = 72
DISPLAY_NAME_MAX_CHARS = 80

# PostgreSQL identifiers are at most 63 bytes; "tenant_" takes 7 of them.
_SLUG_MAX = 63 - len("tenant_")


def normalize_email(raw: str) -> str:
    """The one spelling an address is stored and compared under."""
    return raw.strip().lower()


def password_problem(password: str) -> str | None:
    """Why a password is unacceptable, or None. Length is the whole policy."""
    if len(password) < PASSWORD_MIN_CHARS:
        return f"password must be at least {PASSWORD_MIN_CHARS} characters"
    if len(password.encode("utf-8")) > PASSWORD_MAX_BYTES:
        return f"password must be at most {PASSWORD_MAX_BYTES} bytes"
    return None


def normalize_display_name(raw: str | None) -> str | None:
    """Trimmed display name; blank means "not set"."""
    if raw is None:
        return None
    name = raw.strip()
    return name or None


async def email_taken(session: AsyncSession, email: str) -> bool:
    """Whether any account already uses this address, ignoring case.

    Case-insensitive on purpose: rows created before registration existed were
    stored as typed, and "A@x.com" next to "a@x.com" would be two logins that
    look like one.
    """
    found = await session.execute(
        select(User.id).where(func.lower(User.email) == normalize_email(email)).limit(1)
    )
    return found.scalar_one_or_none() is not None


async def _available_slug(session: AsyncSession, base: str) -> str:
    """``base`` if no tenant has it yet, else ``base`` plus a short random suffix."""
    candidate = base[:_SLUG_MAX]
    for _ in range(8):
        tenant_schema(candidate)  # raises on anything that is not a safe identifier
        taken = await session.execute(select(Tenant.id).where(Tenant.slug == candidate))
        if taken.scalar_one_or_none() is None:
            return candidate
        candidate = f"{base[: _SLUG_MAX - 7]}_{secrets.token_hex(3)}"
    raise RuntimeError(f"could not find a free tenant slug for {base!r}")


async def create_account(
    session: AsyncSession,
    *,
    email: str,
    password_hash: str,
    display_name: str | None,
) -> tuple[User, Tenant]:
    """Create a free-plan user, their own tenant (+ schema) and an owner membership.

    Flushes but does not commit — the caller owns the transaction. A duplicate
    email surfaces as ``IntegrityError`` on the first flush.

    The slug is ``u<user id>``: unique by construction, a valid identifier, and
    free of anything personal (it travels in every JWT and worker log line).
    """
    user = User(
        email=normalize_email(email),
        password_hash=password_hash,
        display_name=display_name,
        is_active=True,
        is_admin=False,
        plan="free",
    )
    session.add(user)
    await session.flush()

    slug = await _available_slug(session, f"u{user.id}")
    tenant = Tenant(slug=slug, name=(display_name or user.email)[:128], ai_config={})
    session.add(tenant)
    await session.flush()

    session.add(Membership(user_id=user.id, tenant_id=tenant.id, role="owner"))
    await create_tenant_schema(session, slug)
    await session.flush()
    return user, tenant
