"""SendGrid transport, templates and privacy helpers — no network.

The transport runs against `httpx.MockTransport`; waits go to a recording
fake instead of `asyncio.sleep`.
"""

import json
import re

import httpx
import pytest

from packages.core.settings import Settings
from packages.email import templates
from packages.email.client import contact_config_problem, email_config_problem
from packages.email.message import (
    Address,
    EmailSendError,
    OutgoingEmail,
    email_fingerprint,
    mask_email,
    redact_emails,
)
from packages.email.sendgrid import MAIL_SEND_PATH, SendGridMailer, build_payload

SENDER = Address("hello@mail.example.com", "Noey Studio")
KEY = "SG.test-key"


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

    def mailer(self) -> SendGridMailer:
        return SendGridMailer(
            KEY, SENDER, transport=httpx.MockTransport(self.handler), sleep=self.sleep
        )


# ── payload ───────────────────────────────────────────────────────────────────

def test_payload_turns_every_tracking_feature_off_and_orders_content():
    payload = build_payload(SENDER, _message(reply_to=Address("visitor@example.com", "Vis, Itor")))
    assert payload["tracking_settings"] == {
        "click_tracking": {"enable": False, "enable_text": False},
        "open_tracking": {"enable": False},
        "subscription_tracking": {"enable": False},
        "ganalytics": {"enable": False},
    }
    assert [c["type"] for c in payload["content"]] == ["text/plain", "text/html"]
    assert payload["personalizations"] == [{"to": [{"email": "beam@example.com", "name": "Beam"}]}]
    assert payload["from"] == {"email": "hello@mail.example.com", "name": "Noey Studio"}
    assert payload["reply_to"] == {"email": "visitor@example.com", "name": "Vis Itor"}  # no , or ;
    assert payload["categories"] == ["noey-transactional", "verify_email"]
    assert payload["subject"].startswith("ยืนยันอีเมลของคุณ")


# ── transport ─────────────────────────────────────────────────────────────────

async def test_202_is_success_with_bearer_auth():
    rec = Recorder([httpx.Response(202)])
    await rec.mailer().send(_message())
    (request,) = rec.requests
    assert request.method == "POST"
    assert str(request.url) == f"https://api.sendgrid.com{MAIL_SEND_PATH}"
    assert request.headers["authorization"] == f"Bearer {KEY}"
    assert json.loads(request.content)["tracking_settings"]["click_tracking"]["enable"] is False
    assert rec.sleeps == []


async def test_429_honours_retry_after_then_succeeds():
    rec = Recorder([httpx.Response(429, headers={"Retry-After": "2"}), httpx.Response(202)])
    await rec.mailer().send(_message())
    assert len(rec.requests) == 2
    assert rec.sleeps == [2.0]


async def test_5xx_and_network_errors_retry_with_backoff_then_give_up():
    rec = Recorder([
        httpx.Response(503),
        httpx.ConnectError("boom"),
        httpx.Response(500),
    ])
    with pytest.raises(EmailSendError):
        await rec.mailer().send(_message())
    assert len(rec.requests) == 3
    assert len(rec.sleeps) == 2
    assert 0.5 <= rec.sleeps[0] <= 0.75 and 1.0 <= rec.sleeps[1] <= 1.25  # exponential + jitter


@pytest.mark.parametrize("status", [400, 401, 403, 413])
async def test_client_errors_are_final(status):
    body = {"errors": [{"field": "from", "message": "The from address hello@mail.example.com is not verified"}]}
    rec = Recorder([httpx.Response(status, json=body)])
    with pytest.raises(EmailSendError):
        await rec.mailer().send(_message())
    assert len(rec.requests) == 1
    assert rec.sleeps == []


# ── privacy helpers ───────────────────────────────────────────────────────────

def test_addresses_never_reach_logs_in_full():
    assert mask_email("beam@example.com") == "b***@example.com"
    assert mask_email("not-an-address") == "***"
    assert redact_emails("from hello@mail.example.com rejected") == "from h***@mail.example.com rejected"
    assert email_fingerprint("Beam@Example.com ") == email_fingerprint("beam@example.com")
    assert "beam" not in email_fingerprint("beam@example.com")


# ── templates ─────────────────────────────────────────────────────────────────

VENDORS = re.compile(
    r"gemini|claude|openai|anthropic|elevenlabs|twelve ?labs|sendgrid", re.IGNORECASE
)


@pytest.mark.parametrize(
    "rendered",
    [
        templates.verify_email(brand="Noey Studio", link="https://s.example.com/verify-email?token=T1", display_name=None),
        templates.reset_password(brand="Noey Studio", link="https://s.example.com/reset-password?token=T2"),
        templates.change_email_confirm(brand="Noey Studio", link="https://s.example.com/verify-email?token=T3", new_email="new@example.com"),
        templates.change_email_notice(brand="Noey Studio", new_email="new@example.com"),
        templates.contact_message(brand="Noey Studio", name="Visitor", email="v@example.com", message="Hello there, a question."),
    ],
)
def test_templates_are_branded_thai_and_vendor_free(rendered):
    assert re.search(r"[฀-๿]", rendered.subject)  # Thai copy
    assert 'lang="th"' in rendered.html
    for colour in ("#f3f2f2", "#201f1d", "#b68235"):
        assert colour in rendered.html
    assert rendered.text.strip() and "<" not in rendered.text  # a real plain-text part
    assert not VENDORS.search(rendered.subject + rendered.html + rendered.text)


def test_links_appear_in_both_parts_and_come_from_site_url():
    link = templates.build_link("https://site.example.com/", templates.RESET_PATH, "tok_-9")
    assert link == "https://site.example.com/reset-password?token=tok_-9"
    rendered = templates.reset_password(brand="Noey Studio", link=link)
    assert link in rendered.text
    assert f'href="{link}"' in rendered.html


def test_contact_message_is_escaped():
    rendered = templates.contact_message(
        brand="Noey Studio", name='<b onmouseover="x">Eve</b>', email="eve@example.com",
        message="<script>alert(1)</script>\nline two",
    )
    assert "<script>" not in rendered.html
    assert "&lt;script&gt;" in rendered.html
    assert "line two" in rendered.html and "<br>" in rendered.html
    assert "\n" not in rendered.subject


# ── configuration ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({"sendgrid_api_key": ""}, "SENDGRID_API_KEY"),
        ({"email_from_address": None}, "EMAIL_FROM_ADDRESS"),
        ({"postgres_host": "db.railway.internal", "site_url": "http://localhost:3000"}, "SITE_URL"),
        ({}, None),
    ],
)
def test_email_config_problem(overrides, expected):
    base = {
        "sendgrid_api_key": "SG.x",
        "email_from_address": "hello@mail.example.com",
        "site_url": "https://site.example.com",
        "postgres_host": "localhost",
    }
    problem = email_config_problem(Settings(**{**base, **overrides}))
    assert (problem is None) if expected is None else (expected in (problem or ""))


def test_contact_needs_its_own_recipient():
    base = {
        "sendgrid_api_key": "SG.x",
        "email_from_address": "hello@mail.example.com",
        "postgres_host": "localhost",
    }
    assert "CONTACT_TO_EMAIL" in (contact_config_problem(Settings(**base)) or "")
    assert contact_config_problem(Settings(**base, contact_to_email="owner@example.com")) is None
