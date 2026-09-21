"""Self-service accounts: register, profile edit, change password.

Runs against the local Postgres like tests/test_auth.py. Every account made
here uses the `@register.example.com` domain and is removed afterwards — user,
tenant row and the tenant's schema.
"""

import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

from packages.core.settings import get_settings
from packages.db.session import bind_tenant_search_path, get_engine, get_sessionmaker
from packages.db.tenancy import set_search_path_sql
from services.api.main import app

DOMAIN = "register.example.com"
PASSWORD = "correct horse battery"


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _email(tag: str = "user") -> str:
    return f"{tag}-{uuid.uuid4().hex[:10]}@{DOMAIN}"


async def _purge() -> None:
    async with get_engine().begin() as conn:
        slugs = (
            await conn.execute(
                text(
                    "SELECT t.slug FROM core.tenants t "
                    "JOIN core.memberships m ON m.tenant_id = t.id "
                    "JOIN core.users u ON u.id = m.user_id WHERE u.email LIKE :p"
                ),
                {"p": f"%@{DOMAIN}"},
            )
        ).scalars().all()
        await conn.execute(text("DELETE FROM core.users WHERE email LIKE :p"), {"p": f"%@{DOMAIN}"})
        for slug in slugs:
            await conn.execute(text("DELETE FROM core.tenants WHERE slug = :s"), {"s": slug})
            await conn.execute(text(f'DROP SCHEMA IF EXISTS "tenant_{slug}" CASCADE'))


@pytest.fixture(autouse=True)
async def _registration_env(monkeypatch):
    monkeypatch.setenv("ALLOW_REGISTRATION", "true")
    monkeypatch.setenv("TURNSTILE_SECRET_KEY", "")
    get_settings.cache_clear()
    yield
    await _purge()
    get_settings.cache_clear()


async def _register(c: AsyncClient, **body) -> tuple[int, dict]:
    payload = {"email": _email(), "password": PASSWORD, **body}
    r = await c.post("/auth/register", json=payload)
    return r.status_code, r.json()


# ── the gate ─────────────────────────────────────────────────────────────────

async def test_closed_registration_is_403_even_for_a_valid_body(monkeypatch):
    monkeypatch.setenv("ALLOW_REGISTRATION", "false")
    get_settings.cache_clear()
    async with _client() as c:
        status, body = await _register(c)
    assert status == 403
    assert "closed" in body["detail"]


# ── success ──────────────────────────────────────────────────────────────────

async def test_register_creates_a_free_account_with_its_own_tenant():
    email = _email("Mixed.Case")
    async with _client() as c:
        r = await c.post(
            "/auth/register",
            json={"email": f"  {email.upper()}  ", "password": PASSWORD, "display_name": "  Noey  "},
        )
        assert r.status_code == 201, r.text
        tokens = r.json()
        assert tokens["token_type"] == "bearer"
        me = await c.get("/auth/me", headers={"Authorization": f"Bearer {tokens['access_token']}"})

    assert me.status_code == 200, me.text
    body = me.json()
    assert body["email"] == email.lower()  # normalised: trimmed + lowercased
    assert body["display_name"] == "Noey"  # trimmed
    assert body["role"] == "owner"
    assert body["is_admin"] is False
    assert body["tenant_slug"] == f"u{body['user_id']}"

    async with get_engine().connect() as conn:
        plan = (
            await conn.execute(text("SELECT plan FROM core.users WHERE id = :i"), {"i": body["user_id"]})
        ).scalar_one()
        schema = (
            await conn.execute(
                text("SELECT schema_name FROM information_schema.schemata WHERE schema_name = :s"),
                {"s": f"tenant_{body['tenant_slug']}"},
            )
        ).scalar_one_or_none()
    assert plan == "free"
    assert schema == f"tenant_{body['tenant_slug']}"


async def test_login_and_refresh_work_for_a_registered_account_in_any_case():
    email = _email()
    async with _client() as c:
        r = await c.post("/auth/register", json={"email": email, "password": PASSWORD})
        assert r.status_code == 201, r.text
        # A phone keyboard capitalises the first letter; the account must still open.
        login = await c.post("/auth/login", json={"email": email.capitalize(), "password": PASSWORD})
        assert login.status_code == 200, login.text
        refreshed = await c.post(
            "/auth/refresh", headers={"Authorization": f"Bearer {login.json()['refresh_token']}"}
        )
    assert refreshed.status_code == 200


async def test_a_new_tenant_resolves_the_tenant_tables():
    """The regression the search-path fallback exists for: a tenant other than
    `default` must find `video_projects`, or its first AI job 500s."""
    async with _client() as c:
        status, tokens = await _register(c)
        assert status == 201
        me = await c.get("/auth/me", headers={"Authorization": f"Bearer {tokens['access_token']}"})
    slug = me.json()["tenant_slug"]

    maker = get_sessionmaker()
    async with maker() as session:
        await bind_tenant_search_path(session, slug)
        count = (await session.execute(text("SELECT count(*) FROM video_projects"))).scalar_one()
    assert isinstance(count, int)


def test_the_default_tenant_search_path_is_unchanged():
    assert set_search_path_sql("default") == 'SET search_path TO "tenant_default", core'
    assert set_search_path_sql("u42") == 'SET search_path TO "tenant_u42", "tenant_default", core'


# ── refusals ─────────────────────────────────────────────────────────────────

async def test_duplicate_email_is_409_regardless_of_case():
    email = _email()
    async with _client() as c:
        first = await c.post("/auth/register", json={"email": email, "password": PASSWORD})
        again = await c.post("/auth/register", json={"email": email.upper(), "password": PASSWORD})
    assert first.status_code == 201
    assert again.status_code == 409


@pytest.mark.parametrize(
    "password",
    [
        "short7!",  # 7 characters
        "ก" * 25,  # 25 characters but 75 UTF-8 bytes — over bcrypt's 72
    ],
)
async def test_weak_or_unhashable_password_is_422(password):
    async with _client() as c:
        status, body = await _register(c, password=password)
    assert status == 422
    assert body["detail"][0]["loc"][-1] == "password"


async def test_invalid_email_is_422():
    async with _client() as c:
        r = await c.post("/auth/register", json={"email": "not-an-email", "password": PASSWORD})
    assert r.status_code == 422


async def test_turnstile_is_required_when_configured(monkeypatch):
    monkeypatch.setenv("TURNSTILE_SECRET_KEY", "0x-test-secret")
    get_settings.cache_clear()
    seen: list[tuple[str, str]] = []

    async def fake_verify(token: str, secret: str) -> bool:
        seen.append((token, secret))
        return token == "good-token"

    monkeypatch.setattr("services.api.routers.auth.verify_turnstile", fake_verify)
    async with _client() as c:
        missing, _ = await _register(c)
        rejected, _ = await _register(c, turnstile_token="bad-token")
        accepted, _ = await _register(c, turnstile_token="good-token")
    assert missing == 400
    assert rejected == 400
    assert accepted == 201
    assert seen == [("bad-token", "0x-test-secret"), ("good-token", "0x-test-secret")]


# ── profile + password ───────────────────────────────────────────────────────

async def test_patch_me_sets_and_clears_the_display_name():
    async with _client() as c:
        _, tokens = await _register(c)
        auth = {"Authorization": f"Bearer {tokens['access_token']}"}
        named = await c.patch("/auth/me", json={"display_name": "  Beam "}, headers=auth)
        blank = await c.patch("/auth/me", json={"display_name": "   "}, headers=auth)
        too_long = await c.patch("/auth/me", json={"display_name": "x" * 81}, headers=auth)
        reread = await c.get("/auth/me", headers=auth)
    assert named.status_code == 200 and named.json()["display_name"] == "Beam"
    assert blank.status_code == 200 and blank.json()["display_name"] is None
    assert too_long.status_code == 422
    assert reread.json()["display_name"] is None


async def test_change_password():
    """200 with fresh tokens for the calling session; every earlier token —
    this session's old ones included — is revoked."""
    email = _email()
    async with _client() as c:
        r = await c.post("/auth/register", json={"email": email, "password": PASSWORD})
        old_tokens = r.json()
        auth = {"Authorization": f"Bearer {old_tokens['access_token']}"}

        wrong = await c.post(
            "/auth/change-password",
            json={"current_password": "not the password", "new_password": "another good one"},
            headers=auth,
        )
        weak = await c.post(
            "/auth/change-password",
            json={"current_password": PASSWORD, "new_password": "short"},
            headers=auth,
        )
        ok = await c.post(
            "/auth/change-password",
            json={"current_password": PASSWORD, "new_password": "another good one"},
            headers=auth,
        )
        fresh = {"Authorization": f"Bearer {ok.json()['access_token']}"}
        old_access = await c.get("/auth/me", headers=auth)
        old_refresh = await c.post(
            "/auth/refresh", headers={"Authorization": f"Bearer {old_tokens['refresh_token']}"}
        )
        new_access = await c.get("/auth/me", headers=fresh)
        old_login = await c.post("/auth/login", json={"email": email, "password": PASSWORD})
        new_login = await c.post("/auth/login", json={"email": email, "password": "another good one"})

    assert wrong.status_code == 400
    assert weak.status_code == 422
    assert ok.status_code == 200
    assert set(ok.json()) == {"access_token", "refresh_token", "token_type"}
    assert old_access.status_code == 401  # revoked
    assert old_refresh.status_code == 401  # revoked
    assert new_access.status_code == 200
    assert old_login.status_code == 401
    assert new_login.status_code == 200


async def test_change_password_requires_auth():
    async with _client() as c:
        r = await c.post(
            "/auth/change-password", json={"current_password": "x" * 8, "new_password": "y" * 8}
        )
    assert r.status_code == 401
