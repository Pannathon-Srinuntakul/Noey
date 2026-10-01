"""End-to-end check of the blog MCP server against a RUNNING local API.

What a claude.ai connector does, done by the official MCP SDK client over real
HTTP: discovery (401 → protected-resource metadata → authorization-server
metadata), Dynamic Client Registration, authorization code + PKCE, the admin
consent step, token exchange, then the tools — get_site_info → list_posts →
upload_image → create_post → publish_post — and finally the public read API
and the site revalidation call (received by a mock site this script runs).

The consent click is the one step a browser would do: this script signs in a
temporary admin straight through the database (local databases only) and
calls the same /admin/blog/oauth/requests/{id}/approve the consent page calls.

Start the API first (from backend/), e.g.:
    API_PUBLIC_URL=http://localhost:8010 \\
    BLOG_REVALIDATE_URL=http://127.0.0.1:3999/api/revalidate-blog \\
    BLOG_REVALIDATE_SECRET=e2e-secret S3_BUCKET= \\
    uvicorn services.api.main:app --port 8010
then:
    python scripts/blog_mcp_e2e.py --api http://localhost:8010
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import io
import json
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx
from mcp import Client
from mcp.client.auth import OAuthClientProvider
from mcp.shared.auth import (
    AuthorizationCodeResult,
    OAuthClientInformationFull,
    OAuthClientMetadata,
    OAuthToken,
)
from sqlalchemy import text

from packages.core.settings import get_settings, is_local_deployment

REVALIDATE_SECRET = "e2e-secret"
CALLBACK = "https://claude.ai/api/mcp/auth_callback"
received: list[dict] = []


class _Site(BaseHTTPRequestHandler):
    """The mock noey-frontend: records POST /api/revalidate-blog."""

    def do_POST(self) -> None:
        body = self.rfile.read(int(self.headers.get("content-length") or 0))
        received.append({"path": self.path, "auth": self.headers.get("authorization"), "body": json.loads(body or b"{}")})
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"revalidated":true}')

    def log_message(self, *_: object) -> None:
        return


class MemoryStorage:
    def __init__(self) -> None:
        self.tokens: OAuthToken | None = None
        self.client: OAuthClientInformationFull | None = None

    async def get_tokens(self) -> OAuthToken | None:
        return self.tokens

    async def set_tokens(self, tokens: OAuthToken) -> None:
        self.tokens = tokens

    async def get_client_info(self) -> OAuthClientInformationFull | None:
        return self.client

    async def set_client_info(self, client_info: OAuthClientInformationFull) -> None:
        self.client = client_info


def step(msg: str) -> None:
    print(f"  ✓ {msg}", flush=True)


async def temp_admin() -> tuple[int, str]:
    """A throwaway admin with a live admin session; returns (user id, access token)."""
    from packages.admin import auth as admin_auth
    from packages.auth.accounts import create_account
    from packages.auth.hashing import hash_password
    from packages.db.session import get_sessionmaker

    async with get_sessionmaker()() as s:
        await s.execute(text("SET search_path TO core, public"))
        user, _ = await create_account(
            s, email=f"e2e-{secrets.token_hex(4)}@blog-e2e.local", password_hash=hash_password(secrets.token_urlsafe(16)), display_name="e2e"
        )
        user.is_admin = True
        sess = await admin_auth.start_session(s, user, "127.0.0.1", "blog-mcp-e2e")
        tokens = admin_auth.issue_tokens(sess)
        await s.commit()
        return int(user.id), tokens.access_token


async def cleanup(user_id: int, slug: str, client_id: str | None) -> None:
    from packages.db.session import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("DELETE FROM core.blog_post_tags WHERE post_id IN (SELECT id FROM core.blog_posts WHERE slug = :s)"), {"s": slug})
        await conn.execute(text("DELETE FROM core.blog_posts WHERE slug = :s"), {"s": slug})
        if client_id:
            await conn.execute(text("DELETE FROM core.blog_oauth_clients WHERE client_id = :c"), {"c": client_id})
        await conn.execute(text("DELETE FROM core.admin_sessions WHERE user_id = :u"), {"u": user_id})
        tenants = (await conn.execute(text("SELECT tenant_id FROM core.memberships WHERE user_id = :u"), {"u": user_id})).scalars().all()
        await conn.execute(text("DELETE FROM core.users WHERE id = :u"), {"u": user_id})
        for t in tenants:
            slug_row = (await conn.execute(text("SELECT slug FROM core.tenants WHERE id = :t"), {"t": t})).scalar()
            await conn.execute(text("DELETE FROM core.tenants WHERE id = :t"), {"t": t})
            if slug_row:
                await conn.execute(text(f'DROP SCHEMA IF EXISTS "tenant_{slug_row}" CASCADE'))


def _png() -> str:
    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", (1920, 1080), (217, 164, 65)).save(out, format="PNG")
    return base64.b64encode(out.getvalue()).decode()


def _article() -> dict:
    sentence = "การตัดคลิปรีวิวสินค้าให้เร็วขึ้นเริ่มจากการถ่ายช็อตที่ชัดและให้ระบบทำดราฟต์แรกก่อนเกลาเอง "
    sections = "\n\n".join(f"## ขั้นที่ {i + 1}\n\n{sentence * 10}" for i in range(9))
    return {
        "title": "ตัดคลิปรีวิวสินค้าให้เร็วขึ้นด้วยดราฟต์แรก",
        "meta_title": "ตัดคลิปรีวิวสินค้าให้เร็วขึ้น | Noey Studio",
        "meta_description": "วิธีลดเวลาตัดคลิปรีวิวสินค้า ถ่ายให้ระบบคัดช็อตง่าย แล้วเกลาไทม์ไลน์ในรอบเดียว พร้อมคำถามที่พบบ่อยสำหรับครีเอเตอร์",
        "excerpt": "ลดเวลาตัดคลิปรีวิวสินค้าด้วยดราฟต์แรกจากระบบ แล้วเกลาจังหวะเองในไทม์ไลน์",
        "content_md": (
            "คำตอบสั้น ๆ คือให้ระบบทำดราฟต์แรก แล้วเกลาเองในไทม์ไลน์ ดู [ราคา](/pricing) และ [ขอบเขตงาน](/scope)\n\n" + sections
        ),
        "category": "editing-tips",
        "tags": [{"slug": "product-review", "name": "รีวิวสินค้า"}],
        "faq": [
            {"question": "ต้องใช้เวลานานไหม", "answer": "ขึ้นกับความยาวฟุตเทจ ระบบทำดราฟต์แรกให้ก่อน"},
            {"question": "ใส่ซับไทยได้ไหม", "answer": "ได้ ระบบถอดเสียงแล้ววางซับตามจังหวะพูด"},
            {"question": "แก้ต่อได้ไหม", "answer": "ได้ทุกช็อตในไทม์ไลน์ก่อนเรนเดอร์ใหม่"},
        ],
    }


async def run(api: str) -> int:
    s = get_settings()
    if not is_local_deployment(s.postgres_host):
        print("refusing: POSTGRES_HOST is not a local database", file=sys.stderr)
        return 2
    site = HTTPServer(("127.0.0.1", 3999), _Site)
    threading.Thread(target=site.serve_forever, daemon=True).start()

    user_id, admin_token = await temp_admin()
    slug = f"e2e-{int(time.time())}"
    storage = MemoryStorage()
    http = httpx.AsyncClient(base_url=api, timeout=15)
    pending: dict[str, str] = {}
    print(f"blog MCP e2e against {api}/mcp")

    try:
        # Discovery, as a client sees it before it has a token.
        r = await http.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        assert r.status_code == 401, r.status_code
        step(f"POST /mcp without a token → 401, WWW-Authenticate: {r.headers['www-authenticate']}")
        prm = (await http.get("/.well-known/oauth-protected-resource/mcp")).json()
        asm = (await http.get("/.well-known/oauth-authorization-server")).json()
        step(f"protected resource {prm['resource']} → authorization server {prm['authorization_servers'][0]}")
        step(f"AS metadata: PKCE {asm['code_challenge_methods_supported']}, registration {asm['registration_endpoint']}")

        async def redirect_handler(url: str) -> None:
            # The browser step: /authorize → admin consent → approve.
            a = await http.get(url.replace(s.api_public_url.rstrip("/"), ""), follow_redirects=False)
            assert a.status_code == 302, a.text
            consent = a.headers["location"]
            request_id = parse_qs(urlsplit(consent).query)["request"][0]
            step(f"/authorize → 302 to the admin consent page {consent.split('?')[0]}")
            info = (await http.get(f"/admin/blog/oauth/requests/{request_id}", headers={"Authorization": f"Bearer {admin_token}"})).json()
            step(f"consent shows client '{info['client_name']}' returning to {info['redirect_host']}")
            ok = await http.post(f"/admin/blog/oauth/requests/{request_id}/approve", headers={"Authorization": f"Bearer {admin_token}"})
            assert ok.status_code == 200, ok.text
            back = parse_qs(urlsplit(ok.json()["redirect_to"]).query)
            pending.update({k: v[0] for k, v in back.items()})
            step(f"admin approved → redirect to {CALLBACK} with code, state and iss={pending.get('iss')}")

        async def callback_handler() -> AuthorizationCodeResult:
            # `iss` too: the SDK client checks it against the issuer it discovered (RFC 9207).
            return AuthorizationCodeResult(code=pending["code"], state=pending.get("state"), iss=pending.get("iss"))

        auth = OAuthClientProvider(
            server_url=f"{api}/mcp",
            client_metadata=OAuthClientMetadata(
                client_name="Noey blog e2e",
                redirect_uris=[CALLBACK],  # type: ignore[list-item]
                grant_types=["authorization_code", "refresh_token"],
                response_types=["code"],
                token_endpoint_auth_method="none",
            ),
            storage=storage,
            redirect_handler=redirect_handler,
            callback_handler=callback_handler,
        )
        import httpx2
        from mcp.client.streamable_http import streamable_http_client

        mcp_http = httpx2.AsyncClient(auth=auth, timeout=30)
        async with mcp_http, Client(streamable_http_client(f"{api}/mcp", http_client=mcp_http)) as mcp:
            assert storage.client is not None and storage.tokens is not None
            step(f"DCR client {storage.client.client_id} · token scope '{storage.tokens.scope}' · expires_in {storage.tokens.expires_in}s")
            tools = sorted(t.name for t in (await mcp.list_tools()).tools)
            step(f"tools: {', '.join(tools)}")
            info = (await mcp.call_tool("get_site_info", {})).structured_content
            step(f"get_site_info: {info['product']['name']}, {len(info['guides'])} guides, {len(info['writing_rules'])} writing rules, prices {info['prices'].get('source')}")
            listed = (await mcp.call_tool("list_posts", {})).structured_content
            step(f"list_posts: {listed['total']} existing posts")
            up = await mcp.call_tool("upload_image", {"image_base64": _png(), "filename": "cover.png", "alt": "ภาพปกบทความทดสอบ"})
            assert not up.is_error, up.content
            cover = up.structured_content
            step(f"upload_image → {cover['url']} ({cover['width']}×{cover['height']} WebP)")
            created = await mcp.call_tool("create_post", {"slug": slug, **_article(), "cover_image_url": cover["url"], "cover_alt": "ภาพปก"})
            assert not created.is_error, created.content
            step(f"create_post → {created.structured_content}")
            published = await mcp.call_tool("publish_post", {"slug": slug})
            assert not published.is_error, published.content
            step(f"publish_post → {published.structured_content['outcome']} {published.structured_content['url']}")

        one = await http.get(f"/blog/posts/{slug}")
        assert one.status_code == 200, one.status_code
        body = one.json()
        step(f"GET /blog/posts/{slug} → 200 · {body['reading_minutes']} min read · category {body['category']['slug']} · Cache-Control {one.headers['cache-control']}")
        slugs = (await http.get("/blog/slugs")).json()
        assert slug in [x["slug"] for x in slugs]
        step(f"GET /blog/slugs contains {slug}")
        for _ in range(50):
            if received:
                break
            await asyncio.sleep(0.1)
        assert received, "the site was never asked to revalidate"
        hit = received[-1]
        assert hit["auth"] == f"Bearer {REVALIDATE_SECRET}" and hit["body"] == {"slugs": [slug]}, hit
        step(f"mock site got POST {hit['path']} {hit['body']} with the bearer secret")
        print("PASS")
        return 0
    finally:
        await http.aclose()
        site.shutdown()
        await cleanup(user_id, slug, storage.client.client_id if storage.client else None)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--api", default="http://localhost:8010")
    return asyncio.run(run(parser.parse_args().api.rstrip("/")))


if __name__ == "__main__":
    raise SystemExit(main())
