"""Tell the site to rebuild blog pages (BLOG_CONTRACT.md "Revalidation").

`POST {BLOG_REVALIDATE_URL}` with `Authorization: Bearer $BLOG_REVALIDATE_SECRET`
and `{"slugs": [...]}`. Fire-and-forget: the publish that triggered it has
already committed and never waits on, or fails because of, the site. Three
attempts with a short backoff; a final failure is logged (ISR catches up
within 10 minutes).
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence

import httpx

from packages.core.logging import get_logger
from packages.core.settings import get_settings

log = get_logger(__name__)

ATTEMPTS = 3
#: Seconds to wait before attempt 2 and 3 (tests set these to 0).
BACKOFF: tuple[float, ...] = (0.5, 2.0)
TIMEOUT_SEC = 5.0

_pending: set[asyncio.Task[bool]] = set()


async def revalidate(slugs: Sequence[str]) -> bool:
    """Call the site, retrying; True when it answered 2xx."""
    s = get_settings()
    secret = (s.blog_revalidate_secret or "").strip()
    if not secret:
        log.info("blog_revalidate_skipped", reason="BLOG_REVALIDATE_SECRET unset", slugs=list(slugs))
        return False
    url = s.blog_revalidate_target
    body = {"slugs": sorted(set(slugs))}
    for attempt in range(1, ATTEMPTS + 1):
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT_SEC) as client:
                r = await client.post(url, json=body, headers={"Authorization": f"Bearer {secret}"})
            if 200 <= r.status_code < 300:
                log.info("blog_revalidated", slugs=body["slugs"], attempt=attempt)
                return True
            log.warning("blog_revalidate_status", status=r.status_code, attempt=attempt)
        except httpx.HTTPError as exc:
            log.warning("blog_revalidate_error", error=type(exc).__name__, attempt=attempt)
        if attempt < ATTEMPTS:
            await asyncio.sleep(BACKOFF[min(attempt - 1, len(BACKOFF) - 1)])
    log.error("blog_revalidate_failed", slugs=body["slugs"], url=url)
    return False


def schedule(slugs: Sequence[str]) -> None:
    """Start `revalidate` in the background; the caller does not wait."""
    if not slugs:
        return
    task = asyncio.get_running_loop().create_task(revalidate(list(slugs)))
    _pending.add(task)
    task.add_done_callback(_pending.discard)


async def drain() -> None:
    """Wait for every scheduled call (tests, and graceful shutdown)."""
    while _pending:
        await asyncio.gather(*list(_pending), return_exceptions=True)
