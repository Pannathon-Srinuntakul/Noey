"""Plain SMTP transport — the alternative to SendGrid (EMAIL_TRANSPORT=smtp).

Same ``Mailer`` interface, same templates, same logging rules as
``packages/email/sendgrid.py``: a log line never holds a full address, a
password, a token or a message body.

Written against the standard library documentation (fetched 2026-09-30):
  https://docs.python.org/3/library/smtplib.html   (SMTP / SMTP_SSL / starttls /
      login / send_message, the SMTPException hierarchy, ssl.create_default_context)
  https://docs.python.org/3/library/email.message.html (EmailMessage,
      add_alternative) and email.policy.SMTP (CRLF line endings on the wire)

``smtplib`` is blocking, so each attempt runs in a worker thread
(``asyncio.to_thread``) under the socket timeout — the event loop never waits
on a slow relay.

Security modes:
  * ``starttls`` — connect in clear, EHLO, STARTTLS with a verifying context,
    EHLO again, then AUTH. A server that does not offer STARTTLS is a hard
    failure: silently continuing in clear would send the password in clear.
  * ``ssl`` — implicit TLS from the first byte (``SMTP_SSL``).
  * ``none`` — plain; ``client.email_config_problem`` only accepts it against
    a loopback relay (a local MTA / a test server).

Retries: connection problems and 4xx replies (temporary, RFC 5321 §4.2.1) are
retried with backoff; 5xx replies and authentication failures are final.
"""

import asyncio
import random
import smtplib
import ssl
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from email.headerregistry import Address as HeaderAddress
from email.message import EmailMessage
from email.policy import SMTP as SMTP_POLICY
from email.utils import format_datetime, make_msgid

from packages.core.logging import get_logger
from packages.email.message import (
    Address,
    EmailSendError,
    OutgoingEmail,
    email_fingerprint,
    mask_email,
    redact_emails,
)

log = get_logger(__name__)

SECURITY_MODES = ("starttls", "ssl", "none")
DEFAULT_PORTS = {"starttls": 587, "ssl": 465, "none": 25}

_ATTEMPTS = 3
_MAX_WAIT_SEC = 8.0


def _clean_name(name: str | None) -> str | None:
    """Display names go into headers: no control characters, bounded."""
    if not name:
        return None
    cleaned = "".join(" " if ord(ch) < 32 else ch for ch in name)
    cleaned = " ".join(cleaned.split())[:100]
    return cleaned or None


def _header_address(address: Address) -> HeaderAddress:
    email = address.email.strip()
    if any(ord(ch) < 32 for ch in email):
        raise EmailSendError("address contains control characters")
    return HeaderAddress(display_name=_clean_name(address.name) or "", addr_spec=email)


def build_message(sender: Address, message: OutgoingEmail) -> EmailMessage:
    """The MIME message: text/plain first, then the HTML alternative."""
    msg = EmailMessage(policy=SMTP_POLICY)
    msg["From"] = _header_address(sender)
    msg["To"] = _header_address(message.to)
    # The email package refuses a header value holding CR/LF (header
    # injection) — one line, bounded, as the SendGrid path sends it.
    msg["Subject"] = " ".join(message.content.subject.split())[:200]
    msg["Date"] = format_datetime(datetime.now(UTC))
    domain = sender.email.rpartition("@")[2] or None
    msg["Message-ID"] = make_msgid(domain=domain)
    # RFC 3834: tells auto-responders (out-of-office) not to answer.
    msg["Auto-Submitted"] = "auto-generated"
    if message.reply_to is not None:
        msg["Reply-To"] = _header_address(message.reply_to)
    msg.set_content(message.content.text, subtype="plain", charset="utf-8")
    msg.add_alternative(message.content.html, subtype="html", charset="utf-8")
    return msg


class _Temporary(Exception):
    """Worth another attempt (connection trouble, a 4xx reply)."""


def _reply_text(exc: smtplib.SMTPResponseException) -> str:
    raw = exc.smtp_error
    text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
    return redact_emails(text)[:300]


class SmtpMailer:
    """A ``Mailer`` over an SMTP relay. One instance per process (client.py)."""

    def __init__(
        self,
        *,
        host: str,
        port: int,
        security: str,
        sender: Address,
        username: str | None = None,
        password: str | None = None,
        timeout_sec: float = 15.0,
        tls_context: ssl.SSLContext | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        attempts: int = _ATTEMPTS,
    ) -> None:
        if security not in SECURITY_MODES:
            raise ValueError(f"SMTP security must be one of {SECURITY_MODES}")
        self.host = host
        self.port = port
        self.security = security
        self.sender = sender
        self._username = username or None
        self._password = password or None
        self._timeout = max(1.0, timeout_sec)
        # Verifies the certificate chain AND the host name (the stdlib's
        # recommended default). Injectable only so tests can trust their own CA.
        self._tls_context = tls_context or ssl.create_default_context()
        self._sleep = sleep
        self._attempts = max(1, attempts)

    def __repr__(self) -> str:  # never the password
        return f"SmtpMailer(host={self.host!r}, port={self.port}, security={self.security!r})"

    # -- one blocking attempt (runs in a thread) --------------------------------

    def _connect(self) -> smtplib.SMTP:
        if self.security == "ssl":
            return smtplib.SMTP_SSL(
                self.host, self.port, timeout=self._timeout, context=self._tls_context
            )
        return smtplib.SMTP(self.host, self.port, timeout=self._timeout)

    def _deliver(self, msg: EmailMessage) -> None:
        try:
            with self._connect() as smtp:
                smtp.ehlo()
                if self.security == "starttls":
                    if not smtp.has_extn("starttls"):
                        raise EmailSendError("the server does not offer STARTTLS")
                    smtp.starttls(context=self._tls_context)
                    smtp.ehlo()
                if self._username and self._password:
                    smtp.login(self._username, self._password)
                smtp.send_message(msg)
        except EmailSendError:
            raise
        except smtplib.SMTPAuthenticationError as exc:
            log.error("email_smtp_auth_failed", code=exc.smtp_code, detail=_reply_text(exc))
            raise EmailSendError("SMTP authentication failed") from None
        except smtplib.SMTPRecipientsRefused as exc:
            codes = sorted({code for code, _ in exc.recipients.values()})
            if codes and all(400 <= c < 500 for c in codes):
                raise _Temporary(f"recipient deferred {codes}") from None
            raise EmailSendError(f"recipient refused {codes}") from None
        except smtplib.SMTPResponseException as exc:
            if 400 <= exc.smtp_code < 500:
                raise _Temporary(f"SMTP {exc.smtp_code}") from None
            log.error("email_smtp_rejected", code=exc.smtp_code, detail=_reply_text(exc))
            raise EmailSendError(f"rejected with SMTP {exc.smtp_code}") from None
        except smtplib.SMTPNotSupportedError as exc:
            raise EmailSendError(f"server does not support a required feature: {exc}") from None
        except ssl.SSLCertVerificationError:
            # Not retried: a certificate that does not verify will not verify
            # in two seconds either — and this must never fall back to clear.
            raise EmailSendError("the server's TLS certificate did not verify") from None
        except (smtplib.SMTPException, OSError) as exc:
            # Connection refused / reset, DNS, timeout, server disconnected.
            raise _Temporary(type(exc).__name__) from None

    # -- Mailer -----------------------------------------------------------------

    async def send(self, message: OutgoingEmail) -> None:
        msg = build_message(self.sender, message)
        who = {
            "category": message.category,
            "to": mask_email(message.to.email),
            "to_id": email_fingerprint(message.to.email),
            "transport": "smtp",
        }
        reason = "no attempt"
        for attempt in range(1, self._attempts + 1):
            try:
                await asyncio.to_thread(self._deliver, msg)
            except _Temporary as exc:
                reason = str(exc)
            except EmailSendError as exc:
                log.error("email_rejected", reason=str(exc), **who)
                raise
            else:
                log.info("email_sent", attempt=attempt, **who)
                return
            if attempt < self._attempts:
                delay = min(0.5 * (2 ** (attempt - 1)) + random.uniform(0, 0.25), _MAX_WAIT_SEC)
                log.warning("email_send_retry", attempt=attempt, reason=reason, wait_sec=round(delay, 2), **who)
                await self._sleep(delay)
        log.error("email_send_failed", reason=reason, attempts=self._attempts, **who)
        raise EmailSendError(f"not accepted after {self._attempts} attempts ({reason})")
