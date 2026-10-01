"""EMAIL_TRANSPORT=resend: Resend's HTTP API (packages/email/resend.py)."""

import json

import httpx
import pytest

from packages.core.settings import Settings
from packages.email import templates
from packages.email.client import email_config_problem, get_mailer
from packages.email.message import Address, EmailSendError, OutgoingEmail
from packages.email.resend import SEND_PATH, ResendMailer, build_payload

SENDER = Address("hello@mail.example.com", "Noey Studio")
KEY = "re_test_key"


def _message(**kw) -> OutgoingEmail:
    content = templates.verify_email(
        brand="Noey Studio", link="https://site.example.com/verify-email?token=abc", display_name="Beam"
    )
    return OutgoingEmail(
        to=kw.get("to", Address("beam@example.com", "Beam")),
        content=content,
        category=kw.get("category", "verify_email"),
        reply_to=kw.get("reply_to"),
    )


class Recorder:
    def __init__(self, responses: list) -> None:
        self.responses = list(responses)
        self.requests: list[httpx.Request] = []
        self.sleeps: list[float] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        nxt = self.responses.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)

    def mailer(self) -> ResendMailer:
        return ResendMailer(KEY, SENDER, transport=httpx.MockTransport(self.handler), sleep=self.sleep)


def test_payload_has_both_parts_sender_name_and_reply_to():
    payload = build_payload(SENDER, _message(reply_to=Address("v@example.com", "Visitor, Inc")))
    assert payload["from"] == "Noey Studio <hello@mail.example.com>"
    assert payload["to"] == ["beam@example.com"]
    assert payload["text"] and payload["html"]
    assert payload["reply_to"] == "Visitor Inc <v@example.com>"
    assert payload["tags"] == [{"name": "category", "value": "verify_email"}]


async def test_200_is_success_with_bearer_auth():
    rec = Recorder([httpx.Response(200, json={"id": "x"})])
    await rec.mailer().send(_message())
    (request,) = rec.requests
    assert str(request.url) == f"https://api.resend.com{SEND_PATH}"
    assert request.headers["authorization"] == f"Bearer {KEY}"
    assert json.loads(request.content)["subject"]
    assert rec.sleeps == []


async def test_429_and_network_errors_retry_then_give_up():
    rec = Recorder([httpx.Response(429, headers={"Retry-After": "1"}), httpx.ConnectError("x"), httpx.Response(503)])
    with pytest.raises(EmailSendError):
        await rec.mailer().send(_message())
    assert len(rec.requests) == 3 and rec.sleeps[0] == 1.0


@pytest.mark.parametrize("status", [400, 401, 403, 422])
async def test_client_errors_are_final(status):
    rec = Recorder([httpx.Response(status, json={"message": "domain hello@mail.example.com not verified"})])
    with pytest.raises(EmailSendError):
        await rec.mailer().send(_message())
    assert len(rec.requests) == 1


def test_config_needs_the_key_and_picks_the_resend_mailer():
    base = {
        "email_transport": "resend",
        "email_from_address": "hello@mail.example.com",
        "site_url": "https://site.example.com",
        "postgres_host": "localhost",
    }
    assert "RESEND_API_KEY" in (email_config_problem(Settings(**base)) or "")
    ok = Settings(**base, resend_api_key="re_x")
    assert email_config_problem(ok) is None
    assert isinstance(get_mailer(ok), ResendMailer)
