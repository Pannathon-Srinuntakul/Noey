"""Sentry error monitoring: off without a DSN, never under pytest / fake AI,
and nothing private in what it would send.

The end-to-end test initialises the real SDK with the production options and
an in-memory transport (nothing leaves the process), raises inside a FastAPI
route carrying every kind of secret, and inspects the captured event.
"""

import json

import httpx
import pytest
import sentry_sdk
from fastapi import FastAPI, Request
from sentry_sdk.transport import Transport

from packages.core import monitoring
from packages.core.settings import Settings

DSN = "https://publickey@o0.ingest.sentry.io/1"


class MemoryTransport(Transport):
    def __init__(self, options=None) -> None:
        super().__init__(options)
        self.envelopes: list = []

    def capture_envelope(self, envelope) -> None:
        self.envelopes.append(envelope)

    def events(self) -> list[dict]:
        out = []
        for env in self.envelopes:
            for item in env.items:
                if item.type in ("event", "transaction"):
                    out.append(json.loads(item.payload.get_bytes()))
        return out


@pytest.fixture
def sentry_memory():
    transport = MemoryTransport()
    opts = monitoring.sdk_options("api", Settings(sentry_dsn=DSN, sentry_environment="test", sentry_release="rel-9"))
    sentry_sdk.init(**opts, transport=transport)
    monitoring._active = True
    try:
        yield transport
    finally:
        monitoring._active = False
        sentry_sdk.get_client().close()
        sentry_sdk.init()  # back to the inert no-DSN client


# ── when it runs ──────────────────────────────────────────────────────────────


def test_no_dsn_means_off():
    assert monitoring.monitoring_skip_reason(Settings(sentry_dsn="")) == "SENTRY_DSN is not set"
    assert monitoring.init_monitoring("api", Settings(sentry_dsn="")) is False


def test_never_under_pytest_even_with_a_dsn():
    assert "pytest" in (monitoring.monitoring_skip_reason(Settings(sentry_dsn=DSN)) or "")
    assert monitoring.init_monitoring("api", Settings(sentry_dsn=DSN)) is False
    assert not sentry_sdk.get_client().is_active()


def test_never_with_fake_ai(monkeypatch):
    import sys

    monkeypatch.delitem(sys.modules, "pytest", raising=False)
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    s = Settings(sentry_dsn=DSN, loadtest_fake_ai=True)
    assert monitoring.monitoring_skip_reason(s) == "LOADTEST_FAKE_AI is on"
    assert monitoring.monitoring_skip_reason(Settings(sentry_dsn=DSN)) is None


def test_options_are_private_by_default(monkeypatch):
    monkeypatch.setenv("RAILWAY_ENVIRONMENT_NAME", "production")
    monkeypatch.setenv("RAILWAY_GIT_COMMIT_SHA", "deadbeef")
    opts = monitoring.sdk_options("worker", Settings(sentry_dsn=DSN, sentry_traces_sample_rate=5))
    assert opts["send_default_pii"] is False
    assert opts["max_request_body_size"] == "never"
    assert opts["include_local_variables"] is False
    assert opts["environment"] == "production"
    assert opts["release"] == "deadbeef"
    assert opts["traces_sample_rate"] == 1.0  # clamped
    assert opts["server_name"] == "worker"
    explicit = monitoring.sdk_options("api", Settings(sentry_dsn=DSN, sentry_environment="staging", sentry_release="v9"))
    assert (explicit["environment"], explicit["release"]) == ("staging", "v9")


def test_environment_defaults_to_development(monkeypatch):
    monkeypatch.delenv("RAILWAY_ENVIRONMENT_NAME", raising=False)
    monkeypatch.delenv("RAILWAY_GIT_COMMIT_SHA", raising=False)
    opts = monitoring.sdk_options("api", Settings(sentry_dsn=DSN))
    assert opts["environment"] == "development" and opts["release"] is None


# ── scrubbing ─────────────────────────────────────────────────────────────────


def test_scrub_event_strips_everything_private():
    event = {
        "message": "reset for beam@example.com via https://x.test/reset-password?token=abc123&x=1 "
        "with Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
        "request": {
            "url": "https://api.test/auth/reset",
            "query_string": "token=abc123&page=2",
            "data": {"password": "hunter2"},
            "cookies": {"refresh": "r"},
            "env": {"REMOTE_ADDR": "1.2.3.4"},
            "headers": {
                "Authorization": "Bearer t",
                "Cookie": "a=b",
                "X-Forwarded-For": "1.2.3.4",
                "Stripe-Signature": "t=1,v1=x",
                "User-Agent": "k6",
            },
        },
        "user": {"id": "42", "email": "beam@example.com", "ip_address": "1.2.3.4"},
        "extra": {
            "refresh_token": "r",
            "smtp_password": "p",
            "nested": {"api_key": "k", "count": 3, "code": "123456"},
            "category": "verify_email",
        },
    }
    out = monitoring.scrub_event(event)
    assert out is not None
    blob = json.dumps(out)
    for secret in ("hunter2", "abc123", "Bearer t", "a=b", "1.2.3.4", "t=1,v1=x", "123456", "eyJhbGci", "beam@example.com"):
        assert secret not in blob, secret
    assert out["request"]["headers"] == {"User-Agent": "k6"}
    assert "page=2" in out["request"]["query_string"]
    assert out["user"] == {"id": "42"}
    assert out["extra"]["nested"]["count"] == 3
    assert out["extra"]["category"] == "verify_email"
    assert "b***@example.com" in out["message"]


# ── end to end with the real SDK ──────────────────────────────────────────────


async def test_fastapi_error_reaches_sentry_without_secrets(sentry_memory):
    app = FastAPI()

    @app.post("/boom")
    async def boom(request: Request) -> dict:
        # Built at runtime so it is not in the source context lines Sentry
        # (rightly) sends; as a local variable it must not ride along.
        password = "local-" + request.url.path.strip("/") + "-hunter"  # noqa: F841
        raise RuntimeError("kaboom")

    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:
        r = await client.post(
            "/boom?token=abc123",
            json={"password": "body-hunter2", "email": "beam@example.com"},
            headers={"Authorization": "Bearer secret-jwt", "Cookie": "noey_refresh=secret-cookie"},
        )
    assert r.status_code == 500
    sentry_sdk.flush()
    events = [e for e in sentry_memory.events() if e.get("exception")]
    assert events, "the 500 was not reported"
    event = events[0]
    blob = json.dumps(event)
    assert "kaboom" in blob
    for secret in ("body-hunter2", "beam@example.com", "secret-jwt", "secret-cookie", "abc123", "local-boom-hunter"):
        assert secret not in blob, secret
    frames = event["exception"]["values"][-1]["stacktrace"]["frames"]
    assert all("vars" not in f for f in frames)
    assert event["environment"] == "test" and event["release"] == "rel-9"


async def test_error_log_line_is_forwarded(sentry_memory):
    import structlog

    from packages.core.logging import configure_logging

    configure_logging()
    structlog.get_logger("t").error("render_failed", project="p1", smtp_password="x")
    sentry_sdk.flush()
    events = sentry_memory.events()
    forwarded = [e for e in events if e.get("message") == "render_failed"]
    assert forwarded
    assert forwarded[0]["extra"]["project"] == "p1"
    assert forwarded[0]["extra"]["smtp_password"] == monitoring.FILTERED
    info_before = len(events)
    structlog.get_logger("t").info("fine")
    sentry_sdk.flush()
    assert len(sentry_memory.events()) == info_before
