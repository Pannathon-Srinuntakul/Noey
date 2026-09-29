"""Sign in with Google: flow security, ID-token verification, and the
account-linking policy (services/api/routers/auth_google.py).

Google is faked (tests/google_fake.py); the app and Postgres are real. Every
account uses `@gsignin.example.com` or a fake Gmail address and is removed.
"""

from __future__ import annotations

import time
import uuid

import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

from packages.auth import google_oauth
from packages.auth.google_oauth import code_challenge, google_config_problem
from packages.core.settings import get_settings
from packages.db.session import get_engine
from services.api.main import app
from tests import google_fake
from tests.google_fake import REDIRECT, REDIRECT_SITE, FakeGoogle

DOMAIN = "gsignin.example.com"
PASSWORD = "correct horse battery"


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _email(tag: str = "u") -> str:
    return f"{tag}-{uuid.uuid4().hex[:10]}@{DOMAIN}"


def _gmail() -> str:
    return f"g-{uuid.uuid4().hex[:10]}@gmail.example.com"


async def _purge() -> None:
    async with get_engine().begin() as conn:
        pattern = "(email LIKE :a OR email LIKE :b)"
        params = {"a": f"%@{DOMAIN}", "b": "%@gmail.example.com"}
        slugs = (
            await conn.execute(
                text(
                    "SELECT t.slug FROM core.tenants t JOIN core.memberships m ON m.tenant_id = t.id "
                    f"JOIN core.users u ON u.id = m.user_id WHERE {pattern.replace('email', 'u.email')}"
                ),
                params,
            )
        ).scalars().all()
        await conn.execute(text(f"DELETE FROM core.users WHERE {pattern}"), params)
        for slug in slugs:
            await conn.execute(text("DELETE FROM core.tenants WHERE slug = :s"), {"s": slug})
            await conn.execute(text(f'DROP SCHEMA IF EXISTS "tenant_{slug}" CASCADE'))


@pytest.fixture(autouse=True)
async def _env(monkeypatch):
    monkeypatch.setenv("ALLOW_REGISTRATION", "true")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "")
    get_settings.cache_clear()
    yield
    await _purge()
    get_settings.cache_clear()


@pytest.fixture
def google(monkeypatch) -> FakeGoogle:
    return google_fake.install(monkeypatch)


async def _start(c: AsyncClient, intent: str = "signin", headers: dict | None = None, **extra) -> dict:
    r = await c.post(
        "/auth/google/start", json={"redirect_uri": REDIRECT, "intent": intent, **extra}, headers=headers or {}
    )
    assert r.status_code == 200, r.text
    return r.json()


async def _google(
    c: AsyncClient, google: FakeGoogle, intent: str = "signin", headers: dict | None = None, **claims
):
    started = await _start(c, intent, headers)
    code = google.consent(started["authorization_url"], **claims)
    return await c.post(
        "/auth/google/callback",
        json={"code": code, "state": started["state"], "redirect_uri": REDIRECT},
        headers=headers or {},
    )


async def _db(sql: str, **params):  # type: ignore[no-untyped-def]
    async with get_engine().begin() as conn:
        result = await conn.execute(text(sql), params)
        return result.all() if result.returns_rows else []


async def _register(c: AsyncClient, email: str, *, verified: bool) -> dict:
    r = await c.post("/auth/register", json={"email": email, "password": PASSWORD})
    assert r.status_code == 201, r.text
    if verified:
        await _db("UPDATE core.users SET email_verified_at = now() WHERE email = :e", e=email)
    return r.json()


# ── configuration: off and harmless without keys ─────────────────────────────

def test_config_problem_names_every_missing_variable():
    s = get_settings()
    problem = google_config_problem(s)
    assert problem is not None
    for var in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URIS"):
        assert var in problem


async def test_unconfigured_routes_answer_503_naming_the_variable_never_500():
    async with _client() as c:
        cfg = await c.get("/auth/google/config")
        start = await c.post("/auth/google/start", json={"redirect_uri": REDIRECT})
        cb = await c.post("/auth/google/callback", json={"code": "x", "state": "y", "redirect_uri": REDIRECT})
    assert cfg.status_code == 200 and cfg.json() == {"enabled": False, "redirect_uris": []}
    for r in (start, cb):
        assert r.status_code == 503, r.text
        assert r.json()["detail"]["code"] == "not_configured"
        assert "GOOGLE_CLIENT_ID" in r.json()["detail"]["message"]


def test_pkce_challenge_matches_rfc7636_appendix_b():
    assert code_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    v = google_oauth.new_code_verifier()
    assert 43 <= len(v) <= 128


# ── the flow's own security ──────────────────────────────────────────────────

async def test_start_builds_a_pkce_authorization_url_for_an_allowed_redirect(google):
    async with _client() as c:
        cfg = (await c.get("/auth/google/config")).json()
        started = await _start(c)
    assert cfg == {"enabled": True, "redirect_uris": [REDIRECT, REDIRECT_SITE]}
    url = started["authorization_url"]
    assert url.startswith(google_oauth.AUTHORIZATION_ENDPOINT + "?")
    for part in ("code_challenge_method=S256", "code_challenge=", "nonce=", "response_type=code",
                 "scope=openid+email+profile", "state="):
        assert part in url
    assert "code_verifier" not in url  # the verifier never leaves the server
    assert started["expires_in"] == google_oauth.FLOW_TTL_SEC


async def test_a_redirect_uri_outside_the_allow_list_is_refused(google):
    async with _client() as c:
        r = await c.post("/auth/google/start", json={"redirect_uri": "https://evil.example.com/cb"})
        r2 = await c.post("/auth/google/start", json={"redirect_uri": REDIRECT + "/"})  # exact match only
    assert r.status_code == 400 and r.json()["detail"]["code"] == "redirect_uri_not_allowed"
    assert r2.status_code == 400


async def test_state_is_single_use(google):
    async with _client() as c:
        started = await _start(c)
        code = google.consent(started["authorization_url"])
        body = {"code": code, "state": started["state"], "redirect_uri": REDIRECT}
        first = await c.post("/auth/google/callback", json=body)
        again = await c.post("/auth/google/callback", json=body)
    assert first.status_code == 200, first.text
    assert again.status_code == 400 and again.json()["detail"]["code"] == "invalid_state"


async def test_forged_or_foreign_state_is_refused(google):
    import jwt as pyjwt

    forged = pyjwt.encode({"sid": "x", "int": "signin", "aud": "noey-google-state", "iat": int(time.time()),
                           "exp": int(time.time()) + 60}, "not-our-secret", algorithm="HS256")
    async with _client() as c:
        r = await c.post("/auth/google/callback", json={"code": "c", "state": forged, "redirect_uri": REDIRECT})
    assert r.status_code == 400 and r.json()["detail"]["code"] == "invalid_state"
    assert google.token_calls == 0


async def test_the_callback_must_name_the_redirect_uri_the_flow_started_with(google):
    async with _client() as c:
        started = await _start(c)
        code = google.consent(started["authorization_url"])
        r = await c.post("/auth/google/callback",
                         json={"code": code, "state": started["state"], "redirect_uri": REDIRECT_SITE})
    assert r.status_code == 400 and r.json()["detail"]["code"] == "redirect_uri_mismatch"
    assert google.token_calls == 0


@pytest.mark.parametrize(
    ("tamper", "why"),
    [
        ({"aud": "another-client.apps.googleusercontent.com"}, "audience"),
        ({"iss": "https://accounts.evil.example.com"}, "issuer"),
        ({"exp": int(time.time()) - 3600, "iat": int(time.time()) - 7200}, "expired"),
        ({"nonce": "replayed-nonce"}, "nonce"),
    ],
)
async def test_id_tokens_are_verified(google, tamper, why):
    google.tamper = tamper
    async with _client() as c:
        r = await _google(c, google)
    assert r.status_code == 401, (why, r.text)
    assert r.json()["detail"]["code"] == "invalid_id_token"


async def test_a_token_signed_by_another_key_is_refused(google):
    google.sign_with = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    async with _client() as c:
        r = await _google(c, google)
    assert r.status_code == 401 and r.json()["detail"]["code"] == "invalid_id_token"


async def test_google_refusing_the_code_is_a_400(google):
    async with _client() as c:
        started = await _start(c)
        r = await c.post("/auth/google/callback",
                         json={"code": "never-issued", "state": started["state"], "redirect_uri": REDIRECT})
    assert r.status_code == 400 and r.json()["detail"]["code"] == "code_rejected"


# ── sign in / sign up ────────────────────────────────────────────────────────

async def test_a_new_google_identity_creates_a_verified_passwordless_account(google):
    gmail = _gmail()
    async with _client() as c:
        r = await _google(c, google, sub="sub-new-1", email=gmail, name="Noey G")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["created"] is True and body["intent"] == "signin"
        me = (await c.get("/auth/me", headers=_bearer(body["access_token"]))).json()
        # The same token machinery as a password login: refresh rotates.
        refreshed = await c.post("/auth/refresh", headers=_bearer(body["refresh_token"]))
        # No password: a password login can never open it.
        login = await c.post("/auth/login", json={"email": gmail, "password": "!no-password"})
    assert me["email"] == gmail and me["email_verified"] is True and me["display_name"] == "Noey G"
    assert me["has_password"] is False and me["google_linked"] is True and me["google_email"] == gmail
    assert me["tenant_slug"] == f"u{me['user_id']}"
    assert refreshed.status_code == 200
    assert login.status_code == 401
    rows = await _db("SELECT subject FROM core.oauth_identities WHERE user_id = :u", u=me["user_id"])
    assert rows == [("sub-new-1",)]


async def test_the_same_sub_signs_back_in_even_after_its_email_changed(google):
    async with _client() as c:
        first = (await _google(c, google, sub="sub-stable", email=_gmail())).json()
        second = await _google(c, google, sub="sub-stable", email=_gmail())
        assert second.status_code == 200, second.text
        me1 = (await c.get("/auth/me", headers=_bearer(first["access_token"]))).json()
        me2 = (await c.get("/auth/me", headers=_bearer(second.json()["access_token"]))).json()
    assert second.json()["created"] is False
    assert me1["user_id"] == me2["user_id"]


async def test_an_unverified_google_email_is_refused(google):
    async with _client() as c:
        r = await _google(c, google, email_verified=False)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "email_not_verified"


async def test_registration_closed_applies_to_google_sign_up(google, monkeypatch):
    monkeypatch.setenv("ALLOW_REGISTRATION", "false")
    get_settings.cache_clear()
    async with _client() as c:
        r = await _google(c, google)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "registration_closed"


async def test_turnstile_is_required_to_create_an_account_when_configured(monkeypatch):
    google = google_fake.install(monkeypatch, turnstile="ts-secret")

    async def verify(token: str, secret: str) -> bool:
        return token == "good"

    from services.api.routers import auth_google

    monkeypatch.setattr(auth_google, "verify_turnstile", verify)
    async with _client() as c:
        without = await _google(c, google)
        bad = await c.post("/auth/google/start", json={"redirect_uri": REDIRECT, "turnstile_token": "bad"})
        started = await _start(c, turnstile_token="good")
        code = google.consent(started["authorization_url"])
        good = await c.post("/auth/google/callback",
                            json={"code": code, "state": started["state"], "redirect_uri": REDIRECT})
    assert without.status_code == 400 and without.json()["detail"]["code"] == "captcha_required"
    assert bad.status_code == 400 and bad.json()["detail"]["code"] == "captcha_failed"
    assert good.status_code == 200 and good.json()["created"] is True


# ── linking policy ───────────────────────────────────────────────────────────

async def test_auto_link_only_onto_an_account_whose_email_we_verified(google):
    email = _email("verified")
    async with _client() as c:
        await _register(c, email, verified=True)
        r = await _google(c, google, email=email)
        assert r.status_code == 200, r.text
        me = (await c.get("/auth/me", headers=_bearer(r.json()["access_token"]))).json()
    assert r.json()["linked"] is True and r.json()["created"] is False
    assert me["email"] == email and me["has_password"] is True and me["google_linked"] is True


async def test_no_auto_link_onto_an_unverified_account_the_takeover_path(google):
    email = _email("squatter")
    async with _client() as c:
        await _register(c, email, verified=False)  # e.g. an attacker pre-registered it
        r = await _google(c, google, email=email)
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert detail["code"] == "link_requires_password"
    assert "รหัสผ่าน" in detail["message"]
    assert await _db("SELECT 1 FROM core.oauth_identities i JOIN core.users u ON u.id = i.user_id "
                     "WHERE u.email = :e", e=email) == []


async def test_explicit_link_from_settings_then_google_sign_in_works(google):
    email = _email("linker")
    async with _client() as c:
        tokens = await _register(c, email, verified=True)
        auth = _bearer(tokens["access_token"])
        linked = await _google(c, google, "link", auth, sub="sub-linked", email=_gmail())
        assert linked.status_code == 200, linked.text
        signin = await _google(c, google, sub="sub-linked", email=_gmail())
        me = (await c.get("/auth/me", headers=_bearer(signin.json()["access_token"]))).json()
    assert linked.json()["intent"] == "link"
    assert signin.status_code == 200 and me["email"] == email


async def _mint(email: str, purpose: str) -> str:
    from packages.auth.email_tokens import issue_token
    from packages.db.session import get_sessionmaker

    (uid,) = (await _db("SELECT id FROM core.users WHERE email = :e", e=email))[0]
    async with get_sessionmaker()() as s:
        raw = await issue_token(s, int(uid), purpose)
        await s.commit()
    return raw


async def test_an_unverified_account_cannot_link_google(google):
    # Pre-account takeover: anyone can register an address they do not own.
    email = _email("squatter")
    async with _client() as c:
        auth = _bearer((await _register(c, email, verified=False))["access_token"])
        start = await c.post("/auth/google/start",
                             json={"redirect_uri": REDIRECT, "intent": "link"}, headers=auth)
    assert start.status_code == 403 and start.json()["detail"]["code"] == "email_not_verified"


async def test_a_squatters_google_link_does_not_survive_the_owners_reset(google):
    """Squatter registers the victim's address and links their own Google
    (legacy row, or a flow started before this fix); the victim resets the
    password from their inbox; the squatter's Google must no longer sign in."""
    email = _email("victim")
    async with _client() as c:
        await _register(c, email, verified=False)
        (uid,) = (await _db("SELECT id FROM core.users WHERE email = :e", e=email))[0]
        await _db("INSERT INTO core.oauth_identities (user_id, provider, subject, email) "
                  "VALUES (:u, 'google', 'sub-squatter', 'attacker@gmail.example.com')", u=uid)
        token = await _mint(email, "reset_password")
        reset = await c.post("/auth/reset-password", json={"token": token, "new_password": "brand new secret"})
        again = await _google(c, google, sub="sub-squatter", email=_gmail())
    assert reset.status_code == 200, reset.text
    assert again.status_code != 200 or again.json().get("created") is True
    assert await _db("SELECT 1 FROM core.oauth_identities WHERE user_id = :u", u=uid) == []


async def test_first_email_verification_drops_links_made_before_it(google):
    email = _email("victim2")
    async with _client() as c:
        await _register(c, email, verified=False)
        (uid,) = (await _db("SELECT id FROM core.users WHERE email = :e", e=email))[0]
        await _db("INSERT INTO core.oauth_identities (user_id, provider, subject, email) "
                  "VALUES (:u, 'google', 'sub-squatter2', 'attacker2@gmail.example.com')", u=uid)
        token = await _mint(email, "verify_email")
        r = await c.post("/auth/verify-email", json={"token": token})
    assert r.status_code == 200, r.text
    assert await _db("SELECT 1 FROM core.oauth_identities WHERE user_id = :u", u=uid) == []


async def test_link_requires_the_same_signed_in_user(google):
    async with _client() as c:
        a = await _register(c, _email("a"), verified=True)
        b = await _register(c, _email("b"), verified=True)
        started = await _start(c, "link", _bearer(a["access_token"]))
        code = google.consent(started["authorization_url"])
        r = await c.post("/auth/google/callback",
                         json={"code": code, "state": started["state"], "redirect_uri": REDIRECT},
                         headers=_bearer(b["access_token"]))
        anon = await c.post("/auth/google/start", json={"redirect_uri": REDIRECT, "intent": "link"})
    assert r.status_code == 403 and r.json()["detail"]["code"] == "wrong_account"
    assert anon.status_code == 401


async def test_a_google_account_links_to_one_user_only(google):
    async with _client() as c:
        a = await _register(c, _email("a"), verified=True)
        b = await _register(c, _email("b"), verified=True)
        ok = await _google(c, google, "link", _bearer(a["access_token"]), sub="sub-shared")
        taken = await _google(c, google, "link", _bearer(b["access_token"]), sub="sub-shared")
        second = await _google(c, google, "link", _bearer(a["access_token"]), sub="sub-other")
    assert ok.status_code == 200
    assert taken.status_code == 409 and taken.json()["detail"]["code"] == "google_in_use"
    assert second.status_code == 409 and second.json()["detail"]["code"] == "already_linked"


async def test_unlink_is_refused_without_a_password_and_allowed_with_one(google):
    async with _client() as c:
        g = (await _google(c, google)).json()
        refused = await c.delete("/auth/google", headers=_bearer(g["access_token"]))
        p = await _register(c, _email("p"), verified=True)
        await _google(c, google, "link", _bearer(p["access_token"]))
        ok = await c.delete("/auth/google", headers=_bearer(p["access_token"]))
        me = (await c.get("/auth/me", headers=_bearer(p["access_token"]))).json()
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "password_required"
    assert ok.status_code == 204 and me["google_linked"] is False


async def test_reauth_returns_a_short_lived_proof_only_for_the_linked_google_account(google):
    async with _client() as c:
        g = (await _google(c, google, sub="sub-reauth")).json()
        auth = _bearer(g["access_token"])
        good = await _google(c, google, "reauth", auth, sub="sub-reauth")
        wrong = await _google(c, google, "reauth", auth, sub="sub-someone-else")
        # A reauth proof is not a session token.
        as_access = await c.get("/auth/me", headers=_bearer(good.json()["reauth_token"]))
        unlinked = await _register(c, _email("nolink"), verified=True)
        no_link = await c.post("/auth/google/start", json={"redirect_uri": REDIRECT, "intent": "reauth"},
                               headers=_bearer(unlinked["access_token"]))
    assert good.status_code == 200 and good.json()["intent"] == "reauth"
    assert good.json()["expires_in"] == 300
    assert wrong.status_code == 403 and wrong.json()["detail"]["code"] == "not_linked_google"
    assert as_access.status_code == 401
    assert no_link.status_code == 409


async def test_the_jwks_is_cached_between_sign_ins(google):
    async with _client() as c:
        await _google(c, google)
        await _google(c, google)
    assert google.jwks_calls == 1


async def test_flow_store_down_is_a_503_not_a_pass(google, monkeypatch):
    class Down:
        async def put(self, *a, **k):
            raise google_oauth.FlowStoreUnavailable("put")

        async def take(self, *a, **k):
            raise google_oauth.FlowStoreUnavailable("take")

    monkeypatch.setattr(google_oauth, "_store", Down())
    async with _client() as c:
        r = await c.post("/auth/google/start", json={"redirect_uri": REDIRECT})
    assert r.status_code == 503 and r.json()["detail"]["code"] == "store_unavailable"
