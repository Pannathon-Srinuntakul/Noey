"""Whether email is configured, and the one mailer the API uses."""

from functools import lru_cache

from packages.core.settings import (
    Settings,
    get_settings,
    is_local_deployment,
    is_localhost_url,
    is_loopback_host,
)
from packages.email.message import Address, Mailer
from packages.email.sendgrid import SendGridMailer
from packages.email.smtp import DEFAULT_PORTS, SECURITY_MODES, SmtpMailer

TRANSPORTS = ("sendgrid", "smtp")


def _transport(s: Settings) -> str:
    return (s.email_transport or "").strip().lower() or "sendgrid"


def _smtp_problem(s: Settings) -> str | None:
    if not (s.smtp_host or "").strip():
        return "email is not configured on this server (SMTP_HOST is not set)"
    security = (s.smtp_security or "").strip().lower()
    if security not in SECURITY_MODES:
        return "email is misconfigured on this server (SMTP_SECURITY must be starttls, ssl or none)"
    user = bool((s.smtp_username or "").strip())
    password = bool(s.smtp_password)
    if user != password:
        missing = "SMTP_PASSWORD" if user else "SMTP_USERNAME"
        return f"email is not configured on this server ({missing} is not set)"
    if security == "none" and not is_loopback_host(s.smtp_host):
        # A password and every reset link would cross the network in clear.
        return "email is misconfigured on this server (SMTP_SECURITY=none is only allowed for a local relay)"
    return None


def email_config_problem(settings: Settings | None = None) -> str | None:
    """Why this server cannot send mail, or None. Names variables, never values."""
    s = settings or get_settings()
    transport = _transport(s)
    if transport not in TRANSPORTS:
        return "email is misconfigured on this server (EMAIL_TRANSPORT must be sendgrid or smtp)"
    if transport == "smtp":
        problem = _smtp_problem(s)
        if problem:
            return problem
    elif not (s.sendgrid_api_key or "").strip():
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


@lru_cache(maxsize=1)
def _smtp_mailer_for(
    host: str,
    port: int,
    security: str,
    username: str | None,
    password: str | None,
    timeout_sec: float,
    from_address: str,
    from_name: str,
) -> SmtpMailer:
    return SmtpMailer(
        host=host,
        port=port,
        security=security,
        sender=Address(from_address, from_name),
        username=username,
        password=password,
        timeout_sec=timeout_sec,
    )


def get_mailer(settings: Settings | None = None) -> Mailer | None:
    """The process-wide mailer, or None while email is not configured."""
    s = settings or get_settings()
    if email_config_problem(s):
        return None
    if _transport(s) == "smtp":
        security = s.smtp_security.strip().lower()
        return _smtp_mailer_for(
            (s.smtp_host or "").strip(),
            s.smtp_port or DEFAULT_PORTS[security],
            security,
            (s.smtp_username or "").strip() or None,
            s.smtp_password or None,
            s.smtp_timeout_sec,
            (s.email_from_address or "").strip(),
            s.email_from_name.strip() or "Noey Studio",
        )
    return _mailer_for(
        (s.sendgrid_api_key or "").strip(),
        (s.email_from_address or "").strip(),
        s.email_from_name.strip() or "Noey Studio",
    )
