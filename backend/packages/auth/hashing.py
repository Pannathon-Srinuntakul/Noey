"""Password hashing — uses bcrypt directly (passlib has compat issues with bcrypt 4.x).

bcrypt is deliberately slow (~100 ms per check at the default cost). Callers
on the event loop run `hash_password` / `verify_password` through
`asyncio.to_thread`, otherwise every login stalls every other request for
that long.
"""

import secrets

import bcrypt

# bcrypt only reads the first 72 bytes of a password. bcrypt>=5 raises instead
# of ignoring the rest, which turned a long password (a Thai one passes 72 bytes
# at ~25 characters, since each Thai letter is 3 bytes in UTF-8) into a 500 on
# register and login. Truncating here is what bcrypt<5 did silently, so every
# hash stored before stays verifiable.
_BCRYPT_MAX_BYTES = 72


def _secret(plain: str) -> bytes:
    return plain.encode()[:_BCRYPT_MAX_BYTES]


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(_secret(plain), bcrypt.gensalt()).decode()


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(_secret(plain), hashed.encode())


_DUMMY_HASH: str | None = None


def dummy_hash() -> str:
    """A real bcrypt hash of a random secret nobody knows.

    Login compares against THIS when the address has no account, so an
    unknown email costs the same ~100 ms as a wrong password: without it the
    fast 401 tells an attacker which addresses are registered. Hashed once
    per process (bcrypt at the same cost as real hashes, so the timing matches)
    and never matches anything.
    """
    global _DUMMY_HASH
    if _DUMMY_HASH is None:
        _DUMMY_HASH = hash_password(secrets.token_urlsafe(16))
    return _DUMMY_HASH
