"""Shared fixtures for the admin dashboard tests (real app, local Postgres).

Every account uses ``@admin-tests.example.com`` and is removed afterwards,
together with its audit rows.
"""

import re
import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

from packages.auth.accounts import create_account
from packages.auth.hashing import hash_password
from packages.core.settings import get_settings
from packages.db.session import get_engine, get_sessionmaker
from packages.email.message import OutgoingEmail
from services.api import deps
from services.api.main import app

DOMAIN = "admin-tests.example.com"
PASSWORD = "admin tests correct horse"


class FakeMailer:
    def __init__(self) -> None:
        self.sent: list[OutgoingEmail] = []

    async def send(self, message: OutgoingEmail) -> None:
        self.sent.append(message)

    def last_code(self) -> str:
        message = [m for m in self.sent if m.category == "admin_login_code"][-1]
        found = re.search(r"รหัส: (\d{6})", message.content.text)
        assert found, message.content.text
        return found.group(1)


def client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def email(tag: str = "u") -> str:
    return f"{tag}-{uuid.uuid4().hex[:10]}@{DOMAIN}"


async def db(sql: str, **params):  # type: ignore[no-untyped-def]
    async with get_engine().begin() as conn:
        result = await conn.execute(text(sql), params)
        return result.all() if result.returns_rows else []


async def make_user(address: str, *, admin: bool = False, plan: str = "free", active: bool = True) -> int:
    async with get_sessionmaker()() as session:
        await session.execute(text("SET search_path TO core, public"))
        user, _ = await create_account(
            session, email=address, password_hash=hash_password(PASSWORD), display_name=None
        )
        user.is_admin = admin
        user.plan = plan
        user.is_active = active
        await session.commit()
        return int(user.id)


async def purge() -> None:
    async with get_engine().begin() as conn:
        slugs = (
            await conn.execute(
                text(
                    "SELECT t.slug FROM core.tenants t JOIN core.memberships m ON m.tenant_id = t.id "
                    "JOIN core.users u ON u.id = m.user_id WHERE u.email LIKE :p"
                ),
                {"p": f"%@{DOMAIN}"},
            )
        ).scalars().all()
        await conn.execute(text("DELETE FROM core.admin_audit_events WHERE email LIKE :p"), {"p": f"%@{DOMAIN}"})
        await conn.execute(
            text(
                "DELETE FROM core.admin_audit_events WHERE actor_user_id IN "
                "(SELECT id FROM core.users WHERE email LIKE :p) OR target_user_id IN "
                "(SELECT id FROM core.users WHERE email LIKE :p)"
            ),
            {"p": f"%@{DOMAIN}"},
        )
        await conn.execute(text("DELETE FROM core.users WHERE email LIKE :p"), {"p": f"%@{DOMAIN}"})
        for slug in slugs:
            await conn.execute(text("DELETE FROM core.tenants WHERE slug = :s"), {"s": slug})
            await conn.execute(text(f'DROP SCHEMA IF EXISTS "tenant_{slug}" CASCADE'))


@pytest.fixture
def mail() -> FakeMailer:
    fake = FakeMailer()
    app.dependency_overrides[deps.optional_mailer] = lambda: fake
    yield fake
    app.dependency_overrides.pop(deps.optional_mailer, None)


@pytest.fixture(autouse=True)
async def _admin_env(monkeypatch):
    monkeypatch.setenv("STRIPE_SECRET_KEY", "")
    monkeypatch.setenv("ADMIN_IP_ALLOWLIST", "")
    get_settings.cache_clear()
    yield
    await purge()
    get_settings.cache_clear()


async def sign_in(c: AsyncClient, mail: FakeMailer, address: str, *, remember: bool = False) -> dict:
    r = await c.post("/admin/auth/login", json={"email": address, "password": PASSWORD})
    assert r.status_code == 200, r.text
    challenge = r.json()
    assert challenge["status"] == "otp_required"
    v = await c.post(
        "/admin/auth/verify",
        json={"challenge_id": challenge["challenge_id"], "code": mail.last_code(), "remember_device": remember},
    )
    assert v.status_code == 200, v.text
    return v.json()


async def new_admin(c: AsyncClient, mail: FakeMailer, *, remember: bool = False) -> tuple[int, str, dict]:
    address = email("admin")
    uid = await make_user(address, admin=True)
    return uid, address, await sign_in(c, mail, address, remember=remember)


async def user_token(user_id: int) -> str:
    """An ordinary web/desktop access token for ``user_id``."""
    from packages.auth.tokens import encode_access

    row = await db(
        "SELECT t.id, t.slug, u.token_version FROM core.tenants t JOIN core.memberships m ON m.tenant_id = t.id "
        "JOIN core.users u ON u.id = m.user_id WHERE m.user_id = :u",
        u=user_id,
    )
    return encode_access(user_id, int(row[0][0]), str(row[0][1]), int(row[0][2]))
