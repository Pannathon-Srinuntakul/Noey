"""SendGrid Mail Send v3 over plain httpx.

POST https://api.sendgrid.com/v3/mail/send — 202 Accepted means SendGrid took
the message. 429 and 5xx (and connection failures) are retried with backoff,
honouring `Retry-After` / `X-RateLimit-Reset`; every other status is final:
400 bad request, 401 bad key, 403 sender identity not verified (or the account
is blocked), 413 too large.

Logs never contain a full address, a token or a body: the recipient is masked
and the provider's error text is redacted.
"""

import asyncio
import random
import time
from collections.abc import Awaitable, Callable
from typing import Any

import httpx

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

SENDGRID_API_BASE = "https://api.sendgrid.com"
MAIL_SEND_PATH = "/v3/mail/send"

#: Per message, whatever the account defaults are. Click tracking rewrites
#: every link through a tracking domain and Google Analytics tracking appends
#: utm parameters — neither may touch a one-time security link. The open
#: pixel and the unsubscribe footer have no place in transactional mail.
TRACKING_OFF: dict[str, dict[str, bool]] = {
    "click_tracking": {"enable": False, "enable_text": False},
    "open_tracking": {"enable": False},
    "subscription_tracking": {"enable": False},
    "ganalytics": {"enable": False},
}

_ATTEMPTS = 3
_TIMEOUT_SEC = 10.0
_MAX_WAIT_SEC = 8.0
_RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
_FINAL_HINTS = {
    401: "the API key is wrong or revoked",
    403: "the From address is not an authenticated domain / verified sender, or the account is blocked",
    413: "the message is too large",
}


def _clean_name(name: str | None) -> str | None:
    """Display names go into headers: no control characters, no , or ;."""
    if not name:
        return None
    cleaned = "".join(" " if (ch in ",;" or ord(ch) < 32) else ch for ch in name)
    cleaned = " ".join(cleaned.split())[:100]
    return cleaned or None


def _address(address: Address) -> dict[str, str]:
    out = {"email": address.email}
    name = _clean_name(address.name)
    if name:
        out["name"] = name
    return out


def build_payload(sender: Address, message: OutgoingEmail) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "personalizations": [{"to": [_address(message.to)]}],
        "from": _address(sender),
        "subject": message.content.subject,
        # text/plain first, then text/html.
        "content": [
            {"type": "text/plain", "value": message.content.text},
            {"type": "text/html", "value": message.content.html},
        ],
        "categories": ["noey-transactional", message.category],
        "tracking_settings": TRACKING_OFF,
    }
    if message.reply_to is not None:
        payload["reply_to"] = _address(message.reply_to)
    return payload


def _wait_hint(response: httpx.Response) -> float | None:
    retry_after = response.headers.get("retry-after")
    if retry_after:
        try:
            return max(float(retry_after), 0.0)
        except ValueError:
            pass
    reset = response.headers.get("x-ratelimit-reset")
    if reset:
        try:
            return max(float(reset) - time.time(), 0.0)
        except ValueError:
            pass
    return None


def _error_text(response: httpx.Response) -> str:
    try:
        errors = response.json().get("errors") or []
        text = "; ".join(str(e.get("message", "")) for e in errors if isinstance(e, dict))
    except (ValueError, AttributeError):
        text = response.text
    return redact_emails(text)[:300]


class SendGridMailer:
    """The production ``Mailer``. One instance per process (packages/email/client.py)."""

    def __init__(
        self,
        api_key: str,
        sender: Address,
        *,
        base_url: str = SENDGRID_API_BASE,
        transport: httpx.AsyncBaseTransport | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        attempts: int = _ATTEMPTS,
    ) -> None:
        self._api_key = api_key
        self.sender = sender
        self._base_url = base_url
        self._transport = transport
        self._sleep = sleep
        self._attempts = max(1, attempts)

    async def send(self, message: OutgoingEmail) -> None:
        payload = build_payload(self.sender, message)
        who = {
            "category": message.category,
            "to": mask_email(message.to.email),
            "to_id": email_fingerprint(message.to.email),
        }
        reason = "no attempt"
        for attempt in range(1, self._attempts + 1):
            wait: float | None = None
            try:
                async with httpx.AsyncClient(
                    base_url=self._base_url, transport=self._transport, timeout=_TIMEOUT_SEC
                ) as client:
                    response = await client.post(
                        MAIL_SEND_PATH,
                        json=payload,
                        headers={"Authorization": f"Bearer {self._api_key}"},
                    )
            except httpx.TransportError as exc:
                reason = type(exc).__name__
            else:
                if response.status_code == 202:
                    log.info("email_sent", attempt=attempt, **who)
                    return
                if response.status_code not in _RETRY_STATUSES:
                    log.error(
                        "email_rejected",
                        status=response.status_code,
                        hint=_FINAL_HINTS.get(response.status_code),
                        detail=_error_text(response),
                        **who,
                    )
                    raise EmailSendError(f"rejected with HTTP {response.status_code}")
                reason = f"HTTP {response.status_code}"
                wait = _wait_hint(response)
            if attempt < self._attempts:
                backoff = 0.5 * (2 ** (attempt - 1)) + random.uniform(0, 0.25)
                delay = min(wait if wait is not None else backoff, _MAX_WAIT_SEC)
                log.warning("email_send_retry", attempt=attempt, reason=reason, wait_sec=round(delay, 2), **who)
                await self._sleep(delay)
        log.error("email_send_failed", reason=reason, attempts=self._attempts, **who)
        raise EmailSendError(f"not accepted after {self._attempts} attempts ({reason})")
