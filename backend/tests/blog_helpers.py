"""Shared pieces for the blog / MCP tests: an OAuth client that walks the real
flow (DCR → /authorize → admin consent → /token with PKCE), and an MCP SDK
client talking to the app in-process.

Rows written here are removed by `purge_blog()` (posts by slug prefix, the
OAuth clients these tests registered, their audit rows).
"""

from __future__ import annotations

import base64
import hashlib
import secrets
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import httpx2
from mcp import Client
from mcp.client.streamable_http import streamable_http_client

from services.api.main import app
from services.mcp import server as mcp_server
from tests.admin_helpers import db

CALLBACK = "https://claude.ai/api/mcp/auth_callback"
PREFIX = "t-blog-"
RESOURCE = "http://localhost:8000/mcp"


SENTENCE = "การตัดคลิปสั้นให้น่าดูต้องเริ่มจากการเลือกช็อตที่ชัดเจนและเล่าเรื่องให้จบในตัวเอง "


def article(n: int = 90) -> str:
    body = SENTENCE * 10
    parts = ["คำตอบสั้น ๆ คือเริ่มจากช็อตที่ชัด แล้วค่อยเกลาจังหวะในไทม์ไลน์ ดู [ราคา](/pricing) และ [ขอบเขต](/scope)"]
    for i in range(n // 10):
        parts.append(f"## หัวข้อที่ {i + 1}\n\n{body}")
    return "\n\n".join(parts)


FAQ = [
    {"question": "ต้องใช้เวลานานไหม", "answer": "ขึ้นกับความยาวฟุตเทจ ระบบทำดราฟต์แรกให้ก่อน"},
    {"question": "ใส่ซับไทยได้ไหม", "answer": "ได้ ระบบถอดเสียงแล้ววางซับตามจังหวะพูด"},
    {"question": "แก้ต่อได้ไหม", "answer": "ได้ทุกช็อตในไทม์ไลน์ก่อนเรนเดอร์ใหม่"},
]


def post_args(slug: str, **over: object) -> dict[str, object]:
    args: dict[str, object] = {
        "slug": slug,
        "title": "ตัดคลิปรีวิวสินค้าให้เร็วขึ้นด้วยดราฟต์แรกจาก AI",
        "meta_title": "ตัดคลิปรีวิวสินค้าให้เร็วขึ้น | Noey Studio",
        "meta_description": "วิธีลดเวลาตัดคลิปรีวิวสินค้า เริ่มจากถ่ายให้ระบบคัดช็อตได้ง่าย แล้วเกลาไทม์ไลน์ในรอบเดียว พร้อมคำถามที่พบบ่อย",
        "excerpt": "ลดเวลาตัดคลิปรีวิวสินค้าด้วยดราฟต์แรกจากระบบ แล้วเกลาจังหวะเองในไทม์ไลน์",
        "content_md": article(),
        "category": "editing-tips",
        "faq": FAQ,
        "tags": [{"slug": f"{PREFIX}review", "name": "รีวิว"}],
    }
    args.update(over)
    return args


async def seed_media(actor: str, *, animated: int = 0, visuals: int = 2) -> dict[str, object]:
    """A cover (origin render_cover) and `visuals` HTML visuals made by
    `actor`, as rows only — what create_post's picture rules look up. Returns
    the create_post fields that use them (cover + content_md with the visuals)."""
    import secrets as _s

    from packages.blog import media

    base = media.media_base()
    cover_url = f"{base}/{_s.token_hex(32)}.webp"
    await db(
        "INSERT INTO core.blog_images (url, key, mime, bytes, width, height, alt, uploaded_by, kind, origin) "
        "VALUES (:u, :k, 'image/webp', 1000, 1600, 900, 'ภาพปก', 'test-seed', 'image', 'render_cover')",
        u=cover_url, k=f"blog/{cover_url.rsplit('/', 1)[1]}",
    )
    lines = []
    for i in range(visuals):
        vid = _s.token_hex(16)
        await db(
            "INSERT INTO core.blog_visuals (id, key, width, height, alt, animated, bytes, created_by) "
            "VALUES (:i, :k, 1600, 1000, 'แผนภาพ', :a, 1000, :c)",
            i=vid, k=f"visual/{vid}.html", a=i < animated, c=actor,
        )
        lines.append(f"::visual[แผนภาพขั้นตอนที่ {i + 1}]({vid})")
    return {
        "cover_image_url": cover_url,
        "cover_alt": "ภาพปกบทความ",
        "content_md": article() + "\n\n## ภาพประกอบ\n\n" + "\n\n".join(lines) + "\n",
    }


async def full_post_args(slug: str, actor: str, **over: object) -> dict[str, object]:
    """post_args plus a cover and two visuals of `actor` — passes every rule."""
    return post_args(slug, **{**(await seed_media(actor)), **over})


def pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    return verifier, challenge


async def register(c: httpx.AsyncClient, *, redirect: str = CALLBACK, public: bool = True) -> dict[str, Any]:
    body: dict[str, Any] = {
        "client_name": "pytest connector",
        "redirect_uris": [redirect],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
    }
    if public:
        body["token_endpoint_auth_method"] = "none"
    r = await c.post("/mcp/oauth/register", json=body)
    assert r.status_code == 201, r.text
    return r.json()


async def authorize(c: httpx.AsyncClient, client_id: str, challenge: str, *, resource: str | None = RESOURCE,
                    state: str = "st-1") -> str:
    """GET /authorize → the admin consent URL's request id."""
    params = {
        "response_type": "code", "client_id": client_id, "redirect_uri": CALLBACK,
        "code_challenge": challenge, "code_challenge_method": "S256", "state": state, "scope": "blog:write",
    }
    if resource is not None:
        params["resource"] = resource
    r = await c.get("/mcp/oauth/authorize", params=params)
    assert r.status_code == 302, r.text
    loc = r.headers["location"]
    assert loc.startswith("http://localhost:3001/connect?request="), loc
    return parse_qs(urlsplit(loc).query)["request"][0]


async def approve(c: httpx.AsyncClient, admin_token: str, request_id: str) -> dict[str, str]:
    r = await c.post(f"/admin/blog/oauth/requests/{request_id}/approve", headers={"Authorization": f"Bearer {admin_token}"})
    assert r.status_code == 200, r.text
    q = parse_qs(urlsplit(r.json()["redirect_to"]).query)
    return {k: v[0] for k, v in q.items()}


async def exchange(c: httpx.AsyncClient, client_id: str, code: str, verifier: str) -> httpx.Response:
    return await c.post(
        "/mcp/oauth/token",
        data={
            "grant_type": "authorization_code", "code": code, "redirect_uri": CALLBACK,
            "client_id": client_id, "code_verifier": verifier, "resource": RESOURCE,
        },
    )


async def refresh(c: httpx.AsyncClient, client_id: str, token: str) -> httpx.Response:
    return await c.post(
        "/mcp/oauth/token",
        data={"grant_type": "refresh_token", "refresh_token": token, "client_id": client_id, "resource": RESOURCE},
    )


async def connect(c: httpx.AsyncClient, admin_token: str) -> dict[str, Any]:
    """The whole flow; returns the token response plus client_id."""
    client = await register(c)
    verifier, challenge = pkce()
    request_id = await authorize(c, client["client_id"], challenge)
    back = await approve(c, admin_token, request_id)
    assert back["state"] == "st-1" and back["iss"] == "http://localhost:8000"
    r = await exchange(c, client["client_id"], back["code"], verifier)
    assert r.status_code == 200, r.text
    return {**r.json(), "client_id": client["client_id"]}


@asynccontextmanager
async def mcp_client(access_token: str):  # type: ignore[no-untyped-def]
    """An MCP SDK client over Streamable HTTP, served in-process by the app."""
    async with mcp_server.run():
        http = httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=app),
            base_url="http://localhost:8000",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        async with http, Client(streamable_http_client("http://localhost:8000/mcp", http_client=http)) as client:
            yield client


async def purge_blog() -> None:
    await db("DELETE FROM core.blog_post_tags WHERE post_id IN (SELECT id FROM core.blog_posts WHERE slug LIKE :p)", p=f"{PREFIX}%")
    await db("DELETE FROM core.blog_posts WHERE slug LIKE :p", p=f"{PREFIX}%")
    await db("DELETE FROM core.blog_tags WHERE slug LIKE :p", p=f"{PREFIX}%")
    await db("DELETE FROM core.blog_oauth_clients WHERE client_name LIKE 'pytest%'")
    await db("DELETE FROM core.blog_audit_log WHERE slug LIKE :p OR actor LIKE 'admin:%' OR actor LIKE 'mcp:%' OR actor = 'oauth'", p=f"{PREFIX}%")
    await db("DELETE FROM core.blog_images WHERE uploaded_by LIKE 'mcp:%' OR uploaded_by LIKE 'test%'")
    await db("DELETE FROM core.blog_visuals WHERE created_by LIKE 'mcp:%' OR created_by LIKE 'test%'")
    await db("DELETE FROM core.blog_content_plan WHERE topic LIKE 't-blog-%'")
    await db("DELETE FROM core.blog_brief")
    await db("DELETE FROM core.admin_settings WHERE key = 'blog_config'")
