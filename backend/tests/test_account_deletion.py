"""Self-service account deletion (POST /auth/delete-account).

Real app + local Postgres; Stripe is a recorder, S3 is patched, files live in
a temporary DATA_DIR. Every account made here is removed afterwards by id
(a deleted account's email is a tombstone, so a LIKE on the domain would miss it).
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from typing import Any

import pytest
import stripe
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

from packages.auth import account_deletion
from packages.auth.account_deletion import delete_account, tombstone_email
from packages.billing import wallet
from packages.core.settings import get_settings
from packages.db.models.core_auth import User
from packages.db.session import get_engine, get_sessionmaker
from packages.email.message import OutgoingEmail
from packages.video import s3
from services.api import deps
from services.api.main import app
from services.api.routers import billing as billing_router
from tests import google_fake
from tests.google_fake import REDIRECT

DOMAIN = "erase.example.com"
PASSWORD = "correct horse battery"
_created: list[int] = []


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _db(sql: str, **params):  # type: ignore[no-untyped-def]
    async with get_engine().begin() as conn:
        result = await conn.execute(text(sql), params)
        return result.all() if result.returns_rows else []


class FakeMailer:
    def __init__(self) -> None:
        self.sent: list[OutgoingEmail] = []

    async def send(self, message: OutgoingEmail) -> None:
        self.sent.append(message)


class FakeStripe:
    """The slice of StripeClient.v1 deletion uses."""

    def __init__(self) -> None:
        self.subscriptions: list[dict[str, Any]] = []
        self.cancelled: list[str] = []
        self.customer_updates: list[tuple[str, dict]] = []
        self.fail_cancel = False
        self.v1 = SimpleNamespace(
            subscriptions=SimpleNamespace(
                list_async=self._list, cancel_async=self._cancel, retrieve_async=self._retrieve
            ),
            customers=SimpleNamespace(update_async=self._customer_update),
        )

    def _sub(self, data: dict) -> Any:
        return stripe.Subscription.construct_from(data, "sk_test_fake")

    async def _list(self, params: dict) -> Any:
        subs = [s for s in self.subscriptions if s["customer"] == params["customer"]]
        return stripe.ListObject.construct_from({"object": "list", "data": subs}, "sk_test_fake")

    async def _cancel(self, sub_id: str, params: Any = None) -> Any:
        if self.fail_cancel:
            raise stripe.APIConnectionError("network down")
        sub = next(s for s in self.subscriptions if s["id"] == sub_id)
        if sub["status"] == "canceled":
            raise stripe.InvalidRequestError("already canceled", param=None)
        sub["status"] = "canceled"
        self.cancelled.append(sub_id)
        return self._sub(sub)

    async def _retrieve(self, sub_id: str, params: Any = None) -> Any:
        return self._sub(next(s for s in self.subscriptions if s["id"] == sub_id))

    async def _customer_update(self, customer_id: str, params: dict) -> Any:
        self.customer_updates.append((customer_id, params))
        return stripe.Customer.construct_from({"id": customer_id, "object": "customer"}, "sk_test_fake")


@pytest.fixture(autouse=True)
async def _env(monkeypatch, tmp_path):
    monkeypatch.setenv("ALLOW_REGISTRATION", "true")
    monkeypatch.setenv("TURNSTILE_SECRET_KEY", "")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "")
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    yield
    app.dependency_overrides.pop(deps.optional_mailer, None)
    app.dependency_overrides.pop(billing_router.optional_stripe_client, None)
    for uid in _created:
        slugs = await _db(
            "SELECT t.slug FROM core.tenants t JOIN core.memberships m ON m.tenant_id = t.id WHERE m.user_id = :u",
            u=uid,
        )
        await _db("DELETE FROM tenant_default.video_projects WHERE user_id = :u", u=uid)
        await _db("DELETE FROM tenant_default.effect_styles WHERE user_id = :u", u=uid)
        await _db("DELETE FROM core.users WHERE id = :u", u=uid)
        for (slug,) in slugs:
            await _db("DELETE FROM core.tenants WHERE slug = :s", s=slug)
            await _db(f'DROP SCHEMA IF EXISTS "tenant_{slug}" CASCADE')
    _created.clear()
    get_settings.cache_clear()


@pytest.fixture
def mail() -> FakeMailer:
    fake = FakeMailer()
    app.dependency_overrides[deps.optional_mailer] = lambda: fake
    return fake


@pytest.fixture
def s3_calls(monkeypatch) -> list[str]:
    calls: list[str] = []

    async def delete_project(uid: str) -> None:
        calls.append(f"project:{uid}")

    async def delete_user_scratch(user_id: int) -> None:
        calls.append(f"scratch:{user_id}")

    monkeypatch.setattr(s3, "delete_project", delete_project)
    monkeypatch.setattr(s3, "delete_user_scratch", delete_user_scratch)
    return calls


async def _register(c: AsyncClient) -> tuple[str, dict, int]:
    email = f"u-{uuid.uuid4().hex[:10]}@{DOMAIN}"
    r = await c.post("/auth/register", json={"email": email, "password": PASSWORD, "display_name": "Erase Me"})
    assert r.status_code == 201, r.text
    tokens = r.json()
    me = (await c.get("/auth/me", headers=_bearer(tokens["access_token"]))).json()
    _created.append(int(me["user_id"]))
    return email, tokens, int(me["user_id"])


async def _project(user_id: int, tmp_path) -> str:  # type: ignore[no-untyped-def]
    uid = str(uuid.uuid4())
    await _db(
        "INSERT INTO tenant_default.video_projects (uid, user_id, tenant_slug, mode, status) "
        "VALUES (:uid, :u, 'default', 'dub_first', 'done')",
        uid=uid, u=user_id,
    )
    for folder in ("video_uploads", "video_outputs"):
        d = tmp_path / folder / uid
        d.mkdir(parents=True)
        (d / "clip.mp4").write_bytes(b"x")
    return uid


async def _delete(c: AsyncClient, tokens: dict, **body) -> Any:
    return await c.post("/auth/delete-account", json=body, headers=_bearer(tokens["access_token"]))


# ── re-authentication ────────────────────────────────────────────────────────

async def test_deletion_needs_a_fresh_proof_not_just_the_session(s3_calls):
    async with _client() as c:
        _, tokens, _ = await _register(c)
        none = await _delete(c, tokens)
        wrong = await _delete(c, tokens, password="wrong password!")
        forged = await _delete(c, tokens, reauth_token="not-a-token")
        still = await c.get("/auth/me", headers=_bearer(tokens["access_token"]))
    assert none.status_code == 400 and none.json()["detail"]["code"] == "reauth_required"
    assert wrong.status_code == 400 and wrong.json()["detail"]["code"] == "wrong_password"
    assert forged.status_code == 400 and forged.json()["detail"]["code"] == "reauth_invalid"
    assert still.status_code == 200
    assert s3_calls == []


async def test_admins_cannot_delete_themselves(s3_calls):
    async with _client() as c:
        _, tokens, user_id = await _register(c)
        await _db("UPDATE core.users SET is_admin = true WHERE id = :u", u=user_id)
        r = await _delete(c, tokens, password=PASSWORD)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "admin_account"


# ── the deletion ─────────────────────────────────────────────────────────────

async def test_delete_erases_content_and_personal_data_and_keeps_accounting_rows(mail, s3_calls, tmp_path):
    async with _client() as c:
        email, tokens, user_id = await _register(c)
        slug = f"u{user_id}"
        uid = await _project(user_id, tmp_path)
        await _db(
            "INSERT INTO tenant_default.effect_styles (uid, user_id, tenant_slug, name) "
            "VALUES (:s, :u, 'default', 'mine')", s=str(uuid.uuid4()), u=user_id,
        )
        tenant_id = (await _db("SELECT id FROM core.tenants WHERE slug = :s", s=slug))[0][0]
        await _db(
            "INSERT INTO core.llm_usage_logs (user_id, tenant_id, feature, model, input_tokens, output_tokens) "
            "VALUES (:u, :t, 'dub', 'm', 1, 1)", u=user_id, t=tenant_id,
        )
        r = await _delete(c, tokens, password=PASSWORD)
        assert r.status_code == 204, r.text
        me = await c.get("/auth/me", headers=_bearer(tokens["access_token"]))
        refresh = await c.post("/auth/refresh", headers=_bearer(tokens["refresh_token"]))
        login = await c.post("/auth/login", json={"email": email, "password": PASSWORD})
        # The address is free again: the person may sign up anew later.
        again = await c.post("/auth/register", json={"email": email, "password": PASSWORD})
        if again.status_code == 201:
            again_me = (await c.get("/auth/me", headers=_bearer(again.json()["access_token"]))).json()
            _created.append(int(again_me["user_id"]))

    assert me.status_code == 401 and refresh.status_code == 401 and login.status_code == 401
    assert again.status_code == 201

    row = (await _db(
        "SELECT email, display_name, is_active, deleted_at IS NOT NULL, email_verified_at, "
        "signup_ip_hash, password_hash FROM core.users WHERE id = :u", u=user_id,
    ))[0]
    assert row[0] == tombstone_email(user_id) and row[1] is None and row[2] is False and row[3] is True
    assert row[4] is None and row[5] is None and not row[6].startswith("$2")
    # Content gone: rows, files, S3 prefixes, the tenant's own schema.
    assert await _db("SELECT 1 FROM tenant_default.video_projects WHERE user_id = :u", u=user_id) == []
    assert await _db("SELECT 1 FROM tenant_default.effect_styles WHERE user_id = :u", u=user_id) == []
    assert not (tmp_path / "video_uploads" / uid).exists() and not (tmp_path / "video_outputs" / uid).exists()
    assert s3_calls == [f"project:{uid}", f"scratch:{user_id}"]
    assert await _db("SELECT 1 FROM information_schema.schemata WHERE schema_name = :s", s=f"tenant_{slug}") == []
    # Kept: accounting rows, and the tenant row they hang on (anonymised).
    assert len(await _db("SELECT 1 FROM core.llm_usage_logs WHERE user_id = :u", u=user_id)) == 1
    assert (await _db("SELECT name FROM core.tenants WHERE id = :t", t=tenant_id))[0][0] == f"deleted-{user_id}"
    # One confirmation, to the address the account HAD.
    assert [m.to.email for m in mail.sent if m.category == "account_deleted"] == [email]


async def test_a_prepaid_balance_needs_an_explicit_forfeit(s3_calls):
    async with _client() as c:
        _, tokens, user_id = await _register(c)
        maker = get_sessionmaker()
        async with maker() as session:
            await session.execute(text("SET search_path TO core, public"))
            await wallet.credit(session, user_id, 5_000, source="admin", kind="adjust")
            await session.commit()
        blocked = await _delete(c, tokens, password=PASSWORD)
        ok = await _delete(c, tokens, password=PASSWORD, forfeit_wallet_balance=True)
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["code"] == "wallet_balance"
    assert blocked.json()["detail"]["balance_satang"] == 5_000
    assert ok.status_code == 204
    # The money trail stays.
    assert len(await _db("SELECT 1 FROM core.wallet_ledger WHERE user_id = :u", u=user_id)) >= 1


async def test_email_not_configured_still_deletes_and_only_logs(s3_calls):
    async with _client() as c:
        _, tokens, user_id = await _register(c)
        r = await _delete(c, tokens, password=PASSWORD)
    assert r.status_code == 204
    assert (await _db("SELECT deleted_at IS NOT NULL FROM core.users WHERE id = :u", u=user_id))[0][0] is True


# ── Stripe ───────────────────────────────────────────────────────────────────

def _stripe_sub(sub_id: str, customer: str, status: str) -> dict:
    return {"id": sub_id, "object": "subscription", "customer": customer, "status": status,
            "items": {"object": "list", "data": []}}


async def test_live_subscriptions_are_cancelled_immediately(s3_calls):
    fake = FakeStripe()
    app.dependency_overrides[billing_router.optional_stripe_client] = lambda: fake
    async with _client() as c:
        _, tokens, user_id = await _register(c)
        cus = f"cus_{uuid.uuid4().hex[:8]}"
        await _db("INSERT INTO core.billing_accounts (user_id, stripe_customer_id, stripe_subscription_id, "
                  "status, pm_brand, pm_last4) VALUES (:u, :c, 'sub_live', 'active', 'visa', '4242')", u=user_id, c=cus)
        fake.subscriptions = [_stripe_sub("sub_live", cus, "active"), _stripe_sub("sub_old", cus, "canceled"),
                              _stripe_sub("sub_due", cus, "past_due")]
        r = await _delete(c, tokens, password=PASSWORD)
    assert r.status_code == 204, r.text
    assert sorted(fake.cancelled) == ["sub_due", "sub_live"]
    assert fake.customer_updates and fake.customer_updates[0][0] == cus
    kept = (await _db("SELECT stripe_customer_id, pm_last4 FROM core.billing_accounts WHERE user_id = :u", u=user_id))[0]
    assert kept == (cus, None)


async def test_a_stripe_failure_deletes_nothing_and_can_be_retried(s3_calls, tmp_path):
    fake = FakeStripe()
    fake.fail_cancel = True
    app.dependency_overrides[billing_router.optional_stripe_client] = lambda: fake
    async with _client() as c:
        _, tokens, user_id = await _register(c)
        uid = await _project(user_id, tmp_path)
        cus = f"cus_{uuid.uuid4().hex[:8]}"
        await _db("INSERT INTO core.billing_accounts (user_id, stripe_customer_id, status) VALUES (:u, :c, 'active')",
                  u=user_id, c=cus)
        fake.subscriptions = [_stripe_sub("sub_live", cus, "active")]
        failed = await _delete(c, tokens, password=PASSWORD)
        assert failed.status_code == 502, failed.text
        assert failed.json()["detail"]["code"] == "billing_cancel_failed"
        assert (tmp_path / "video_uploads" / uid).exists()
        assert (await c.get("/auth/me", headers=_bearer(tokens["access_token"]))).status_code == 200
        fake.fail_cancel = False
        ok = await _delete(c, tokens, password=PASSWORD)
    assert ok.status_code == 204
    assert fake.cancelled == ["sub_live"]


async def test_billing_unconfigured_with_a_live_subscription_on_record_is_refused(s3_calls):
    async with _client() as c:
        _, tokens, user_id = await _register(c)
        await _db("INSERT INTO core.billing_accounts (user_id, stripe_customer_id, status) VALUES (:u, :c, 'active')",
                  u=user_id, c=f"cus_{uuid.uuid4().hex[:8]}")
        r = await _delete(c, tokens, password=PASSWORD)
    assert r.status_code == 503
    assert r.json()["detail"]["code"] == "billing_unavailable"
    assert "STRIPE_SECRET_KEY" in r.json()["detail"]["message"]
    assert (await _db("SELECT deleted_at FROM core.users WHERE id = :u", u=user_id))[0][0] is None


# ── retry safety ─────────────────────────────────────────────────────────────

async def test_an_s3_failure_halfway_resumes_on_retry(monkeypatch, tmp_path):
    calls: list[str] = []
    fail = {"on": True}

    async def delete_project(uid: str) -> None:
        if fail["on"] and calls:
            raise RuntimeError("s3 down")
        calls.append(uid)

    async def delete_user_scratch(user_id: int) -> None:
        return None

    monkeypatch.setattr(s3, "delete_project", delete_project)
    monkeypatch.setattr(s3, "delete_user_scratch", delete_user_scratch)
    async with _client() as c:
        _, tokens, user_id = await _register(c)
        uids = {await _project(user_id, tmp_path), await _project(user_id, tmp_path)}
        halfway = await _delete(c, tokens, password=PASSWORD)
        assert halfway.status_code == 503 and halfway.json()["detail"]["code"] == "deletion_incomplete"
        assert (await c.get("/auth/me", headers=_bearer(tokens["access_token"]))).status_code == 200
        left = await _db("SELECT uid FROM tenant_default.video_projects WHERE user_id = :u", u=user_id)
        assert len(left) == 1  # the first project is gone, the second is still there
        fail["on"] = False
        ok = await _delete(c, tokens, password=PASSWORD)
    assert ok.status_code == 204
    assert set(calls) == uids
    assert await _db("SELECT 1 FROM tenant_default.video_projects WHERE user_id = :u", u=user_id) == []


async def test_deleting_an_already_deleted_account_is_a_no_op(s3_calls):
    async with _client() as c:
        _, tokens, user_id = await _register(c)
        assert (await _delete(c, tokens, password=PASSWORD)).status_code == 204
    maker = get_sessionmaker()
    async with maker() as session:
        await session.execute(text("SET search_path TO core, public"))
        user = await session.get(User, user_id)
        report = await delete_account(session, user, stripe_client=None)
    assert report.already_deleted is True


# ── Google-only accounts ─────────────────────────────────────────────────────

async def test_a_google_only_account_deletes_with_a_google_reauth(monkeypatch, s3_calls):
    google = google_fake.install(monkeypatch)
    monkeypatch.setenv("TURNSTILE_SECRET_KEY", "")
    async with _client() as c:
        async def flow(intent: str, headers: dict | None = None) -> Any:
            started = (await c.post("/auth/google/start", json={"redirect_uri": REDIRECT, "intent": intent},
                                    headers=headers or {})).json()
            code = google.consent(started["authorization_url"], sub="sub-erase", email=f"g-{uuid.uuid4().hex[:6]}@{DOMAIN}")
            return await c.post("/auth/google/callback",
                                json={"code": code, "state": started["state"], "redirect_uri": REDIRECT},
                                headers=headers or {})

        tokens = (await flow("signin")).json()
        me = (await c.get("/auth/me", headers=_bearer(tokens["access_token"]))).json()
        _created.append(int(me["user_id"]))
        needs = await _delete(c, tokens)
        proof = (await flow("reauth", _bearer(tokens["access_token"]))).json()["reauth_token"]
        ok = await _delete(c, tokens, reauth_token=proof)
        signin_again = await flow("signin")  # the identity is gone: a NEW account
        if signin_again.status_code == 200:
            me2 = (await c.get("/auth/me", headers=_bearer(signin_again.json()["access_token"]))).json()
            _created.append(int(me2["user_id"]))
    assert needs.status_code == 400 and "Google" in needs.json()["detail"]["message"]
    assert ok.status_code == 204, ok.text
    assert await _db("SELECT 1 FROM core.oauth_identities WHERE user_id = :u", u=me["user_id"]) == []
    assert signin_again.status_code == 200 and signin_again.json()["created"] is True


def test_the_module_documents_what_it_keeps():
    doc = account_deletion.__doc__ or ""
    for table in ("ai_runs", "llm_usage_logs", "stt_usage_logs", "wallet_ledger", "billing_accounts"):
        assert table in doc
