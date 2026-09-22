# ruff: noqa: F811  (pytest fixtures imported from tests/admin_helpers.py are parameters here)
"""Admin dashboard security: every /admin route refuses anything but a live
admin session; login is enumeration-free, rate-limited, locked out and
audited; codes are single-use and hashed; devices only skip the code.

The route list comes from the app itself, so a new admin route is covered the
moment it is registered.
"""

import hashlib
from datetime import UTC, datetime, timedelta

import jwt
import pytest

from packages.admin import auth as admin_auth
from packages.auth.tokens import encode_access
from packages.core.settings import get_settings
from services.api.main import app
from tests.admin_helpers import (  # noqa: F401  (fixtures)
    PASSWORD,
    _admin_env,
    bearer,
    client,
    db,
    email,
    mail,
    make_user,
    new_admin,
    sign_in,
)

#: The login steps — reachable without a session by design (and tested below).
PUBLIC_ADMIN_ROUTES = {
    ("POST", "/admin/auth/login"),
    ("POST", "/admin/auth/verify"),
    ("POST", "/admin/auth/resend"),
    ("POST", "/admin/auth/refresh"),
}


def _all_routes() -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []

    def walk(routes) -> None:  # type: ignore[no-untyped-def]
        for r in routes:
            inner = getattr(r, "original_router", None) or getattr(r, "routes", None)
            if inner is not None:
                walk(getattr(inner, "routes", inner))
                continue
            path, methods = getattr(r, "path", None), getattr(r, "methods", None)
            if isinstance(path, str) and methods:
                out.extend((m, path) for m in sorted(methods) if m != "HEAD")

    walk(app.routes)
    return out


ADMIN_ROUTES = sorted(r for r in _all_routes() if "/admin" in r[1])
PROTECTED = [r for r in ADMIN_ROUTES if r not in PUBLIC_ADMIN_ROUTES]


#: Token billing's admin routes (docs/token-billing-design.md §9.5) — named so
#: a rename cannot silently drop one out of the guard walk below.
BILLING_ADMIN_ROUTES = {
    ("POST", "/admin/users/{user_id}/window-reset"),
    ("POST", "/admin/users/{user_id}/wallet-adjust"),
    ("POST", "/admin/users/{user_id}/quota-reset"),
    ("GET", "/admin/estimate-accuracy"),
    ("GET", "/admin/billing-config"),
    ("PUT", "/admin/billing-config"),
    ("GET", "/admin/circuit-breaker"),
    ("PUT", "/admin/circuit-breaker"),
    ("GET", "/admin/fx"),
    ("PUT", "/admin/fx"),
    ("POST", "/admin/fx/refresh"),
    ("GET", "/admin/reconciliation"),
    ("PUT", "/admin/reconciliation/{month}"),
}


def test_the_route_list_is_what_the_guard_test_thinks_it_is():
    assert len(PROTECTED) >= 24, PROTECTED
    assert set(PROTECTED) >= BILLING_ADMIN_ROUTES, BILLING_ADMIN_ROUTES - set(PROTECTED)
    assert PUBLIC_ADMIN_ROUTES <= set(ADMIN_ROUTES)
    # The old /usage/admin/* routes (ordinary user token) must stay gone.
    assert not [r for r in _all_routes() if r[1].startswith("/usage/admin")]


def _concrete(path: str, user_id: int) -> str:
    return path.replace("{user_id}", str(user_id)).replace("{month}", "2020-01")


async def _send(c, method: str, path: str, headers: dict[str, str]):  # type: ignore[no-untyped-def]
    return await c.request(method, path, headers=headers, json={} if method in ("POST", "PUT", "PATCH") else None)


def _forge(kind: str, *, user_id: int, sid: str, tv: int, **overrides) -> str:  # type: ignore[no-untyped-def]
    s = get_settings()
    now = datetime.now(UTC)
    payload = {
        "sub": str(user_id), "sid": sid, "tv": tv, "typ": kind, "aud": admin_auth.ADMIN_AUDIENCE,
        "iat": now, "exp": now + timedelta(minutes=10),
    }
    payload.update(overrides)
    return jwt.encode(payload, s.jwt_secret, algorithm=s.jwt_algorithm)


async def test_every_protected_admin_route_refuses_every_bad_credential(mail):
    async with client() as c:
        # A live admin — its token must work, which proves the denials below are real.
        admin_id, _, live = await new_admin(c, mail)
        ok = await c.get("/admin/auth/me", headers=bearer(live["access_token"]))
        assert ok.status_code == 200

        normal_id = await make_user(email("user"))
        user_token = encode_access(normal_id, 1, "default", 0)
        admin_as_user_token = encode_access(admin_id, 1, "default", 0)

        # Deactivated admin, demoted admin, logged-out session, idle session.
        deact_id, _, deact = await new_admin(c, mail)
        demoted_id, _, demoted = await new_admin(c, mail)
        _, _, logged_out = await new_admin(c, mail)
        _, _, idle = await new_admin(c, mail)
        await db("UPDATE core.users SET is_active = false WHERE id = :i", i=deact_id)
        await db("UPDATE core.users SET is_admin = false WHERE id = :i", i=demoted_id)
        assert (await c.post("/admin/auth/logout", json={}, headers=bearer(logged_out["access_token"]))).status_code == 204
        idle_sid = jwt.decode(idle["access_token"], options={"verify_signature": False})["sid"]
        await db("UPDATE core.admin_sessions SET last_seen_at = now() - interval '2 hours' WHERE id = :s", s=idle_sid)

        live_claims = jwt.decode(live["access_token"], options={"verify_signature": False})
        expired = _forge(admin_auth.ACCESS_TYPE, user_id=admin_id, sid=live_claims["sid"], tv=live_claims["tv"],
                         iat=datetime.now(UTC) - timedelta(hours=2), exp=datetime.now(UTC) - timedelta(hours=1))
        wrong_tv = _forge(admin_auth.ACCESS_TYPE, user_id=admin_id, sid=live_claims["sid"], tv=live_claims["tv"] + 1)
        no_aud = jwt.encode(
            {k: v for k, v in jwt.decode(live["access_token"], options={"verify_signature": False}).items() if k != "aud"},
            get_settings().jwt_secret, algorithm="HS256",
        )
        other_key = jwt.encode(live_claims, "not-the-server-secret", algorithm="HS256")
        head, body, sig = live["access_token"].split(".")
        tampered = f"{head}.{body}.{sig[:-2]}{'AA' if not sig.endswith('AA') else 'BB'}"

        bad = {
            "none": {},
            "garbage": bearer("garbage"),
            "user_token": bearer(user_token),
            "admin_user_token": bearer(admin_as_user_token),
            "refresh_as_access": bearer(live["refresh_token"]),
            "deactivated_admin": bearer(deact["access_token"]),
            "demoted_admin": bearer(demoted["access_token"]),
            "logged_out": bearer(logged_out["access_token"]),
            "idle": bearer(idle["access_token"]),
            "expired": bearer(expired),
            "wrong_token_version": bearer(wrong_tv),
            "no_audience": bearer(no_aud),
            "other_signing_key": bearer(other_key),
            "tampered": bearer(tampered),
        }
        failures = []
        for method, path in PROTECTED:
            for name, headers in bad.items():
                r = await _send(c, method, _concrete(path, normal_id), headers)
                if r.status_code not in (401, 403):
                    failures.append((method, path, name, r.status_code))
    assert not failures, failures


async def test_an_admin_token_is_not_a_user_token(mail):
    async with client() as c:
        _, _, s = await new_admin(c, mail)
        for path in ("/auth/me", "/usage/me", "/billing/me"):
            r = await c.get(path, headers=bearer(s["access_token"]))
            assert r.status_code == 401, (path, r.status_code)


async def test_ip_allowlist_blocks_every_admin_route(monkeypatch, mail):
    async with client() as c:
        _, _, s = await new_admin(c, mail)
        monkeypatch.setenv("ADMIN_IP_ALLOWLIST", "203.0.113.9")
        get_settings.cache_clear()
        blocked = await c.get("/admin/auth/me", headers=bearer(s["access_token"]))
        login = await c.post("/admin/auth/login", json={"email": "x@y.z", "password": "p"})
        monkeypatch.setenv("ADMIN_IP_ALLOWLIST", "127.0.0.1")
        get_settings.cache_clear()
        allowed = await c.get("/admin/auth/me", headers=bearer(s["access_token"]))
    assert blocked.status_code == 403 and login.status_code == 403
    assert allowed.status_code == 200


# ── login ────────────────────────────────────────────────────────────────────

async def test_failed_logins_all_look_the_same(mail):
    admin = email("admin")
    user = email("user")
    await make_user(admin, admin=True)
    await make_user(user)
    inactive = email("inactive")
    await make_user(inactive, admin=True, active=False)
    async with client() as c:
        answers = [
            await c.post("/admin/auth/login", json={"email": e, "password": p})
            for e, p in (
                (email("nobody"), PASSWORD),  # unknown address
                (admin, "wrong password"),  # wrong password
                (user, PASSWORD),  # right password, not an admin
                (inactive, PASSWORD),  # deactivated admin
            )
        ]
    assert {r.status_code for r in answers} == {401}
    assert len({r.json()["detail"] for r in answers}) == 1
    assert mail.sent == []


async def test_unknown_email_still_runs_bcrypt(monkeypatch):
    calls: list[str] = []
    real = admin_auth.verify_password

    def spy(plain: str, hashed: str) -> bool:
        calls.append(hashed)
        return real(plain, hashed)

    monkeypatch.setattr(admin_auth, "verify_password", spy)
    async with client() as c:
        await c.post("/admin/auth/login", json={"email": email("ghost"), "password": "whatever"})
    assert len(calls) == 1  # the dummy hash was checked


async def test_lockout_after_five_failures_even_with_the_right_password(mail):
    address = email("admin")
    await make_user(address, admin=True)
    async with client() as c:
        for _ in range(admin_auth.LOCKOUT_FAILURES):
            r = await c.post("/admin/auth/login", json={"email": address, "password": "nope"})
            assert r.status_code == 401
        locked = await c.post("/admin/auth/login", json={"email": address, "password": PASSWORD})
    assert locked.status_code == 429
    assert mail.sent == []


async def test_password_step_is_rate_limited_per_email(mail):
    address = email("admin")
    async with client() as c:
        codes = [
            (await c.post("/admin/auth/login", json={"email": address, "password": "x"})).status_code
            for _ in range(12)
        ]
    assert 429 in codes


async def test_code_is_hashed_single_use_and_bound_to_its_login(mail):
    address = email("admin")
    await make_user(address, admin=True)
    async with client() as c:
        first = (await c.post("/admin/auth/login", json={"email": address, "password": PASSWORD})).json()
        code = mail.last_code()
        stored = await db("SELECT code_hash FROM core.admin_login_challenges WHERE id = :i", i=first["challenge_id"])
        assert stored[0][0] != code and len(stored[0][0]) == 64
        assert code not in first.values()

        ok = await c.post("/admin/auth/verify", json={"challenge_id": first["challenge_id"], "code": code})
        reused = await c.post("/admin/auth/verify", json={"challenge_id": first["challenge_id"], "code": code})
        other = await c.post("/admin/auth/verify", json={"challenge_id": "someone-elses-login", "code": code})
    assert ok.status_code == 200
    assert reused.status_code == 401
    assert other.status_code == 401


async def test_five_wrong_codes_kill_the_login(mail):
    address = email("admin")
    await make_user(address, admin=True)
    async with client() as c:
        ch = (await c.post("/admin/auth/login", json={"email": address, "password": PASSWORD})).json()
        code = mail.last_code()
        wrong = "000000" if code != "000000" else "111111"
        for _ in range(admin_auth.OTP_MAX_ATTEMPTS):
            assert (await c.post("/admin/auth/verify", json={"challenge_id": ch["challenge_id"], "code": wrong})).status_code in (401, 429)
        right = await c.post("/admin/auth/verify", json={"challenge_id": ch["challenge_id"], "code": code})
    assert right.status_code in (401, 429)


async def test_expired_code_is_refused(mail):
    address = email("admin")
    await make_user(address, admin=True)
    async with client() as c:
        ch = (await c.post("/admin/auth/login", json={"email": address, "password": PASSWORD})).json()
        await db("UPDATE core.admin_login_challenges SET expires_at = now() - interval '1 second' WHERE id = :i",
                 i=ch["challenge_id"])
        r = await c.post("/admin/auth/verify", json={"challenge_id": ch["challenge_id"], "code": mail.last_code()})
    assert r.status_code == 401


async def test_resend_replaces_the_code_and_is_capped(mail):
    address = email("admin")
    await make_user(address, admin=True)
    async with client() as c:
        ch = (await c.post("/admin/auth/login", json={"email": address, "password": PASSWORD})).json()
        first = mail.last_code()
        statuses = []
        for _ in range(admin_auth.OTP_MAX_RESENDS + 1):
            statuses.append((await c.post("/admin/auth/resend", json={"challenge_id": ch["challenge_id"]})).status_code)
        latest = mail.last_code()
        old = await c.post("/admin/auth/verify", json={"challenge_id": ch["challenge_id"], "code": first})
        new = await c.post("/admin/auth/verify", json={"challenge_id": ch["challenge_id"], "code": latest})
    assert statuses[: admin_auth.OTP_MAX_RESENDS] == [200] * admin_auth.OTP_MAX_RESENDS
    assert statuses[-1] in (401, 429)
    assert (first == latest) or old.status_code == 401
    assert new.status_code == 200


async def test_code_is_never_logged_without_the_dev_fallback(monkeypatch, capsys):
    """No mailer on a real deployment → 503, and the code appears nowhere."""
    from packages.core import settings as settings_module

    address = email("admin")
    await make_user(address, admin=True)
    monkeypatch.setattr("services.api.routers.admin.is_local_deployment", lambda host: False)
    async with client() as c:
        r = await c.post("/admin/auth/login", json={"email": address, "password": PASSWORD})
    out = capsys.readouterr()
    assert r.status_code == 503
    assert "admin login code" not in out.err + out.out
    assert settings_module  # imported for the patch target's module


async def test_remembered_device_skips_only_the_code(mail):
    async with client() as c:
        uid, address, s = await new_admin(c, mail, remember=True)
        device = s["device_token"]
        assert device
        stored = await db("SELECT token_hash FROM core.admin_devices WHERE user_id = :u", u=uid)
        assert stored[0][0] == hashlib.sha256(device.encode()).hexdigest()

        sent_before = len(mail.sent)
        skipped = await c.post("/admin/auth/login", json={"email": address, "password": PASSWORD, "device_token": device})
        sent_after_skip = len(mail.sent)
        wrong_pw = await c.post("/admin/auth/login", json={"email": address, "password": "nope", "device_token": device})

        other_admin = email("admin")
        await make_user(other_admin, admin=True)
        not_theirs = await c.post(
            "/admin/auth/login", json={"email": other_admin, "password": PASSWORD, "device_token": device}
        )
    assert skipped.status_code == 200 and skipped.json()["status"] == "signed_in"
    assert sent_after_skip == sent_before  # no code needed
    assert wrong_pw.status_code == 401
    assert not_theirs.json()["status"] == "otp_required"


async def test_password_change_forgets_devices_and_ends_sessions(mail):
    async with client() as c:
        uid, address, s = await new_admin(c, mail, remember=True)
        await db("UPDATE core.users SET token_version = token_version + 1 WHERE id = :u", u=uid)
        me = await c.get("/admin/auth/me", headers=bearer(s["access_token"]))
        refreshed = await c.post("/admin/auth/refresh", json={"refresh_token": s["refresh_token"]})
        again = await c.post(
            "/admin/auth/login", json={"email": address, "password": PASSWORD, "device_token": s["device_token"]}
        )
    assert me.status_code == 401
    assert refreshed.status_code == 401
    assert again.json()["status"] == "otp_required"


async def test_logout_revokes_the_session_and_forgets_the_device(mail):
    async with client() as c:
        _, address, s = await new_admin(c, mail, remember=True)
        out = await c.post("/admin/auth/logout", json={"device_token": s["device_token"]}, headers=bearer(s["access_token"]))
        me = await c.get("/admin/auth/me", headers=bearer(s["access_token"]))
        refreshed = await c.post("/admin/auth/refresh", json={"refresh_token": s["refresh_token"]})
        again = await c.post(
            "/admin/auth/login", json={"email": address, "password": PASSWORD, "device_token": s["device_token"]}
        )
    assert out.status_code == 204
    assert me.status_code == 401 and refreshed.status_code == 401
    assert again.json()["status"] == "otp_required"


async def test_refresh_works_while_alive_and_not_after_idle(mail):
    async with client() as c:
        _, _, s = await new_admin(c, mail)
        fresh = await c.post("/admin/auth/refresh", json={"refresh_token": s["refresh_token"]})
        access_as_refresh = await c.post("/admin/auth/refresh", json={"refresh_token": s["access_token"]})
        sid = jwt.decode(s["access_token"], options={"verify_signature": False})["sid"]
        await db("UPDATE core.admin_sessions SET last_seen_at = now() - interval '31 minutes' WHERE id = :s", s=sid)
        idle = await c.post("/admin/auth/refresh", json={"refresh_token": s["refresh_token"]})
    assert fresh.status_code == 200 and fresh.json()["access_token"]
    assert access_as_refresh.status_code == 401
    assert idle.status_code == 401


async def test_every_login_attempt_is_audited(mail):
    address = email("admin")
    uid = await make_user(address, admin=True)
    async with client() as c:
        await c.post("/admin/auth/login", json={"email": address, "password": "wrong"})
        await sign_in(c, mail, address)
    rows = await db(
        "SELECT action, ip, detail FROM core.admin_audit_events WHERE email = :e ORDER BY id", e=address
    )
    actions = [r[0] for r in rows]
    assert actions == ["login_failed", "login_otp_sent", "login_success"]
    assert all(r[1] for r in rows)  # IP recorded
    text_dump = str(rows)
    assert PASSWORD not in text_dump and "wrong" not in [r[2].get("password") for r in rows if r[2]]
    assert uid


@pytest.mark.parametrize("field", ["password_hash", "token_version", "stripe_customer_id"])
async def test_dashboard_never_returns_secrets(mail, field):
    async with client() as c:
        _, _, s = await new_admin(c, mail)
        r = await c.get("/admin/dashboard", headers=bearer(s["access_token"]))
    assert r.status_code == 200
    assert field not in r.text
