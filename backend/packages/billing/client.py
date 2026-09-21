"""Whether billing is configured, and the one StripeClient the API uses.

Never sets the module-level ``stripe.api_key``: every call goes through a
``StripeClient`` instance, one per process (cached per key).
"""

from functools import lru_cache

import stripe

from packages.core.settings import Settings, get_settings, is_local_deployment, is_localhost_url

#: Pinned explicitly even though stripe-python 15.6 pins the same version: an
#: SDK upgrade must not move the API version under the sync code unnoticed.
STRIPE_API_VERSION = "2026-08-26.dahlia"

_KEY_PREFIXES = ("sk_", "rk_")
_HTTP_TIMEOUT_SEC = 30
#: The SDK retries connection errors, 409s, 429s and 5xx with an idempotency
#: key it generates itself, so a retried POST cannot double-apply.
_MAX_NETWORK_RETRIES = 2


def billing_config_problem(settings: Settings | None = None) -> str | None:
    """Why billing cannot run on this server, or None when it can.

    The webhook secret is required, not optional: a subscription whose events
    cannot be verified would take the customer's money and never reach
    `users.plan`. The message names the missing variable, never a value.
    """
    s = settings or get_settings()
    key = (s.stripe_secret_key or "").strip()
    if not key:
        return "billing is not configured on this server (STRIPE_SECRET_KEY is not set)"
    if not key.startswith(_KEY_PREFIXES):
        return (
            "billing is misconfigured on this server (STRIPE_SECRET_KEY must be a "
            "restricted rk_ or secret sk_ key, never a publishable one)"
        )
    if not (s.stripe_webhook_secret or "").strip():
        return "billing is not configured on this server (STRIPE_WEBHOOK_SECRET is not set)"
    if is_localhost_url(s.site_url) and not is_local_deployment(s.postgres_host):
        # Checkout would send a paying customer back to "localhost".
        return "billing is misconfigured on this server (SITE_URL still points at localhost)"
    return None


def billing_enabled(settings: Settings | None = None) -> bool:
    return billing_config_problem(settings) is None


def is_live_mode_key(api_key: str) -> bool:
    """`sk_live_…` / `rk_live_…` — real money. Test and sandbox keys say `_test_`."""
    return "_live_" in api_key


def build_stripe_client(api_key: str, *, asynchronous: bool = True) -> stripe.StripeClient:
    """A StripeClient on the pinned API version.

    ``asynchronous`` selects the httpx transport the API's ``*_async`` calls
    need; the seed script (synchronous) passes False for the default one.
    """
    http_client = stripe.HTTPXClient(timeout=_HTTP_TIMEOUT_SEC) if asynchronous else None
    return stripe.StripeClient(
        api_key,
        stripe_version=STRIPE_API_VERSION,
        http_client=http_client,
        max_network_retries=_MAX_NETWORK_RETRIES,
    )


@lru_cache(maxsize=1)
def _client_for(api_key: str) -> stripe.StripeClient:
    return build_stripe_client(api_key)


def get_stripe_client(settings: Settings | None = None) -> stripe.StripeClient:
    """The process-wide StripeClient. Only call once `billing_config_problem()` is None."""
    s = settings or get_settings()
    return _client_for((s.stripe_secret_key or "").strip())
