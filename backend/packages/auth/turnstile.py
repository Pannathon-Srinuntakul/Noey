"""Cloudflare Turnstile server-side verification (Siteverify).

Tokens are single-use and expire after 300 s, so each registration attempt
needs a fresh one from the widget. Verification fails CLOSED: an unreachable
Siteverify is treated like a bad token, because the check exists to keep bots
out and "could not check" must not mean "let everyone in".
"""

import httpx

from packages.core.logging import get_logger

log = get_logger(__name__)

SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
#: Siteverify rejects longer tokens; checking first saves the round trip.
TOKEN_MAX_CHARS = 2048
_TIMEOUT_SEC = 10.0


async def verify_turnstile(token: str, secret: str) -> bool:
    """True only when Cloudflare confirms the token."""
    if not token or len(token) > TOKEN_MAX_CHARS:
        return False
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_SEC) as client:
            resp = await client.post(SITEVERIFY_URL, data={"secret": secret, "response": token})
        body = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("turnstile_unreachable", error=type(exc).__name__)
        return False
    if body.get("success") is True:
        return True
    log.info("turnstile_rejected", error_codes=body.get("error-codes"))
    return False
