"""POST /contact — honeypot, delivery with Reply-To, validation, 503, limits. No network."""

from collections.abc import Iterator

import pytest
from httpx import ASGITransport, AsyncClient

from packages.core.settings import get_settings
from packages.email.message import EmailSendError, OutgoingEmail
from services.api import deps
from services.api.main import app

OWNER = "owner@example.com"


class FakeMailer:
    def __init__(self) -> None:
        self.sent: list[OutgoingEmail] = []
        self.fail = False

    async def send(self, message: OutgoingEmail) -> None:
        if self.fail:
            raise EmailSendError("provider down")
        self.sent.append(message)


@pytest.fixture
def mail(monkeypatch) -> Iterator[FakeMailer]:
    monkeypatch.setenv("SENDGRID_API_KEY", "SG.test")
    monkeypatch.setenv("EMAIL_FROM_ADDRESS", "hello@mail.example.com")
    monkeypatch.setenv("CONTACT_TO_EMAIL", OWNER)
    monkeypatch.setenv("TURNSTILE_SECRET_KEY", "")
    get_settings.cache_clear()
    fake = FakeMailer()
    app.dependency_overrides[deps.optional_mailer] = lambda: fake
    yield fake
    app.dependency_overrides.pop(deps.optional_mailer, None)
    get_settings.cache_clear()


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _body(**kw) -> dict:
    return {
        "name": "Somchai",
        "email": "Visitor@Example.com",
        "message": "สวัสดีครับ อยากสอบถามเรื่องแพ็กเกจ",
        "company": "",
        **kw,
    }


async def test_a_message_reaches_the_owner_with_reply_to_the_visitor(mail):
    async with _client() as c:
        r = await c.post("/contact", json=_body())
    assert r.status_code == 202 and r.json() == {}
    (sent,) = mail.sent
    assert sent.to.email == OWNER
    assert sent.reply_to is not None
    assert sent.reply_to.email == "visitor@example.com" and sent.reply_to.name == "Somchai"
    assert sent.category == "contact"
    assert "Somchai" in sent.content.subject
    assert "อยากสอบถามเรื่องแพ็กเกจ" in sent.content.text


async def test_a_filled_honeypot_is_accepted_and_dropped(mail):
    async with _client() as c:
        codes = [
            (await c.post("/contact", json=_body(company="Acme Bots Ltd"))).status_code
            for _ in range(20)  # also: never throttled, never tells the bot anything
        ]
    assert set(codes) == {202}
    assert mail.sent == []


async def test_the_honeypot_field_may_be_omitted(mail):
    body = _body()
    del body["company"]
    async with _client() as c:
        r = await c.post("/contact", json=body)
    assert r.status_code == 202 and len(mail.sent) == 1


@pytest.mark.parametrize(
    "override",
    [
        {"name": "x" * 101},
        {"name": "   "},
        {"message": "too short"},  # 9 characters
        {"message": "x" * 4001},
        {"email": "not-an-email"},
    ],
)
async def test_invalid_messages_are_422(mail, override):
    async with _client() as c:
        r = await c.post("/contact", json=_body(**override))
    assert r.status_code == 422
    assert mail.sent == []


async def test_not_configured_or_not_sent_is_503(mail, monkeypatch):
    async with _client() as c:
        mail.fail = True
        failed = await c.post("/contact", json=_body(email="a@example.com"))
        monkeypatch.setenv("CONTACT_TO_EMAIL", "")
        get_settings.cache_clear()
        no_recipient = await c.post("/contact", json=_body(email="b@example.com"))
    assert failed.status_code == 503
    assert no_recipient.status_code == 503
    assert "CONTACT_TO_EMAIL" in no_recipient.json()["detail"]


async def test_contact_is_rate_limited_per_visitor_then_per_ip(mail):
    async with _client() as c:
        same_visitor = [(await c.post("/contact", json=_body())).status_code for _ in range(4)]
        # Different visitors from one IP: the looser per-IP rule (10/h). The
        # rules are checked in order and stop at the first refusal, so the
        # refused 4th request above did not count against the IP: 3 so far.
        other_visitors = [
            (await c.post("/contact", json=_body(email=f"v{i}@example.com"))).status_code
            for i in range(8)
        ]
    assert same_visitor == [202, 202, 202, 429]
    assert other_visitors == [202] * 7 + [429]


async def test_turnstile_is_enforced_when_configured(mail, monkeypatch):
    monkeypatch.setenv("TURNSTILE_SECRET_KEY", "0x-secret")
    get_settings.cache_clear()

    async def verify(token: str, secret: str) -> bool:
        return token == "ok"

    monkeypatch.setattr("services.api.routers.contact.verify_turnstile", verify)
    async with _client() as c:
        missing = await c.post("/contact", json=_body())
        good = await c.post("/contact", json=_body(turnstile_token="ok"))
    assert missing.status_code == 400
    assert good.status_code == 202
