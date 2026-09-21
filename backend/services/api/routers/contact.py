"""Public contact form → the owner's inbox (CONTACT_TO_EMAIL), Reply-To the visitor.

`company` is a honeypot: the form hides it from people, bots fill it in. A
filled honeypot gets the same 202 as a real message and nothing is sent — so
the bot learns nothing.
"""

from typing import Annotated

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import AfterValidator, BaseModel, EmailStr, Field

from packages.auth.accounts import normalize_email
from packages.auth.turnstile import TOKEN_MAX_CHARS, verify_turnstile
from packages.core.logging import get_logger
from packages.core.settings import get_settings
from packages.email import templates
from packages.email.client import contact_config_problem
from packages.email.message import Address, EmailSendError, OutgoingEmail, email_fingerprint
from services.api import ratelimit
from services.api.deps import OptionalMailerDep

log = get_logger(__name__)

router = APIRouter(tags=["contact"])


def _trimmed(min_len: int, max_len: int) -> AfterValidator:
    """Length bounds counted AFTER trimming whitespace (422 otherwise)."""

    def check(value: str) -> str:
        value = value.strip()
        if len(value) < min_len:
            raise ValueError(f"must be at least {min_len} characters")
        if len(value) > max_len:
            raise ValueError(f"must be at most {max_len} characters")
        return value

    return AfterValidator(check)


class ContactIn(BaseModel):
    name: Annotated[str, _trimmed(1, 100)]
    email: EmailStr
    message: Annotated[str, _trimmed(10, 4000)]
    turnstile_token: Annotated[str | None, Field(default=None, max_length=TOKEN_MAX_CHARS)] = None
    #: Honeypot — must stay empty. Optional so a form that omits it still works.
    company: Annotated[str | None, Field(default=None, max_length=500)] = None


class EmptyOut(BaseModel):
    """`{}`"""


@router.post("/contact", status_code=status.HTTP_202_ACCEPTED, response_model=EmptyOut)
async def contact(body: ContactIn, request: Request, mailer: OptionalMailerDep) -> EmptyOut:
    """Deliver a visitor's message to the owner. 202 `{}`; 422 invalid body,
    400 captcha failed (when Turnstile is configured), 429 throttled, 503 not
    configured or not sent."""
    if body.company and body.company.strip():
        log.info("contact_honeypot", email_id=email_fingerprint(str(body.email)))
        return EmptyOut()

    problem = contact_config_problem()
    if problem or mailer is None:
        raise HTTPException(status_code=503, detail=problem or "email is not configured on this server")

    visitor = normalize_email(str(body.email))
    await ratelimit.enforce([
        (ratelimit.CONTACT_EMAIL, visitor),
        (ratelimit.CONTACT_IP, ratelimit.client_ip(request)),
    ])
    secret = (get_settings().turnstile_secret_key or "").strip()
    if secret and not (body.turnstile_token and await verify_turnstile(body.turnstile_token, secret)):
        raise HTTPException(status_code=400, detail="captcha verification failed")

    settings = get_settings()
    brand = settings.email_from_name.strip() or "Noey Studio"
    message = OutgoingEmail(
        to=Address((settings.contact_to_email or "").strip(), brand),
        content=templates.contact_message(
            brand=brand, name=body.name, email=visitor, message=body.message
        ),
        category="contact",
        reply_to=Address(visitor, body.name),
    )
    try:
        await mailer.send(message)
    except EmailSendError:
        raise HTTPException(
            status_code=503, detail="the message could not be sent right now — please try again later"
        ) from None
    log.info("contact_sent", email_id=email_fingerprint(visitor))
    return EmptyOut()
