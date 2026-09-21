"""Tolerant readers over stripe-python objects.

stripe-python objects are not dicts (there is no ``.get``). These helpers read
a field that may be absent, and an expandable field that may arrive either as
an id string or as the expanded object.
"""

from typing import Any


def field(obj: Any, name: str) -> Any:
    return getattr(obj, name, None) if obj is not None else None


def id_of(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    found = field(value, "id")
    return found if isinstance(found, str) else None


def metadata_value(obj: Any, key: str) -> str | None:
    meta = field(obj, "metadata")
    if meta is None:
        return None
    try:
        value = meta[key]
    except (KeyError, TypeError):
        return None
    return str(value) if value is not None else None


def items_of(subscription: Any) -> list[Any]:
    return list(field(field(subscription, "items"), "data") or [])
