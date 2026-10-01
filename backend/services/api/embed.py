"""The embed origin (BLOG_EMBED_PUBLIC_URL, https://embed.noeystudio.com),
served by the API process through host-based routing.

A request whose Host is the embed host never reaches the API app: this
outermost ASGI layer answers it with exactly two routes and nothing else —

    GET /visual/<id>     an in-article visual (packages/blog/visual.py)
    GET /fonts/<file>    a brand font (WOFF2) the visuals load
    GET /robots.txt      keep the bare documents out of search results

Why here, not on the site: the API already owns the bucket the visuals live
in and sets no cookies of its own (it authenticates with bearer tokens), while
the site sets session cookies on its host. A separate custom domain on the
same Railway service keeps the embed origin cookieless with no new service.

Cookieless by construction: this layer never reads the `cookie` request header
(it does not look at any header but `host`), never sends `set-cookie`, and the
visual runs in a sandboxed iframe without allow-same-origin, so even its own
`document.cookie` is unreachable. Every other path on the embed host is a 404;
the API's routes are not reachable through it.
"""

from __future__ import annotations

from urllib.parse import urlsplit

from starlette.types import ASGIApp, Receive, Scope, Send

from packages.blog import kit, visual
from packages.core.settings import get_settings

_FONT_HEADERS = {
    "Content-Type": "font/woff2",
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    # A sandboxed (opaque-origin) document fetches fonts in CORS mode with
    # `Origin: null`: without this the browser refuses to use the font.
    "Access-Control-Allow-Origin": "*",
    "Cross-Origin-Resource-Policy": "cross-origin",
}
_PLAIN = {"Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff"}


def embed_host() -> str:
    return (urlsplit(get_settings().blog_embed_public_url.strip()).netloc or "").lower()


def _host(scope: Scope) -> str:
    for name, value in scope.get("headers", ()):
        if name == b"host":
            return value.decode("latin-1").strip().lower()
    return ""


async def _send(send: Send, status: int, headers: dict[str, str], body: bytes, *, head: bool) -> None:
    raw = [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in headers.items()]
    raw.append((b"content-length", str(len(body)).encode()))
    await send({"type": "http.response.start", "status": status, "headers": raw})
    await send({"type": "http.response.body", "body": b"" if head else body})


async def serve(scope: Scope, receive: Receive, send: Send) -> None:
    method = scope.get("method", "GET")
    path: str = scope.get("path", "")
    head = method == "HEAD"
    if method not in ("GET", "HEAD"):
        await _send(send, 405, {**_PLAIN, "Allow": "GET, HEAD"}, b"method not allowed", head=head)
        return
    if path.startswith("/visual/"):
        vid = path.removeprefix("/visual/")
        body = await visual.read(vid)
        if body is None:
            await _send(send, 404, {**visual.response_headers(), **_PLAIN, "Cache-Control": "public, max-age=60"}, b"not found", head=head)
            return
        await _send(send, 200, {**visual.response_headers(), "Content-Type": "text/html; charset=utf-8"}, body, head=head)
        return
    if path.startswith("/fonts/"):
        data = kit.web_font_bytes(path.removeprefix("/fonts/"))
        if data is None:
            await _send(send, 404, {**_PLAIN, "Cache-Control": "public, max-age=60"}, b"not found", head=head)
            return
        await _send(send, 200, _FONT_HEADERS, data, head=head)
        return
    if path == "/robots.txt":
        await _send(send, 200, {**_PLAIN, "Cache-Control": "public, max-age=86400"}, b"User-agent: *\nDisallow: /\n", head=head)
        return
    await _send(send, 404, {**_PLAIN, "Cache-Control": "public, max-age=60"}, b"not found", head=head)


class EmbedHostMiddleware:
    """Outermost layer: the embed host's requests stop here."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            host = embed_host()
            if host and _host(scope) == host:
                await serve(scope, receive, send)
                return
        await self.app(scope, receive, send)
