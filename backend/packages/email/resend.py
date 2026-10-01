"""Resend's HTTP API over plain httpx (EMAIL_TRANSPORT=resend).

POST https://api.resend.com/emails — 200 means Resend took the message.
429 and 5xx (and connection failures) are retried with backoff, honouring
`Retry-After`; every other status is final (400/422 bad request, 401/403 bad
key or unverified domain).

Why it exists: on Railway, `smtp.resend.com:587` timed out on every send
(2026-10-02 — admin sign-in codes never left; Railway does not open outbound
SMTP for this plan). The same Resend account answers over HTTPS, and its SMTP
password is an API key, so the switch needs no new credential.

Logs never contain a full address, a token or a body.
"""

import asyncio
import random
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
from packages.email.sendgrid import _clean_name, _wait_hint

log = get_logger(__name__)

RESEND_API_BASE = "https://api.resend.com"
SEND_PATH = "/emails"

_ATTEMPTS = 3
_TIMEOUT_SEC = 10.0
_MAX_WAIT_SEC = 8.0
_RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
_FINAL_HINTS = {
    401: "the API key is missing or wrong",
    403: "the API key may not send, or the From domain is not verified",
    422: "the message was refused (check the From domain and fields)",
}


def _format(address: Address) -> str:
    name = _clean_name(address.name)
    return f"{name} <{address.email}>" if name else address.email


def build_payload(sender: Address, message: OutgoingEmail) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "from": _format(sender),
        "to": [message.to.email],
        "subject": message.content.subject,
        "text": message.content.text,
        "html": message.content.html,
        # Tag values allow only ASCII letters, digits, _ and -.
        "tags": [{"name": "category", "value": message.category}],
    }
    if message.reply_to is not None:
        payload["reply_to"] = _format(message.reply_to)
    return payload


def _error_text(response: httpx.Response) -> str:
    try:
        body = response.json()
        text = str(body.get("message") or body)
    except (ValueError, AttributeError):
        text = response.text
    return redact_emails(text)[:300]


class ResendMailer:
    """The ``Mailer`` for EMAIL_TRANSPORT=resend. One instance per process."""

    def __init__(
        self,
        api_key: str,
        sender: Address,
        *,
        base_url: str = RESEND_API_BASE,
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
            "transport": "resend",
        }
        reason = "no attempt"
        for attempt in range(1, self._attempts + 1):
            wait: float | None = None
            try:
                async with httpx.AsyncClient(
                    base_url=self._base_url, transport=self._transport, timeout=_TIMEOUT_SEC
                ) as client:
                    response = await client.post(
                        SEND_PATH,
                        json=payload,
                        headers={"Authorization": f"Bearer {self._api_key}"},
                    )
            except httpx.TransportError as exc:
                reason = type(exc).__name__
            else:
                if response.status_code == 200:
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
