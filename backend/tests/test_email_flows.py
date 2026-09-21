"""Email verification, password reset, email change, session revocation, AI gate.

Through the real app against the local Postgres, with the mailer dependency
replaced by a recorder (no network). Every account uses `@flows.example.com`
and is removed afterwards.
"""

import re
import uuid
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

from packages.auth.accounts import create_account
from packages.auth.hashing import hash_password
from packages.core.settings import get_settings
from packages.db.session import get_engine, get_sessionmaker
from packages.email.message import EmailSendError, OutgoingEmail
from packages.llm.usage import (
    EMAIL_NOT_VERIFIED_DETAIL,
    EmailNotVerified,
    UsageCtx,
    ai_access_problem,
    check_limit,
)
from services.api import deps
from services.api.ai_gate import AI_ROUTES
from services.api.main import app, create_app

DOMAIN = "flows.example.com"
PASSWORD = "correct horse battery"
SITE = "https://site.example.com"


class FakeMailer:
    def __init__(self) -> None:
        self.sent: list[OutgoingEmail] = []
        self.fail = False

    async def send(self, message: OutgoingEmail) -> None:
        if self.fail:
            raise EmailSendError("provider down")
        self.sent.append(message)

    def last(self, category: str) -> OutgoingEmail:
        return [m for m in self.sent if m.category == category][-1]


def _token_in(message: OutgoingEmail) -> str:
    found = re.search(r"token=([A-Za-z0-9_\-]+)", message.content.text)
    assert found, message.content.text
    return found.group(1)


def _email(tag: str = "u") -> str:
    return f"{tag}-{uuid.uuid4().hex[:10]}@{DOMAIN}"


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _purge() -> None:
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
        await conn.execute(text("DELETE FROM core.users WHERE email LIKE :p"), {"p": f"%@{DOMAIN}"})
        for slug in slugs:
            await conn.execute(text("DELETE FROM core.tenants WHERE slug = :s"), {"s": slug})
            await conn.execute(text(f'DROP SCHEMA IF EXISTS "tenant_{slug}" CASCADE'))


@pytest.fixture(autouse=True)
async def _env(monkeypatch):
    monkeypatch.setenv("ALLOW_REGISTRATION", "true")
    monkeypatch.setenv("TURNSTILE_SECRET_KEY", "")
    monkeypatch.setenv("SITE_URL", SITE)
    monkeypatch.setenv("REQUIRE_VERIFIED_EMAIL_FOR_AI", "true")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "")
    get_settings.cache_clear()
    yield
    app.dependency_overrides.pop(deps.optional_mailer, None)
    await _purge()
    get_settings.cache_clear()


@pytest.fixture
def mail() -> FakeMailer:
    fake = FakeMailer()
    app.dependency_overrides[deps.optional_mailer] = lambda: fake
    return fake


async def _register(c: AsyncClient, email: str | None = None) -> tuple[str, dict]:
    email = email or _email()
    r = await c.post("/auth/register", json={"email": email, "password": PASSWORD})
    assert r.status_code == 201, r.text
    return email, r.json()


async def _db(sql: str, **params):  # type: ignore[no-untyped-def]
    async with get_engine().begin() as conn:
        result = await conn.execute(text(sql), params)
        return result.all() if result.returns_rows else []


# ── verification ──────────────────────────────────────────────────────────────

async def test_register_mails_a_single_use_verification_link(mail):
    async with _client() as c:
        email, tokens = await _register(c)
        message = mail.last("verify_email")
        assert message.to.email == email
        assert f"{SITE}/verify-email?token=" in message.content.text
        token = _token_in(message)

        before = (await c.get("/auth/me", headers=_bearer(tokens["access_token"]))).json()
        ok = await c.post("/auth/verify-email", json={"token": token})
        after = (await c.get("/auth/me", headers=_bearer(tokens["access_token"]))).json()
        reused = await c.post("/auth/verify-email", json={"token": token})

    assert before["email_verified"] is False
    assert ok.status_code == 200 and ok.json() == {"email": email, "purpose": "verify_email"}
    assert after["email_verified"] is True
    assert reused.status_code == 400
    stored = await _db("SELECT token_hash FROM core.auth_tokens t JOIN core.users u ON u.id = t.user_id WHERE u.email = :e", e=email)
    assert stored and all(row[0] != token for row in stored)  # only the hash is stored


async def test_registration_succeeds_without_email_configured():
    async with _client() as c:
        email, tokens = await _register(c)
        me = (await c.get("/auth/me", headers=_bearer(tokens["access_token"]))).json()
    assert me["email_verified"] is False
    issued = await _db(
        "SELECT count(*) FROM core.auth_tokens t JOIN core.users u ON u.id = t.user_id WHERE u.email = :e", e=email
    )
    assert issued[0][0] == 0  # nothing to mail, nothing issued (the skip is logged)


async def test_an_expired_link_is_rejected(mail):
    async with _client() as c:
        email, _ = await _register(c)
        token = _token_in(mail.last("verify_email"))
        await _db(
            "UPDATE core.auth_tokens SET expires_at = now() - interval '1 minute' "
            "WHERE user_id = (SELECT id FROM core.users WHERE email = :e)", e=email,
        )
        r = await c.post("/auth/verify-email", json={"token": token})
    assert r.status_code == 400


async def test_garbage_links_are_400():
    async with _client() as c:
        for token in ("nope", "x" * 300):
            r = await c.post("/auth/verify-email", json={"token": token})
            assert r.status_code == 400, token


async def test_resend_voids_the_previous_link(mail):
    async with _client() as c:
        _, tokens = await _register(c)
        first = _token_in(mail.last("verify_email"))
        resent = await c.post("/auth/resend-verification", headers=_bearer(tokens["access_token"]))
        second = _token_in(mail.last("verify_email"))
        old = await c.post("/auth/verify-email", json={"token": first})
        new = await c.post("/auth/verify-email", json={"token": second})
        again = await c.post("/auth/resend-verification", headers=_bearer(tokens["access_token"]))
    assert resent.status_code == 202 and resent.json() == {}
    assert first != second
    assert old.status_code == 400
    assert new.status_code == 200
    assert again.status_code == 409  # already verified


async def test_resend_is_503_without_email_and_when_the_provider_fails(mail):
    async with _client() as c:
        _, tokens = await _register(c)
        mail.fail = True
        failed = await c.post("/auth/resend-verification", headers=_bearer(tokens["access_token"]))
        app.dependency_overrides.pop(deps.optional_mailer)
        unconfigured = await c.post("/auth/resend-verification", headers=_bearer(tokens["access_token"]))
    assert failed.status_code == 503
    assert unconfigured.status_code == 503
    assert "SENDGRID_API_KEY" in unconfigured.json()["detail"]


async def test_resend_is_rate_limited_per_account(mail):
    async with _client() as c:
        _, tokens = await _register(c)
        codes = [
            (await c.post("/auth/resend-verification", headers=_bearer(tokens["access_token"]))).status_code
            for _ in range(4)
        ]
        limited = await c.post("/auth/resend-verification", headers=_bearer(tokens["access_token"]))
    assert codes[:3] == [202, 202, 202]
    assert codes[3] == 429
    assert limited.status_code == 429
    assert "นาที" in limited.json()["detail"]  # Thai
    assert int(limited.headers["retry-after"]) > 0


# ── forgot / reset password ───────────────────────────────────────────────────

async def test_forgot_password_does_not_reveal_accounts(mail):
    async with _client() as c:
        email, _ = await _register(c)
        mail.sent.clear()
        known = await c.post("/auth/forgot-password", json={"email": email.upper()})
        unknown = await c.post("/auth/forgot-password", json={"email": _email("nobody")})
    assert known.status_code == unknown.status_code == 202
    assert known.json() == unknown.json() == {}
    assert [m.category for m in mail.sent] == ["reset_password"]
    assert mail.sent[0].to.email == email
    assert f"{SITE}/reset-password?token=" in mail.sent[0].content.text


async def test_forgot_password_skips_inactive_accounts(mail):
    async with _client() as c:
        email, _ = await _register(c)
        await _db("UPDATE core.users SET is_active = false WHERE email = :e", e=email)
        mail.sent.clear()
        r = await c.post("/auth/forgot-password", json={"email": email})
    assert r.status_code == 202
    assert mail.sent == []


async def test_forgot_password_is_503_without_email():
    async with _client() as c:
        r = await c.post("/auth/forgot-password", json={"email": _email()})
    assert r.status_code == 503


async def test_forgot_password_is_rate_limited_per_email(mail):
    email = _email()
    async with _client() as c:
        codes = [
            (await c.post("/auth/forgot-password", json={"email": email})).status_code for _ in range(4)
        ]
    assert codes == [202, 202, 202, 429]


async def test_reset_password_revokes_every_session_and_verifies(mail):
    async with _client() as c:
        email, old = await _register(c)
        await c.post("/auth/forgot-password", json={"email": email})
        token = _token_in(mail.last("reset_password"))

        weak = await c.post("/auth/reset-password", json={"token": token, "new_password": "short"})
        reset = await c.post("/auth/reset-password", json={"token": token, "new_password": "brand new secret"})
        reused = await c.post("/auth/reset-password", json={"token": token, "new_password": "another secret"})
        old_access = await c.get("/auth/me", headers=_bearer(old["access_token"]))
        old_refresh = await c.post("/auth/refresh", headers=_bearer(old["refresh_token"]))
        new_me = await c.get("/auth/me", headers=_bearer(reset.json()["access_token"]))
        old_pw = await c.post("/auth/login", json={"email": email, "password": PASSWORD})
        new_pw = await c.post("/auth/login", json={"email": email, "password": "brand new secret"})

    assert weak.status_code == 422  # validated before the link is spent
    assert reset.status_code == 200 and set(reset.json()) == {"access_token", "refresh_token", "token_type"}
    assert reused.status_code == 400
    assert old_access.status_code == 401 and old_refresh.status_code == 401
    assert new_me.status_code == 200 and new_me.json()["email_verified"] is True
    assert old_pw.status_code == 401 and new_pw.status_code == 200


async def test_a_new_reset_link_voids_the_older_one(mail):
    async with _client() as c:
        email, _ = await _register(c)
        await c.post("/auth/forgot-password", json={"email": email})
        first = _token_in(mail.last("reset_password"))
        await c.post("/auth/forgot-password", json={"email": email})
        second = _token_in(mail.last("reset_password"))
        old = await c.post("/auth/reset-password", json={"token": first, "new_password": "brand new secret"})
        new = await c.post("/auth/reset-password", json={"token": second, "new_password": "brand new secret"})
    assert old.status_code == 400
    assert new.status_code == 200


async def test_reset_password_rejects_unknown_links():
    async with _client() as c:
        r = await c.post("/auth/reset-password", json={"token": "made-up", "new_password": "brand new secret"})
    assert r.status_code == 400


# ── session revocation (tv claim) ─────────────────────────────────────────────

def _legacy_token(payload: dict) -> str:
    s = get_settings()
    now = datetime.now(UTC)
    return jwt.encode(
        {**payload, "iat": now, "exp": now + timedelta(minutes=5)}, s.jwt_secret, algorithm=s.jwt_algorithm
    )


async def test_tokens_without_tv_survive_until_the_first_revocation():
    async with _client() as c:
        _, tokens = await _register(c)
        claims = jwt.decode(tokens["access_token"], options={"verify_signature": False})
        assert claims["tv"] == 0
        base = {"sub": claims["sub"], "tid": claims["tid"]}
        legacy_access = _legacy_token({**base, "tslug": claims["tslug"], "type": "access"})
        legacy_refresh = _legacy_token({**base, "type": "refresh"})
        wrong_tv = _legacy_token({**base, "tslug": claims["tslug"], "type": "access", "tv": 7})
        junk_tv = _legacy_token({**base, "tslug": claims["tslug"], "type": "access", "tv": "0"})

        before = [
            (await c.get("/auth/me", headers=_bearer(legacy_access))).status_code,
            (await c.post("/auth/refresh", headers=_bearer(legacy_refresh))).status_code,
            (await c.get("/auth/me", headers=_bearer(wrong_tv))).status_code,
            (await c.get("/auth/me", headers=_bearer(junk_tv))).status_code,
        ]
        changed = await c.post(
            "/auth/change-password",
            json={"current_password": PASSWORD, "new_password": "another good one"},
            headers=_bearer(tokens["access_token"]),
        )
        after = [
            (await c.get("/auth/me", headers=_bearer(legacy_access))).status_code,
            (await c.post("/auth/refresh", headers=_bearer(legacy_refresh))).status_code,
        ]
        fresh = jwt.decode(changed.json()["access_token"], options={"verify_signature": False})
    assert before == [200, 200, 401, 401]
    assert after == [401, 401]
    assert fresh["tv"] == 1


# ── email change ──────────────────────────────────────────────────────────────

async def test_change_email_confirms_from_the_new_mailbox(mail):
    async with _client() as c:
        old_email, tokens = await _register(c)
        auth = _bearer(tokens["access_token"])
        new_email = _email("new")
        r = await c.post(
            "/auth/change-email", json={"new_email": new_email.upper(), "current_password": PASSWORD}, headers=auth
        )
        confirm = mail.last("change_email")
        notice = mail.last("change_email_notice")
        pending = (await c.get("/auth/me", headers=auth)).json()
        done = await c.post("/auth/verify-email", json={"token": _token_in(confirm)})
        me = (await c.get("/auth/me", headers=auth)).json()
        login_new = await c.post("/auth/login", json={"email": new_email, "password": PASSWORD})
        login_old = await c.post("/auth/login", json={"email": old_email, "password": PASSWORD})

    assert r.status_code == 202 and r.json() == {}
    assert confirm.to.email == new_email
    assert f"{SITE}/verify-email?token=" in confirm.content.text
    assert notice.to.email == old_email and new_email in notice.content.text
    assert pending["email"] == old_email  # nothing changes before confirmation
    assert done.status_code == 200 and done.json() == {"email": new_email, "purpose": "change_email"}
    assert me["email"] == new_email and me["email_verified"] is True
    assert login_new.status_code == 200 and login_old.status_code == 401


async def test_change_email_refusals(mail):
    async with _client() as c:
        email, tokens = await _register(c)
        other, _ = await _register(c)
        auth = _bearer(tokens["access_token"])
        wrong = await c.post("/auth/change-email", json={"new_email": _email(), "current_password": "nope nope"}, headers=auth)
        same = await c.post("/auth/change-email", json={"new_email": email, "current_password": PASSWORD}, headers=auth)
        taken = await c.post("/auth/change-email", json={"new_email": other.upper(), "current_password": PASSWORD}, headers=auth)
        invalid = await c.post("/auth/change-email", json={"new_email": "not-an-email", "current_password": PASSWORD}, headers=auth)
    assert (wrong.status_code, same.status_code, taken.status_code, invalid.status_code) == (400, 409, 409, 422)


async def test_change_email_conflict_at_confirm_time_keeps_the_link(mail):
    async with _client() as c:
        _, tokens = await _register(c)
        target = _email("contested")
        await c.post(
            "/auth/change-email", json={"new_email": target, "current_password": PASSWORD},
            headers=_bearer(tokens["access_token"]),
        )
        token = _token_in(mail.last("change_email"))
        await _register(c, target)  # someone else takes the address meanwhile
        first = await c.post("/auth/verify-email", json={"token": token})
        second = await c.post("/auth/verify-email", json={"token": token})
    assert first.status_code == 409
    assert second.status_code == 409  # still the conflict, not "used"


async def test_confirming_an_email_change_voids_reset_links_sent_to_the_old_address(mail):
    async with _client() as c:
        email, tokens = await _register(c)
        await c.post("/auth/forgot-password", json={"email": email})
        reset_token = _token_in(mail.last("reset_password"))
        await c.post(
            "/auth/change-email", json={"new_email": _email("moved"), "current_password": PASSWORD},
            headers=_bearer(tokens["access_token"]),
        )
        await c.post("/auth/verify-email", json={"token": _token_in(mail.last("change_email"))})
        r = await c.post("/auth/reset-password", json={"token": reset_token, "new_password": "brand new secret"})
    assert r.status_code == 400


async def test_change_email_is_rate_limited_and_503_without_email(mail):
    async with _client() as c:
        _, tokens = await _register(c)
        auth = _bearer(tokens["access_token"])
        body = {"new_email": _email(), "current_password": "wrong password"}
        codes = [(await c.post("/auth/change-email", json=body, headers=auth)).status_code for _ in range(6)]
        app.dependency_overrides.pop(deps.optional_mailer)
        unconfigured = await c.post("/auth/change-email", json=body, headers=auth)
    assert codes == [400, 400, 400, 400, 400, 429]  # the password oracle is throttled
    assert unconfigured.status_code == 503


# ── the AI gate ───────────────────────────────────────────────────────────────

def test_every_gated_route_exists():
    from tests.test_route_order import _ordered_paths

    methods: dict[str, set[str]] = {}

    def walk(routes) -> None:  # type: ignore[no-untyped-def]
        for r in routes:
            inner = getattr(r, "original_router", None) or getattr(r, "routes", None)
            if inner is not None:
                walk(getattr(inner, "routes", inner))
                continue
            if isinstance(getattr(r, "path", None), str):
                methods.setdefault(r.path, set()).update(getattr(r, "methods", set()) or set())

    fresh = create_app()
    walk(fresh.routes)
    assert set(_ordered_paths(fresh)) >= {path for _, path in AI_ROUTES}
    for method, path in AI_ROUTES:
        assert method in methods[path], (method, path)


async def test_unverified_accounts_cannot_start_ai_work(mail):
    body = {"voDurationSec": 12.0, "clipDurations": [6.0, 6.0]}
    async with _client() as c:
        _, tokens = await _register(c)
        auth = _bearer(tokens["access_token"])
        blocked = await c.post("/videos/no-such-project/plan-dub", json=body, headers=auth)
        blocked_upload = await c.post("/effect-styles", data={"name": "x", "description": "warm"}, headers=auth)
        other_route = await c.get("/videos/storage", headers=auth)
        await c.post("/auth/verify-email", json={"token": _token_in(mail.last("verify_email"))})
        allowed = await c.post("/videos/no-such-project/plan-dub", json=body, headers=auth)
    assert blocked.status_code == 403 and blocked.json()["detail"] == EMAIL_NOT_VERIFIED_DETAIL
    assert blocked_upload.status_code == 403
    assert other_route.status_code == 200  # only work-starting routes are gated
    assert allowed.status_code == 404  # past the gate: the project simply does not exist


async def test_the_gate_spares_admins_and_can_be_switched_off(monkeypatch):
    body = {"voDurationSec": 12.0, "clipDurations": [6.0]}
    async with _client() as c:
        email, tokens = await _register(c)
        auth = _bearer(tokens["access_token"])
        await _db("UPDATE core.users SET is_admin = true WHERE email = :e", e=email)
        as_admin = await c.post("/videos/nope/plan-dub", json=body, headers=auth)
        await _db("UPDATE core.users SET is_admin = false WHERE email = :e", e=email)
        monkeypatch.setenv("REQUIRE_VERIFIED_EMAIL_FOR_AI", "false")
        get_settings.cache_clear()
        switched_off = await c.post("/videos/nope/plan-dub", json=body, headers=auth)
    assert as_admin.status_code == 404
    assert switched_off.status_code == 404


async def test_check_limit_enforces_the_same_policy_before_model_calls():
    maker = get_sessionmaker()
    async with maker() as session:
        user, tenant = await create_account(
            session, email=_email("llm"), password_hash=hash_password("irrelevant!"), display_name=None
        )
        await session.commit()
        user_id, tenant_id = int(user.id), int(tenant.id)
    assert ai_access_problem(user) == EMAIL_NOT_VERIFIED_DETAIL
    with pytest.raises(EmailNotVerified):
        await check_limit(UsageCtx(user_id=user_id, tenant_id=tenant_id, feature="video_cut"))
    await _db("UPDATE core.users SET email_verified_at = now() WHERE id = :i", i=user_id)
    await check_limit(UsageCtx(user_id=user_id, tenant_id=tenant_id, feature="video_cut"))
