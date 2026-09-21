"""Whether email is configured, and the one mailer the API uses."""

from functools import lru_cache

from packages.core.settings import Settings, get_settings, is_local_deployment, is_localhost_url
from packages.email.message import Address, Mailer
from packages.email.sendgrid import SendGridMailer


def email_config_problem(settings: Settings | None = None) -> str | None:
    """Why this server cannot send mail, or None. Names variables, never values."""
    s = settings or get_settings()
    if not (s.sendgrid_api_key or "").strip():
        return "email is not configured on this server (SENDGRID_API_KEY is not set)"
    if not (s.email_from_address or "").strip():
        return "email is not configured on this server (EMAIL_FROM_ADDRESS is not set)"
    if is_localhost_url(s.site_url) and not is_local_deployment(s.postgres_host):
        # Every link in every mail would point at "localhost".
        return "email is misconfigured on this server (SITE_URL still points at localhost)"
    return None


def contact_config_problem(settings: Settings | None = None) -> str | None:
    s = settings or get_settings()
    problem = email_config_problem(s)
    if problem:
        return problem
    if not (s.contact_to_email or "").strip():
        return "the contact form is not configured on this server (CONTACT_TO_EMAIL is not set)"
    return None


@lru_cache(maxsize=1)
def _mailer_for(api_key: str, from_address: str, from_name: str) -> SendGridMailer:
    return SendGridMailer(api_key, Address(from_address, from_name))


def get_mailer(settings: Settings | None = None) -> Mailer | None:
    """The process-wide mailer, or None while email is not configured."""
    s = settings or get_settings()
    if email_config_problem(s):
        return None
    return _mailer_for(
        (s.sendgrid_api_key or "").strip(),
        (s.email_from_address or "").strip(),
        s.email_from_name.strip() or "Noey Studio",
    )
