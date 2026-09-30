"""One-time handoff codes: carry a signed-in session from one of our web
clients to another without a shared cookie and without a token in a URL.

The marketing/account site (www) and the web editor (app) live on different
subdomains and keep their sessions differently (HttpOnly cookies on the site,
browser storage in the editor). To open the editor already signed in, the
site's server asks the API for a code (POST /auth/handoff, as the user) and
sends the browser to `<editor>/#handoff=<code>`; the editor strips the
fragment and redeems the code (POST /auth/handoff/redeem) for an ordinary
token pair. Flow and security notes: docs/auth-handoff.md.

Properties this module guarantees:

- RANDOM: 256 bits from `secrets`, URL-safe. Nothing in the code encodes the
  user; it is only a lookup key.
- HASHED AT REST: the Redis key is sha256(code). A dump of the store is not a
  bag of redeemable codes.
- SHORT-LIVED: `TTL_SEC` (60 s) is the Redis expiry — no sweeper needed.
- SINGLE USE: `take` is GETDEL, one atomic step; two concurrent redeems of the
  same code cannot both win.
- BOUND: the record carries the user id, the `token_version` at mint time and
  the target client; the key includes the target, so an editor code cannot be
  redeemed as another target.

FAIL CLOSED like packages/auth/refresh_store.py: a store that cannot answer
raises `HandoffStoreUnavailable` and the router refuses (503). Nothing is
ever assumed.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import secrets
import time
from dataclasses import dataclass
from typing import Any, Protocol

from redis.exceptions import RedisError

from packages.core.logging import get_logger
from packages.core.settings import get_settings

log = get_logger(__name__)

PREFIX = "noey:handoff:"

#: How long a code can be redeemed. Long enough for a slow redirect + boot on
#: a phone, short enough that a code lifted from a screen or history is dead.
TTL_SEC = 60

#: The clients a code can be minted for. Only the web editor redeems today.
TARGETS: tuple[str, ...] = ("editor",)

#: A code is `secrets.token_urlsafe(32)` = 43 characters. Anything far off
#: that is refused before touching the store.
CODE_MAX_CHARS = 128


class HandoffStoreUnavailable(Exception):
    """Redis could not answer; the caller must refuse, never assume."""


@dataclass(frozen=True)
class HandoffRecord:
    user_id: int
    token_version: int


def new_code() -> str:
    return secrets.token_urlsafe(32)


def key_for(target: str, code: str) -> str:
    digest = hashlib.sha256(code.encode("utf-8")).hexdigest()
    return f"{PREFIX}{target}:{digest}"


def _encode(record: HandoffRecord) -> str:
    return json.dumps({"uid": int(record.user_id), "tv": int(record.token_version)})


def _decode(raw: Any) -> HandoffRecord | None:
    if raw is None:
        return None
    try:
        data = json.loads(raw)
        return HandoffRecord(user_id=int(data["uid"]), token_version=int(data["tv"]))
    except (ValueError, KeyError, TypeError):
        return None


class HandoffStore(Protocol):
    async def put(self, key: str, value: str, ttl_sec: int) -> None: ...

    async def take(self, key: str) -> str | None:
        """Return AND delete (atomic): a code works once."""
        ...


_redis_client: Any | None = None
_redis_loop: Any | None = None


def _redis() -> Any:
    """Per event loop, like packages/auth/refresh_store.py (same reason)."""
    global _redis_client, _redis_loop
    loop = asyncio.get_running_loop()
    if _redis_client is None or _redis_loop is not loop:
        import redis.asyncio as aioredis

        _redis_client = aioredis.from_url(
            get_settings().redis_url, socket_timeout=1.0, socket_connect_timeout=1.0
        )
        _redis_loop = loop
    return _redis_client


class RedisHandoffStore:
    def __init__(self, *, client: Any = None) -> None:
        self._client = client

    def _r(self) -> Any:
        return self._client if self._client is not None else _redis()

    async def put(self, key: str, value: str, ttl_sec: int) -> None:
        try:
            await self._r().set(key, value, ex=max(1, int(ttl_sec)))
        except (RedisError, OSError, TimeoutError) as exc:
            log.warning("handoff_store_unavailable", op="put", error=type(exc).__name__)
            raise HandoffStoreUnavailable("put") from exc

    async def take(self, key: str) -> str | None:
        try:
            raw = await self._r().getdel(key)
        except (RedisError, OSError, TimeoutError) as exc:
            log.warning("handoff_store_unavailable", op="take", error=type(exc).__name__)
            raise HandoffStoreUnavailable("take") from exc
        if raw is None:
            return None
        return raw.decode() if isinstance(raw, bytes) else str(raw)


class MemoryHandoffStore:
    """Tests only (per process)."""

    def __init__(self) -> None:
        self.records: dict[str, tuple[float, str]] = {}

    async def put(self, key: str, value: str, ttl_sec: int) -> None:
        self.records[key] = (time.monotonic() + max(1, int(ttl_sec)), value)

    async def take(self, key: str) -> str | None:
        found = self.records.pop(key, None)
        if found is None or found[0] <= time.monotonic():
            return None
        return found[1]


class DownHandoffStore:
    """Every call fails as if Redis were unreachable (tests of the closed door)."""

    async def put(self, key: str, value: str, ttl_sec: int) -> None:
        raise HandoffStoreUnavailable("put")

    async def take(self, key: str) -> str | None:
        raise HandoffStoreUnavailable("take")


_store: HandoffStore | None = None


def get_store() -> HandoffStore:
    """The process-wide store (tests swap `_store` for an in-memory one)."""
    global _store
    if _store is None:
        _store = RedisHandoffStore()
    return _store


async def mint(user_id: int, token_version: int, target: str) -> str:
    """A fresh code for `user_id`, redeemable once by `target` within TTL_SEC."""
    if target not in TARGETS:
        raise ValueError(f"unknown handoff target: {target}")
    code = new_code()
    record = HandoffRecord(user_id=int(user_id), token_version=int(token_version))
    await get_store().put(key_for(target, code), _encode(record), TTL_SEC)
    return code


async def redeem(code: str, target: str) -> HandoffRecord | None:
    """Spend a code. None when it is unknown, expired, already used, or was
    minted for another target — the caller cannot tell which, on purpose."""
    if target not in TARGETS or not code or len(code) > CODE_MAX_CHARS:
        return None
    return _decode(await get_store().take(key_for(target, code)))
