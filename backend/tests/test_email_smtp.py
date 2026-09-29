"""SMTP transport against a real local SMTP server (aiosmtpd) — no network.

Covers plain delivery (the MIME the server receives), STARTTLS + AUTH,
implicit TLS, retry on 4xx, final 5xx, auth failure, refusing to continue in
clear when STARTTLS is missing, the config checks, and the transport switch.
"""

import datetime as dt
import email
import ipaddress
import socket
import ssl
from email import policy

import pytest
from aiosmtpd.controller import Controller
from aiosmtpd.smtp import AuthResult, LoginPassword
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from packages.core.settings import Settings
from packages.email import templates
from packages.email.client import email_config_problem, get_mailer
from packages.email.message import Address, EmailSendError, OutgoingEmail
from packages.email.sendgrid import SendGridMailer
from packages.email.smtp import SmtpMailer, build_message

SENDER = Address("hello@mail.example.com", "Noey Studio")
USER, PASSWORD = "relay-user", "relay-pass-123"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _message(**kw) -> OutgoingEmail:
    content = templates.verify_email(
        brand="Noey Studio", link="https://site.example.com/verify-email?token=abc", display_name="บีม"
    )
    return OutgoingEmail(
        to=kw.get("to", Address("beam@example.com", "บีม")),
        content=content,
        category="verify_email",
        reply_to=kw.get("reply_to"),
    )


class Handler:
    """Records every message; replies from a scripted list, then 250."""

    def __init__(self, replies: list[str] | None = None) -> None:
        self.replies = list(replies or [])
        self.messages: list[tuple[str, list[str], bytes]] = []

    async def handle_DATA(self, server, session, envelope):
        if self.replies:
            return self.replies.pop(0)
        self.messages.append((envelope.mail_from, list(envelope.rcpt_tos), envelope.content))
        return "250 OK"


def _authenticator(server, session, envelope, mechanism, auth_data):
    ok = isinstance(auth_data, LoginPassword) and (
        auth_data.login == USER.encode() and auth_data.password == PASSWORD.encode()
    )
    # handled=False: aiosmtpd answers the 535 itself on failure.
    return AuthResult(success=ok, handled=False)


@pytest.fixture(scope="module")
def tls_pair(tmp_path_factory):
    """A throwaway CA-less self-signed cert for 127.0.0.1 / localhost."""
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    now = dt.datetime.now(dt.UTC)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5))
        .not_valid_after(now + dt.timedelta(days=1))
        .add_extension(
            x509.SubjectAlternativeName(
                [x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]
            ),
            critical=False,
        )
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    d = tmp_path_factory.mktemp("tls")
    cert_path, key_path = d / "cert.pem", d / "key.pem"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    server_ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    server_ctx.load_cert_chain(cert_path, key_path)
    client_ctx = ssl.create_default_context(cafile=str(cert_path))
    return server_ctx, client_ctx


class _Sleeps:
    def __init__(self) -> None:
        self.calls: list[float] = []

    async def __call__(self, seconds: float) -> None:
        self.calls.append(seconds)


def _run(controller: Controller):
    controller.start()
    return controller


# ── delivery ──────────────────────────────────────────────────────────────────


async def test_plain_delivery_sends_multipart_thai_mail():
    handler = Handler()
    port = _free_port()
    ctl = _run(Controller(handler, hostname="127.0.0.1", port=port))
    try:
        mailer = SmtpMailer(host="127.0.0.1", port=port, security="none", sender=SENDER)
        await mailer.send(_message(reply_to=Address("visitor@example.org", "Visitor")))
    finally:
        ctl.stop()
    assert len(handler.messages) == 1
    mail_from, rcpts, raw = handler.messages[0]
    assert mail_from == "hello@mail.example.com"
    assert rcpts == ["beam@example.com"]
    parsed = email.message_from_bytes(raw, policy=policy.default)
    assert "hello@mail.example.com" in parsed["From"]
    assert parsed["Reply-To"].addresses[0].addr_spec == "visitor@example.org"
    assert parsed["To"].addresses[0].display_name == "บีม"
    assert parsed["Auto-Submitted"] == "auto-generated"
    assert parsed["Message-ID"].endswith("@mail.example.com>")
    assert parsed.get_content_type() == "multipart/alternative"
    parts = [p.get_content_type() for p in parsed.iter_parts()]
    assert parts == ["text/plain", "text/html"]
    text = parsed.get_body(("plain",)).get_content()
    assert "https://site.example.com/verify-email?token=abc" in text


async def test_starttls_then_auth(tls_pair):
    server_ctx, client_ctx = tls_pair
    handler = Handler()
    port = _free_port()
    ctl = _run(Controller(
        handler, hostname="127.0.0.1", port=port, tls_context=server_ctx,
        require_starttls=True, authenticator=_authenticator, auth_require_tls=True,
    ))
    try:
        mailer = SmtpMailer(
            host="127.0.0.1", port=port, security="starttls", sender=SENDER,
            username=USER, password=PASSWORD, tls_context=client_ctx,
        )
        await mailer.send(_message())
    finally:
        ctl.stop()
    assert len(handler.messages) == 1


async def test_implicit_tls(tls_pair):
    server_ctx, client_ctx = tls_pair
    handler = Handler()
    port = _free_port()
    ctl = _run(Controller(
        handler, hostname="127.0.0.1", port=port, ssl_context=server_ctx,
        authenticator=_authenticator, auth_require_tls=False,
    ))
    try:
        mailer = SmtpMailer(
            host="127.0.0.1", port=port, security="ssl", sender=SENDER,
            username=USER, password=PASSWORD, tls_context=client_ctx,
        )
        await mailer.send(_message())
    finally:
        ctl.stop()
    assert len(handler.messages) == 1


async def test_untrusted_certificate_is_final_and_never_falls_back(tls_pair):
    server_ctx, _ = tls_pair
    handler = Handler()
    port = _free_port()
    ctl = _run(Controller(handler, hostname="127.0.0.1", port=port, tls_context=server_ctx))
    sleeps = _Sleeps()
    try:
        # The default context does not trust the throwaway certificate.
        mailer = SmtpMailer(host="127.0.0.1", port=port, security="starttls", sender=SENDER, sleep=sleeps)
        with pytest.raises(EmailSendError, match="certificate"):
            await mailer.send(_message())
    finally:
        ctl.stop()
    assert handler.messages == [] and sleeps.calls == []


async def test_missing_starttls_is_final():
    handler = Handler()
    port = _free_port()
    ctl = _run(Controller(handler, hostname="127.0.0.1", port=port))  # no tls_context
    try:
        mailer = SmtpMailer(
            host="127.0.0.1", port=port, security="starttls", sender=SENDER,
            username=USER, password=PASSWORD,
        )
        with pytest.raises(EmailSendError, match="STARTTLS"):
            await mailer.send(_message())
    finally:
        ctl.stop()
    assert handler.messages == []


async def test_wrong_password_is_final(tls_pair):
    server_ctx, client_ctx = tls_pair
    handler = Handler()
    port = _free_port()
    ctl = _run(Controller(
        handler, hostname="127.0.0.1", port=port, tls_context=server_ctx,
        authenticator=_authenticator, auth_require_tls=True,
    ))
    sleeps = _Sleeps()
    try:
        mailer = SmtpMailer(
            host="127.0.0.1", port=port, security="starttls", sender=SENDER,
            username=USER, password="wrong", tls_context=client_ctx, sleep=sleeps,
        )
        with pytest.raises(EmailSendError, match="authentication"):
            await mailer.send(_message())
    finally:
        ctl.stop()
    assert sleeps.calls == []


async def test_temporary_reply_is_retried_then_delivered():
    handler = Handler(["451 4.3.0 try again later"])
    port = _free_port()
    ctl = _run(Controller(handler, hostname="127.0.0.1", port=port))
    sleeps = _Sleeps()
    try:
        mailer = SmtpMailer(host="127.0.0.1", port=port, security="none", sender=SENDER, sleep=sleeps)
        await mailer.send(_message())
    finally:
        ctl.stop()
    assert len(handler.messages) == 1 and len(sleeps.calls) == 1


async def test_permanent_reply_is_final():
    handler = Handler(["554 5.7.1 rejected"])
    port = _free_port()
    ctl = _run(Controller(handler, hostname="127.0.0.1", port=port))
    sleeps = _Sleeps()
    try:
        mailer = SmtpMailer(host="127.0.0.1", port=port, security="none", sender=SENDER, sleep=sleeps)
        with pytest.raises(EmailSendError, match="554"):
            await mailer.send(_message())
    finally:
        ctl.stop()
    assert sleeps.calls == []


async def test_unreachable_server_retries_then_gives_up():
    sleeps = _Sleeps()
    mailer = SmtpMailer(
        host="127.0.0.1", port=_free_port(), security="none", sender=SENDER, sleep=sleeps, timeout_sec=2
    )
    with pytest.raises(EmailSendError, match="after 3 attempts"):
        await mailer.send(_message())
    assert len(sleeps.calls) == 2


def test_header_injection_is_impossible():
    msg = build_message(SENDER, _message(to=Address("beam@example.com", "Beam\r\nBcc: x@evil.test")))
    raw = msg.as_bytes()
    assert b"\r\nBcc:" not in raw
    with pytest.raises(EmailSendError):
        build_message(SENDER, _message(to=Address("beam@example.com\r\nBcc: x@evil.test")))


def test_repr_never_shows_the_password():
    mailer = SmtpMailer(host="smtp.example.com", port=587, security="starttls", sender=SENDER,
                        username=USER, password=PASSWORD)
    assert PASSWORD not in repr(mailer)


# ── configuration ─────────────────────────────────────────────────────────────

BASE = {
    "email_transport": "smtp",
    "email_from_address": "hello@mail.example.com",
    "site_url": "https://noey.example.com",
    "postgres_host": "db.internal",
}


@pytest.mark.parametrize(
    "overrides, expected",
    [
        ({}, "SMTP_HOST"),
        ({"smtp_host": "smtp.example.com"}, None),
        ({"smtp_host": "smtp.example.com", "smtp_username": "u"}, "SMTP_PASSWORD"),
        ({"smtp_host": "smtp.example.com", "smtp_password": "p"}, "SMTP_USERNAME"),
        ({"smtp_host": "smtp.example.com", "smtp_username": "u", "smtp_password": "p"}, None),
        ({"smtp_host": "smtp.example.com", "smtp_security": "tls13"}, "SMTP_SECURITY"),
        ({"smtp_host": "smtp.example.com", "smtp_security": "none"}, "SMTP_SECURITY=none"),
        ({"smtp_host": "127.0.0.1", "smtp_security": "none"}, None),
        ({"smtp_host": "smtp.example.com", "email_from_address": ""}, "EMAIL_FROM_ADDRESS"),
        ({"email_transport": "mailgun"}, "EMAIL_TRANSPORT"),
    ],
)
def test_smtp_config_problem(overrides, expected):
    problem = email_config_problem(Settings(**{**BASE, **overrides}))
    if expected is None:
        assert problem is None
    else:
        assert expected in (problem or "")
    # Names variables, never values.
    assert "smtp.example.com" not in (problem or "")


def test_transport_switch_picks_the_mailer():
    smtp = get_mailer(Settings(**BASE, smtp_host="smtp.example.com", smtp_security="ssl"))
    assert isinstance(smtp, SmtpMailer) and smtp.port == 465
    starttls = get_mailer(Settings(**BASE, smtp_host="smtp.example.com", smtp_port=2525))
    assert isinstance(starttls, SmtpMailer) and starttls.port == 2525
    sendgrid = get_mailer(Settings(**{**BASE, "email_transport": "sendgrid", "sendgrid_api_key": "SG.x"}))
    assert isinstance(sendgrid, SendGridMailer)
    assert get_mailer(Settings(**BASE)) is None
