"""Single-use refresh tokens: the `jti` registry in Redis (the arq Redis, REDIS_URL).

A refresh token is only as good as the record here. Issuing one writes its
`jti`; POST /auth/refresh spends that record (one refresh per token — the
reply carries a new pair with a new `jti`); POST /auth/logout drops it early.
So a leaked refresh token stops working the moment its owner uses or drops
it, whereas before this store the token stayed valid for its whole 14 days
and every refresh handed out another one.

Keys, all under `noey:refresh:`:

- `<user_id>:<jti>`          live token, TTL = the token's remaining life
- `used:<user_id>:<jti>`     tombstone, written when the live key is spent
- `u:<user_id>`              set of the user's live jtis, for logout-all
- `legacy:<user_id>:<hash>`  a pre-rotation token (no `jti`) already spent

Reuse detection: a `jti` that is gone but has a tombstone was presented a
second time. Either the legitimate client replayed an old token after a
rotation it did not see (a lost reply), or someone stole the token and the
real owner rotated first — or the other way round. The two cannot be told
apart, so the router treats it as theft and revokes the whole family
(`token_version` bump). A `jti` with neither key is simply unknown (expired,
flushed, or never issued) and is refused without touching anything else.

FAIL CLOSED. Every method raises `RefreshStoreUnavailable` when Redis cannot
answer, and the router refuses the request (401 on refresh, 503 elsewhere).
A refresh that cannot be verified must not succeed: "the store is down"
answered with a fresh pair would make an outage the easiest way to keep a
stolen token alive. There is no breaker either — one blip must not turn into
30 s of nobody signing in.
"""

from __future__ import annotations

import asyncio
import hashlib
import time
from enum import Enum
from typing import Any, Protocol

from redis.exceptions import RedisError

from packages.core.logging import get_logger
from packages.core.settings import get_settings

log = get_logger(__name__)

PREFIX = "noey:refresh:"


class RefreshStoreUnavailable(Exception):
    """Redis could not answer; the caller must refuse, never assume."""


class Consume(Enum):
    SPENT = "spent"  # was live; now consumed — the caller may issue a new pair
    REUSED = "reused"  # already consumed earlier: the theft signal
    UNKNOWN = "unknown"  # never issued, expired, or gone — plain refusal


def live_key(user_id: int, jti: str, prefix: str = PREFIX) -> str:
    return f"{prefix}{int(user_id)}:{jti}"


def used_key(user_id: int, jti: str, prefix: str = PREFIX) -> str:
    return f"{prefix}used:{int(user_id)}:{jti}"


def user_set_key(user_id: int, prefix: str = PREFIX) -> str:
    return f"{prefix}u:{int(user_id)}"


def legacy_key(user_id: int, token: str) -> str:
    """A token without `jti` is identified by a hash of itself — the token is
    never stored (a store dump must not be a bag of usable credentials)."""
    digest = hashlib.sha256(token.encode("utf-8")).hexdigest()[:32]
    return f"{PREFIX}legacy:{int(user_id)}:{digest}"


class RefreshStore(Protocol):
    async def issue(self, user_id: int, jti: str, ttl_sec: int) -> None:
        """Record a freshly minted refresh token."""
        ...

    async def consume(self, user_id: int, jti: str, ttl_sec: int) -> Consume:
        """Spend a token. `ttl_sec` is how long the tombstone must outlive it
        (the token's remaining life — a replay after expiry fails on `exp`)."""
        ...

    async def consume_legacy(self, user_id: int, token: str, ttl_sec: int) -> bool:
        """Spend a pre-rotation token (no `jti`): True the first time only."""
        ...

    async def revoke(self, user_id: int, jti: str) -> None:
        """Forget one token (logout). No tombstone: a later use is UNKNOWN,
        not REUSED — the user chose to end this session, nobody stole it."""
        ...

    async def revoke_all(self, user_id: int) -> int:
        """Forget every live token of the user; the number dropped."""
        ...


# ── Redis ─────────────────────────────────────────────────────────────────────

#: GET/DEL/SET in ONE atomic step: two concurrent refreshes with the same
#: token cannot both win, and the tombstone exists before anyone else can
#: look for it. KEYS: live, tombstone, user set. ARGV: tombstone TTL, jti.
_CONSUME_LUA = """
local live = redis.call('GET', KEYS[1])
if live then
  redis.call('DEL', KEYS[1])
  redis.call('SET', KEYS[2], '1', 'EX', tonumber(ARGV[1]))
  redis.call('SREM', KEYS[3], ARGV[2])
  return 1
end
if redis.call('EXISTS', KEYS[2]) == 1 then
  return 2
end
return 0
"""

_client: Any | None = None
_client_loop: Any | None = None


def _redis() -> Any:
    """The process-wide client — per event loop. A `redis.asyncio` client
    binds its connections to the loop that first used it; under pytest-asyncio
    every test runs on a fresh loop (tests/conftest.py explains the same
    hazard for the DB engine), and a client from a closed loop fails with
    "attached to a different loop". Production has one loop per process, so
    the check never triggers there."""
    global _client, _client_loop
    loop = asyncio.get_running_loop()
    if _client is None or _client_loop is not loop:
        import redis.asyncio as aioredis

        # Short timeouts: a store that cannot answer fast refuses (fail closed)
        # rather than holding the login or refresh request hostage.
        _client = aioredis.from_url(
            get_settings().redis_url, socket_timeout=1.0, socket_connect_timeout=1.0
        )
        _client_loop = loop
    return _client


class RedisRefreshStore:
    """`prefix` namespaces the keys: the user refresh tokens use the default;
    another token family (the blog MCP server's grants, packages/blog/oauth.py)
    passes its own so its ids can never collide with a user id."""

    def __init__(self, *, client: Any = None, prefix: str = PREFIX) -> None:
        self._client = client
        self._prefix = prefix

    def _r(self) -> Any:
        return self._client if self._client is not None else _redis()

    async def issue(self, user_id: int, jti: str, ttl_sec: int) -> None:
        ttl = max(1, int(ttl_sec))
        try:
            async with self._r().pipeline(transaction=True) as pipe:
                pipe.set(live_key(user_id, jti, self._prefix), "1", ex=ttl)
                pipe.sadd(user_set_key(user_id, self._prefix), jti)
                # The set outlives its newest member; stale ids in it are
                # harmless (DEL of a key that is already gone).
                pipe.expire(user_set_key(user_id, self._prefix), ttl)
                await pipe.execute()
        except (RedisError, OSError, TimeoutError) as exc:
            raise _unavailable("issue", exc) from exc

    async def consume(self, user_id: int, jti: str, ttl_sec: int) -> Consume:
        try:
            outcome = await self._r().eval(
                _CONSUME_LUA,
                3,
                live_key(user_id, jti, self._prefix),
                used_key(user_id, jti, self._prefix),
                user_set_key(user_id, self._prefix),
                max(1, int(ttl_sec)),
                jti,
            )
        except (RedisError, OSError, TimeoutError) as exc:
            raise _unavailable("consume", exc) from exc
        return {1: Consume.SPENT, 2: Consume.REUSED}.get(int(outcome), Consume.UNKNOWN)

    async def consume_legacy(self, user_id: int, token: str, ttl_sec: int) -> bool:
        try:
            # SET NX: the first caller writes the key and wins; anyone after
            # sees it already there. Atomic, so a replayed pair of requests
            # cannot both be "first".
            first = await self._r().set(legacy_key(user_id, token), "1", ex=max(1, int(ttl_sec)), nx=True)
        except (RedisError, OSError, TimeoutError) as exc:
            raise _unavailable("consume_legacy", exc) from exc
        return bool(first)

    async def revoke(self, user_id: int, jti: str) -> None:
        try:
            async with self._r().pipeline(transaction=True) as pipe:
                pipe.delete(live_key(user_id, jti, self._prefix))
                pipe.srem(user_set_key(user_id, self._prefix), jti)
                await pipe.execute()
        except (RedisError, OSError, TimeoutError) as exc:
            raise _unavailable("revoke", exc) from exc

    async def revoke_all(self, user_id: int) -> int:
        try:
            members = await self._r().smembers(user_set_key(user_id, self._prefix))
            jtis = [m.decode() if isinstance(m, bytes) else str(m) for m in members]
            async with self._r().pipeline(transaction=True) as pipe:
                for jti in jtis:
                    pipe.delete(live_key(user_id, jti, self._prefix))
                pipe.delete(user_set_key(user_id, self._prefix))
                results = await pipe.execute()
        except (RedisError, OSError, TimeoutError) as exc:
            raise _unavailable("revoke_all", exc) from exc
        # Count the live keys that actually existed, not stale set members.
        return sum(int(r or 0) for r in results[: len(jtis)])


def _unavailable(op: str, exc: BaseException) -> RefreshStoreUnavailable:
    log.warning("refresh_store_unavailable", op=op, error=type(exc).__name__)
    return RefreshStoreUnavailable(op)


# ── in-memory (tests only: per process) ───────────────────────────────────────


class MemoryRefreshStore:
    def __init__(self, *, prefix: str = PREFIX) -> None:
        self._prefix = prefix
        self.live: dict[str, float] = {}  # key → expires (monotonic)
        self.used: dict[str, float] = {}
        self.legacy: dict[str, float] = {}

    def _alive(self, table: dict[str, float], key: str) -> bool:
        expires = table.get(key)
        if expires is None:
            return False
        if expires <= time.monotonic():
            del table[key]
            return False
        return True

    async def issue(self, user_id: int, jti: str, ttl_sec: int) -> None:
        self.live[live_key(user_id, jti, self._prefix)] = time.monotonic() + max(1, int(ttl_sec))

    async def consume(self, user_id: int, jti: str, ttl_sec: int) -> Consume:
        key = live_key(user_id, jti, self._prefix)
        if self._alive(self.live, key):
            del self.live[key]
            self.used[used_key(user_id, jti, self._prefix)] = time.monotonic() + max(1, int(ttl_sec))
            return Consume.SPENT
        if self._alive(self.used, used_key(user_id, jti, self._prefix)):
            return Consume.REUSED
        return Consume.UNKNOWN

    async def consume_legacy(self, user_id: int, token: str, ttl_sec: int) -> bool:
        key = legacy_key(user_id, token)
        if self._alive(self.legacy, key):
            return False
        self.legacy[key] = time.monotonic() + max(1, int(ttl_sec))
        return True

    async def revoke(self, user_id: int, jti: str) -> None:
        self.live.pop(live_key(user_id, jti, self._prefix), None)

    async def revoke_all(self, user_id: int) -> int:
        prefix = f"{self._prefix}{int(user_id)}:"
        gone = [k for k in self.live if k.startswith(prefix)]
        for k in gone:
            del self.live[k]
        return len(gone)


class DownRefreshStore:
    """Every call fails as if Redis were unreachable (tests of the closed door)."""

    async def issue(self, user_id: int, jti: str, ttl_sec: int) -> None:
        raise RefreshStoreUnavailable("issue")

    async def consume(self, user_id: int, jti: str, ttl_sec: int) -> Consume:
        raise RefreshStoreUnavailable("consume")

    async def consume_legacy(self, user_id: int, token: str, ttl_sec: int) -> bool:
        raise RefreshStoreUnavailable("consume_legacy")

    async def revoke(self, user_id: int, jti: str) -> None:
        raise RefreshStoreUnavailable("revoke")

    async def revoke_all(self, user_id: int) -> int:
        raise RefreshStoreUnavailable("revoke_all")


_store: RefreshStore | None = None


def get_store() -> RefreshStore:
    """The process-wide store (tests swap `_store` for an in-memory one)."""
    global _store
    if _store is None:
        _store = RedisRefreshStore()
    return _store
