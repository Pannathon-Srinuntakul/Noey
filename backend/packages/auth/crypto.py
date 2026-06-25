"""Fernet symmetric encryption for AI API keys stored in DB.

If ``encryption_key`` is not set in settings, returns plaintext (dev-only).
In production, set a proper 32-byte urlsafe-base64 Fernet key in env.
"""

from functools import lru_cache

from cryptography.fernet import Fernet

from packages.core.settings import get_settings


@lru_cache
def _fernet() -> Fernet | None:
    key = get_settings().encryption_key
    if not key:
        return None
    return Fernet(key.encode() if isinstance(key, str) else key)


def encrypt(value: str) -> str:
    f = _fernet()
    if f is None:
        return value  # dev fallback: plaintext
    return f.encrypt(value.encode()).decode()


def decrypt(value: str) -> str:
    f = _fernet()
    if f is None:
        return value
    return f.decrypt(value.encode()).decode()
