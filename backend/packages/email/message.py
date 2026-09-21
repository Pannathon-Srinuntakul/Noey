"""What an outgoing email is, plus the helpers that keep addresses out of logs."""

import hashlib
import re
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class Address:
    email: str
    name: str | None = None


@dataclass(frozen=True)
class RenderedEmail:
    subject: str
    text: str
    html: str


@dataclass(frozen=True)
class OutgoingEmail:
    to: Address
    content: RenderedEmail
    #: Short machine name ("verify_email", "contact", …) — the SendGrid
    #: category and the log field. Never user data.
    category: str
    reply_to: Address | None = None


class EmailSendError(Exception):
    """The provider did not accept the message (after any retries)."""


class Mailer(Protocol):
    async def send(self, message: OutgoingEmail) -> None:
        """Deliver or raise ``EmailSendError``."""
        ...


def mask_email(address: str) -> str:
    """``beam@example.com`` → ``b***@example.com`` — for logs."""
    local, sep, domain = address.strip().partition("@")
    if not sep:
        return "***"
    return f"{local[:1]}***@{domain.lower()}"


def email_fingerprint(address: str) -> str:
    """A stable, non-reversible id for correlating log lines about one address."""
    return hashlib.sha256(address.strip().lower().encode("utf-8")).hexdigest()[:12]


_EMAIL_IN_TEXT = re.compile(r"[\w.+-]+@[\w-]+(\.[\w-]+)+")


def redact_emails(text: str) -> str:
    """Mask every address inside free text (provider error messages)."""
    return _EMAIL_IN_TEXT.sub(lambda m: mask_email(m.group(0)), text)
