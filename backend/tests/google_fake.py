"""A fake Google for Sign in with Google tests: the token endpoint and the
JWKS endpoint behind an ``httpx.MockTransport``, and ID tokens signed with a
throwaway RSA key. Nothing reaches the network.

The fake checks what the real endpoint would: client id + secret, the
redirect_uri, grant_type, and the PKCE verifier against the challenge sent
in the authorization URL.
"""

from __future__ import annotations

import base64
import hashlib
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

from packages.auth import google_oauth

CLIENT_ID = "test-client.apps.googleusercontent.com"
CLIENT_SECRET = "test-secret"
REDIRECT = "https://app.example.com/auth/google/callback"
REDIRECT_SITE = "https://site.example.com/auth/google/callback"


def _b64(n: int) -> str:
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


@dataclass
class Pending:
    challenge: str
    nonce: str
    redirect_uri: str
    claims: dict[str, Any]


@dataclass
class FakeGoogle:
    kid: str = "kid-1"
    key: Any = field(default_factory=lambda: rsa.generate_private_key(public_exponent=65537, key_size=2048))
    #: code → what the "user" consented to.
    pending: dict[str, Pending] = field(default_factory=dict)
    token_calls: int = 0
    jwks_calls: int = 0
    #: Overrides applied to the next ID token (e.g. {"aud": "someone-else"}).
    tamper: dict[str, Any] = field(default_factory=dict)
    sign_with: Any = None

    def jwks(self) -> dict[str, Any]:
        pub = self.key.public_key().public_numbers()
        return {"keys": [{"kty": "RSA", "alg": "RS256", "use": "sig", "kid": self.kid,
                          "n": _b64(pub.n), "e": _b64(pub.e)}]}

    def consent(self, authorization_url: str, **claims: Any) -> str:
        """The person picks their Google account; returns the `code` Google
        would put on the redirect. Claims default to a verified Gmail user."""
        q = {k: v[0] for k, v in parse_qs(urlparse(authorization_url).query).items()}
        assert q["client_id"] == CLIENT_ID
        assert q["response_type"] == "code"
        assert q["code_challenge_method"] == "S256"
        assert q["scope"].split()[0] == "openid"
        code = uuid.uuid4().hex
        base = {
            "sub": claims.pop("sub", "1" + uuid.uuid4().hex[:20]),
            "email": claims.pop("email", f"g-{uuid.uuid4().hex[:8]}@gmail.example.com"),
            "email_verified": claims.pop("email_verified", True),
            "name": claims.pop("name", "Google Person"),
        }
        base.update(claims)
        self.pending[code] = Pending(q["code_challenge"], q["nonce"], q["redirect_uri"], base)
        return code

    def _id_token(self, p: Pending) -> str:
        now = int(time.time())
        payload = {"iss": "https://accounts.google.com", "aud": CLIENT_ID, "iat": now,
                   "exp": now + 3600, "nonce": p.nonce, **p.claims}
        payload.update(self.tamper)
        payload = {k: v for k, v in payload.items() if v is not None}
        return jwt.encode(payload, self.sign_with or self.key, algorithm="RS256", headers={"kid": self.kid})

    def handler(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == google_oauth.JWKS_URI:
            self.jwks_calls += 1
            return httpx.Response(200, json=self.jwks(), headers={"cache-control": "public, max-age=100"})
        if url == google_oauth.TOKEN_ENDPOINT:
            self.token_calls += 1
            form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            p = self.pending.pop(form.get("code", ""), None)
            if p is None:
                return httpx.Response(400, json={"error": "invalid_grant"})
            verifier = form.get("code_verifier", "")
            challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
            if (
                form.get("client_id") != CLIENT_ID
                or form.get("client_secret") != CLIENT_SECRET
                or form.get("grant_type") != "authorization_code"
                or form.get("redirect_uri") != p.redirect_uri
                or challenge != p.challenge
            ):
                return httpx.Response(400, json={"error": "invalid_grant"})
            return httpx.Response(200, json={"access_token": "ya29.x", "expires_in": 3599,
                                             "id_token": self._id_token(p), "token_type": "Bearer"})
        return httpx.Response(404, content=json.dumps({"error": "not found"}))


def install(monkeypatch, *, turnstile: str = "") -> FakeGoogle:  # type: ignore[no-untyped-def]
    """Configure Google for the app and route its HTTP calls to a fresh fake."""
    from packages.core.settings import get_settings

    fake = FakeGoogle()
    monkeypatch.setenv("GOOGLE_CLIENT_ID", CLIENT_ID)
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", CLIENT_SECRET)
    monkeypatch.setenv("GOOGLE_REDIRECT_URIS", f"{REDIRECT}, {REDIRECT_SITE}")
    monkeypatch.setenv("TURNSTILE_SECRET_KEY", turnstile)
    monkeypatch.setattr(google_oauth, "_transport", httpx.MockTransport(fake.handler))
    monkeypatch.setattr(google_oauth, "_store", google_oauth.MemoryFlowStore())
    google_oauth.reset_jwks_cache()
    get_settings.cache_clear()
    return fake
