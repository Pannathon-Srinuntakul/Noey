# ruff: noqa: F811  (pytest fixtures imported from tests/admin_helpers.py are parameters here)
"""The blog MCP server end to end, in-process: OAuth 2.1 (discovery, DCR,
PKCE, consent by an admin only, audience, refresh rotation + reuse), the tool
surface (no delete) and the publish → public API → revalidation chain."""

from __future__ import annotations

import base64
import io
import json
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from PIL import Image

from packages.auth.tokens import encode_access
from packages.blog import oauth, revalidate
from packages.core.settings import get_settings
from services.mcp import server as mcp_server
from tests import blog_helpers as bh
from tests.admin_helpers import (  # noqa: F401  (fixtures)
    _admin_env,
    bearer,
    client,
    db,
    email,
    mail,
    make_user,
    new_admin,
    user_token,
)

post_args = bh.post_args


@pytest.fixture(autouse=True)
async def _clean_blog():
    yield
    await revalidate.drain()
    await bh.purge_blog()


async def _admin(c, mail):  # type: ignore[no-untyped-def]
    _, _, session = await new_admin(c, mail)
    return session["access_token"]


def _text(result) -> str:  # type: ignore[no-untyped-def]
    return " ".join(getattr(b, "text", "") for b in result.content)


# ── discovery ────────────────────────────────────────────────────────────────


async def test_discovery_metadata_matches_the_spec():
    async with client() as c:
        prm = (await c.get("/.well-known/oauth-protected-resource/mcp")).json()
        root = (await c.get("/.well-known/oauth-protected-resource")).json()
        asm = (await c.get("/.well-known/oauth-authorization-server")).json()
        unauth = await c.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert prm == root
    assert prm["resource"] == "http://localhost:8000/mcp"
    assert prm["authorization_servers"] == ["http://localhost:8000"]
    assert prm["scopes_supported"] == ["blog:write"]
    assert asm["issuer"] == "http://localhost:8000"  # identical to the PRM entry (no trailing slash)
    assert asm["code_challenge_methods_supported"] == ["S256"]
    assert asm["authorization_endpoint"] == "http://localhost:8000/mcp/oauth/authorize"
    assert asm["token_endpoint"] == "http://localhost:8000/mcp/oauth/token"
    assert asm["registration_endpoint"] == "http://localhost:8000/mcp/oauth/register"
    assert "none" in asm["token_endpoint_auth_methods_supported"]
    assert set(asm["grant_types_supported"]) >= {"authorization_code", "refresh_token"}
    assert unauth.status_code == 401
    www = unauth.headers["www-authenticate"]
    assert www.startswith("Bearer ")
    assert 'resource_metadata="http://localhost:8000/.well-known/oauth-protected-resource/mcp"' in www
    assert 'scope="blog:write"' in www


# ── registration ─────────────────────────────────────────────────────────────


async def test_registration_only_accepts_claude_callbacks(monkeypatch):
    async with client() as c:
        ok = await bh.register(c)
        ok_com = await bh.register(c, redirect="https://claude.com/api/mcp/auth_callback")
        evil = await c.post("/mcp/oauth/register", json={
            "client_name": "pytest evil", "redirect_uris": ["https://evil.example/cb"], "token_endpoint_auth_method": "none",
        })
        loop = await c.post("/mcp/oauth/register", json={
            "client_name": "pytest loop", "redirect_uris": ["http://localhost:4567/callback"], "token_endpoint_auth_method": "none",
        })
        monkeypatch.setenv("BLOG_MCP_ALLOW_LOOPBACK_REDIRECTS", "true")
        get_settings.cache_clear()
        loop_ok = await c.post("/mcp/oauth/register", json={
            "client_name": "pytest loop", "redirect_uris": ["http://localhost:4567/callback"], "token_endpoint_auth_method": "none",
        })
        bad_scope = await c.post("/mcp/oauth/register", json={
            "client_name": "pytest scope", "redirect_uris": [bh.CALLBACK], "scope": "blog:write admin",
        })
    assert ok["client_id"] and ok["token_endpoint_auth_method"] == "none" and ok.get("client_secret") is None
    assert ok_com["client_id"]
    assert evil.status_code == 400 and evil.json()["error"] == "invalid_redirect_uri"
    assert loop.status_code == 400
    assert loop_ok.status_code == 201
    assert bad_scope.status_code == 400


async def test_confidential_client_secret_is_stored_encrypted():
    async with client() as c:
        reg = await bh.register(c, public=False)
    assert reg["client_secret"]
    row = await db("SELECT secret_enc, info::text FROM core.blog_oauth_clients WHERE client_id = :c", c=reg["client_id"])
    assert row and reg["client_secret"] not in row[0][0] and reg["client_secret"] not in row[0][1]
    again = await oauth.BlogOAuthProvider().get_client(reg["client_id"])
    assert again is not None and again.client_secret == reg["client_secret"]


# ── authorization + consent ──────────────────────────────────────────────────


async def test_full_flow_and_pkce_and_single_use_code(mail):
    async with client() as c:
        admin = await _admin(c, mail)
        reg = await bh.register(c)
        verifier, challenge = bh.pkce()
        request_id = await bh.authorize(c, reg["client_id"], challenge)
        # The consent screen's data: names the redirect host (spec MUST).
        info = await c.get(f"/admin/blog/oauth/requests/{request_id}", headers=bearer(admin))
        assert info.status_code == 200 and info.json()["redirect_host"] == "claude.ai"
        back = await bh.approve(c, admin, request_id)
        assert back["state"] == "st-1" and back["iss"] == "http://localhost:8000"
        wrong = await bh.exchange(c, reg["client_id"], back["code"], "x" * 50)
        good = await bh.exchange(c, reg["client_id"], back["code"], verifier)
        reused = await bh.exchange(c, reg["client_id"], back["code"], verifier)
        again = await c.post(f"/admin/blog/oauth/requests/{request_id}/approve", headers=bearer(admin))
    assert wrong.status_code == 400 and wrong.json()["error"] == "invalid_grant"
    assert good.status_code == 200, good.text
    tokens = good.json()
    assert tokens["token_type"].lower() == "bearer" and tokens["refresh_token"] and tokens["scope"] == "blog:write"
    claims = jwt.decode(tokens["access_token"], options={"verify_signature": False})
    assert claims["aud"] == "noey-blog-mcp" and claims["scope"] == "blog:write"
    assert claims["resource"] == "http://localhost:8000/mcp"
    assert claims["exp"] - claims["iat"] == get_settings().blog_mcp_access_ttl_sec
    assert reused.status_code == 400 and reused.json()["error"] == "invalid_grant"
    assert again.status_code == 409
    # Code reuse revoked the grant it had issued (OAuth 2.1 §4.1.3).
    assert await oauth.BlogOAuthProvider().load_access_token(tokens["access_token"]) is None


async def test_pkce_is_mandatory_and_plain_is_refused(mail):
    async with client() as c:
        reg = await bh.register(c)
        base = {"response_type": "code", "client_id": reg["client_id"], "redirect_uri": bh.CALLBACK, "state": "s"}
        missing = await c.get("/mcp/oauth/authorize", params=base)
        plain = await c.get("/mcp/oauth/authorize", params={**base, "code_challenge": "abc", "code_challenge_method": "plain"})
        other_redirect = await c.get("/mcp/oauth/authorize", params={
            **base, "redirect_uri": "https://claude.com/api/mcp/auth_callback", "code_challenge": "a" * 43,
            "code_challenge_method": "S256",
        })
    for r in (missing, plain):
        assert r.status_code == 302 and "error=invalid_request" in r.headers["location"]
    assert other_redirect.status_code == 400  # unregistered redirect: no redirect at all


async def test_wrong_resource_is_refused(mail):
    async with client() as c:
        reg = await bh.register(c)
        _, challenge = bh.pkce()
        r = await c.get("/mcp/oauth/authorize", params={
            "response_type": "code", "client_id": reg["client_id"], "redirect_uri": bh.CALLBACK,
            "code_challenge": challenge, "code_challenge_method": "S256", "resource": "https://other.example/mcp",
        })
    assert r.status_code == 302 and "error=invalid_target" in r.headers["location"]


async def test_only_an_admin_can_approve(mail):
    async with client() as c:
        reg = await bh.register(c)
        _, challenge = bh.pkce()
        request_id = await bh.authorize(c, reg["client_id"], challenge)
        uid = await make_user(email("user"))
        as_user = await c.post(f"/admin/blog/oauth/requests/{request_id}/approve", headers=bearer(await user_token(uid)))
        anonymous = await c.post(f"/admin/blog/oauth/requests/{request_id}/approve")
        admin = await _admin(c, mail)
        denied = await c.post(f"/admin/blog/oauth/requests/{request_id}/deny", headers=bearer(admin))
    assert as_user.status_code == 401 and anonymous.status_code == 401
    assert denied.status_code == 200
    assert "error=access_denied" in denied.json()["redirect_to"] and "state=st-1" in denied.json()["redirect_to"]


# ── tokens: audience, refresh rotation, revocation ──────────────────────────


async def test_token_audiences_never_cross(mail):
    async with client() as c:
        admin = await _admin(c, mail)
        tokens = await bh.connect(c, admin)
        mcp_token = tokens["access_token"]
        uid = await make_user(email("user"))
        app_token = await user_token(uid)
        on_mcp_user = await c.post("/mcp", json={}, headers=bearer(app_token))
        on_mcp_admin = await c.post("/mcp", json={}, headers=bearer(admin))
        on_admin = await c.get("/admin/auth/me", headers=bearer(mcp_token))
        on_app = await c.get("/auth/me", headers=bearer(mcp_token))
        on_admin_blog = await c.get("/admin/blog/posts", headers=bearer(mcp_token))
    assert on_mcp_user.status_code == 401 and on_mcp_admin.status_code == 401
    assert on_admin.status_code == 401 and on_app.status_code == 401 and on_admin_blog.status_code == 401
    # A token signed right but minted for another resource is refused too.
    claims = jwt.decode(mcp_token, options={"verify_signature": False})
    other = jwt.encode({**claims, "resource": "https://elsewhere.example/mcp"}, get_settings().jwt_secret, algorithm="HS256")
    wrong_aud = jwt.encode({**claims, "aud": "noey-app"}, get_settings().jwt_secret, algorithm="HS256")
    async with client() as c, mcp_server.run():
        r1 = await c.post("/mcp", json={}, headers=bearer(other))
        r2 = await c.post("/mcp", json={}, headers=bearer(wrong_aud))
    assert r1.status_code == 401 and r2.status_code == 401
    # An app token cannot be smuggled through as a blog token either.
    assert await oauth.BlogOAuthProvider().load_access_token(encode_access(uid, 1, "default", 0)) is None


async def test_refresh_rotates_and_reuse_revokes_the_grant(mail):
    async with client() as c:
        admin = await _admin(c, mail)
        t1 = await bh.connect(c, admin)
        r2 = await bh.refresh(c, t1["client_id"], t1["refresh_token"])
        assert r2.status_code == 200, r2.text
        t2 = r2.json()
        assert t2["refresh_token"] != t1["refresh_token"] and t2["access_token"] != t1["access_token"]
        replay = await bh.refresh(c, t1["client_id"], t1["refresh_token"])
        after = await bh.refresh(c, t1["client_id"], t2["refresh_token"])
        grants = (await c.get("/admin/blog/connectors", headers=bearer(admin))).json()
    assert replay.status_code == 400 and replay.json()["error"] == "invalid_grant"
    assert after.status_code == 400 and after.json()["error"] == "invalid_grant"  # the family is gone
    assert await oauth.BlogOAuthProvider().load_access_token(t2["access_token"]) is None
    mine = [g for g in grants if g["client_id"] == t1["client_id"]]
    assert mine and mine[0]["revoked_reason"] == "refresh_reuse" and not mine[0]["active"]


async def test_admin_revoke_and_password_change_end_access(mail):
    async with client() as c:
        admin = await _admin(c, mail)
        t = await bh.connect(c, admin)
        provider = oauth.BlogOAuthProvider()
        assert await provider.load_access_token(t["access_token"]) is not None
        grant = next(g for g in (await c.get("/admin/blog/connectors", headers=bearer(admin))).json() if g["client_id"] == t["client_id"])
        r = await c.post(f"/admin/blog/connectors/{grant['grant_id']}/revoke", headers=bearer(admin))
        assert r.status_code == 200 and r.json()["revoked"] is True
        assert await provider.load_access_token(t["access_token"]) is None
        assert (await bh.refresh(c, t["client_id"], t["refresh_token"])).status_code == 400
        t2 = await bh.connect(c, admin)
        assert await provider.load_access_token(t2["access_token"]) is not None
        sub = jwt.decode(t2["access_token"], options={"verify_signature": False})["sub"]
        await db("UPDATE core.users SET token_version = token_version + 1 WHERE id = :i", i=int(sub))
        assert await provider.load_access_token(t2["access_token"]) is None


async def test_expired_access_token_is_401(mail):
    async with client() as c:
        admin = await _admin(c, mail)
        t = await bh.connect(c, admin)
        claims = jwt.decode(t["access_token"], options={"verify_signature": False})
        old = jwt.encode({**claims, "exp": int((datetime.now(UTC) - timedelta(minutes=1)).timestamp())},
                         get_settings().jwt_secret, algorithm="HS256")
        async with mcp_server.run():
            r = await c.post("/mcp", json={}, headers=bearer(old))
    assert r.status_code == 401 and 'error="invalid_token"' in r.headers["www-authenticate"]


# ── tools ────────────────────────────────────────────────────────────────────


async def test_tool_list_has_no_delete_and_strict_schemas(mail):
    async with client() as c:
        t = await bh.connect(c, await _admin(c, mail))
    async with bh.mcp_client(t["access_token"]) as mcp:
        tools = (await mcp.list_tools()).tools
    names = {tool.name for tool in tools}
    assert names == set(mcp_server.TOOL_NAMES)
    assert not [n for n in names if "delete" in n or "remove" in n]
    create = next(tool for tool in tools if tool.name == "create_post")
    assert set(create.input_schema["required"]) >= {"slug", "title", "content_md", "category", "faq"}
    assert all(tool.description and len(tool.description) > 40 for tool in tools)
    by_name = {tool.name: tool for tool in tools}
    assert by_name["get_post"].annotations.read_only_hint is True
    assert by_name["create_post"].annotations.read_only_hint is False
    assert [n for n, t in by_name.items() if t.annotations.destructive_hint] == ["unpublish_post"]


async def test_end_to_end_create_publish_public_api_and_revalidate(mail, monkeypatch, tmp_path):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("BLOG_REVALIDATE_SECRET", "rv-secret")
    monkeypatch.setenv("BLOG_REVALIDATE_URL", "http://site.test/api/revalidate-blog")
    get_settings.cache_clear()
    calls: list[dict] = []

    import httpx

    real = httpx.AsyncClient

    def fake_client(*a, **kw):  # type: ignore[no-untyped-def]
        def handler(request: httpx.Request) -> httpx.Response:
            calls.append({"url": str(request.url), "auth": request.headers.get("authorization"), "body": json.loads(request.content)})
            return httpx.Response(200, json={"revalidated": True})

        return real(transport=httpx.MockTransport(handler))

    monkeypatch.setattr(revalidate.httpx, "AsyncClient", fake_client)
    slug = f"{bh.PREFIX}e2e"
    async with client() as c:
        t = await bh.connect(c, await _admin(c, mail))
    async with bh.mcp_client(t["access_token"]) as mcp:
        info = await mcp.call_tool("get_site_info", {})
        site = info.structured_content
        assert site["product"]["name"] == "Noey Studio" and site["writing_rules"] and site["guides"]
        png = io.BytesIO()
        Image.new("RGB", (2000, 1000), (200, 120, 40)).save(png, format="PNG")
        up = await mcp.call_tool("upload_image", {
            "image_base64": base64.b64encode(png.getvalue()).decode(), "filename": "cover.png", "alt": "ภาพปกบทความ",
        })
        assert not up.is_error, _text(up)
        cover = up.structured_content
        assert cover["width"] == 1600 and cover["height"] == 800 and cover["url"].startswith("http://localhost:8000/blog/media/")
        created = await mcp.call_tool("create_post", post_args(slug, cover_image_url=cover["url"], cover_alt="ภาพปก"))
        assert not created.is_error, _text(created)
        assert created.structured_content["status"] == "draft"
        listed = await mcp.call_tool("list_posts", {})
        assert slug in [p["slug"] for p in listed.structured_content["items"]]
        pub = await mcp.call_tool("publish_post", {"slug": slug})
        assert not pub.is_error, _text(pub)
        assert pub.structured_content["outcome"] == "published"
    await revalidate.drain()
    async with client() as c:
        one = await c.get(f"/blog/posts/{slug}")
        slugs = await c.get("/blog/slugs")
        lst = await c.get("/blog/posts")
        img = await c.get(cover["url"].replace("http://localhost:8000", ""))
    assert one.status_code == 200 and one.headers["cache-control"] == "public, max-age=60"
    body = one.json()
    assert body["cover_width"] == 1600 and body["source"] == "ai" and body["reading_minutes"] >= 3
    assert body["category"] == {"slug": "editing-tips", "name": "เทคนิคตัดต่อ"}
    assert slug in [s["slug"] for s in slugs.json()]
    assert "content_md" not in lst.json()["items"][0]
    assert img.status_code == 200 and img.headers["content-type"] == "image/webp"
    assert calls and calls[-1]["auth"] == "Bearer rv-secret" and calls[-1]["body"] == {"slugs": [slug]}
    assert calls[-1]["url"] == "http://site.test/api/revalidate-blog"
    # Every write is in the audit log.
    actions = {r[0] for r in await db("SELECT action FROM core.blog_audit_log WHERE actor = :a", a=f"mcp:{t['client_id']}")}
    assert {"oauth_register", "oauth_authorize", "oauth_token", "upload_image", "create_post", "publish_post"} <= actions


async def test_tool_refusals_tell_the_writer_what_to_fix(mail):
    async with client() as c:
        t = await bh.connect(c, await _admin(c, mail))
    async with bh.mcp_client(t["access_token"]) as mcp:
        bad = await mcp.call_tool("create_post", post_args(
            f"{bh.PREFIX}bad", content_md="# H1\n\n<script>x</script> สั้นเกินไป", category="no-such",
        ))
        missing = await mcp.call_tool("get_post", {"slug": "does-not-exist"})
    assert bad.is_error
    msg = _text(bad)
    assert "script" in msg and "H1" in msg and "minimum" in msg
    assert missing.is_error and "No post" in _text(missing)


async def test_mcp_cannot_touch_a_human_post_and_slug_locks(mail):
    slug = f"{bh.PREFIX}human"
    async with client() as c:
        admin = await _admin(c, mail)
        t = await bh.connect(c, admin)
    async with bh.mcp_client(t["access_token"]) as mcp:
        assert not (await mcp.call_tool("create_post", post_args(slug))).is_error
        assert not (await mcp.call_tool("publish_post", {"slug": slug})).is_error
        rename = await mcp.call_tool("update_post", {"slug": slug, "changes": {"new_slug": f"{slug}-2"}})
        assert rename.is_error and "locked" in _text(rename)
    async with client() as c:
        edit = await c.put(f"/admin/blog/posts/{slug}", json={"title": "แก้ไขโดยเจ้าของเว็บไซต์"}, headers=bearer(admin))
        assert edit.status_code == 200 and edit.json()["source"] == "human"
    async with bh.mcp_client(t["access_token"]) as mcp:
        upd = await mcp.call_tool("update_post", {"slug": slug, "changes": {"title": "AI พยายามแก้บทความนี้"}})
        unp = await mcp.call_tool("unpublish_post", {"slug": slug})
    assert upd.is_error and "source = human" in _text(upd)
    assert not unp.is_error  # taking a post offline stays possible
    refused = await db("SELECT ok FROM core.blog_audit_log WHERE slug = :s AND action = 'update_post'", s=slug)
    assert [r[0] for r in refused] == [False, False]


async def test_rate_limit_per_grant(mail, monkeypatch):
    monkeypatch.setenv("BLOG_MCP_CALLS_PER_MIN", "2")
    get_settings.cache_clear()
    async with client() as c:
        t = await bh.connect(c, await _admin(c, mail))
    async with bh.mcp_client(t["access_token"]) as mcp:
        results = [await mcp.call_tool("list_categories", {}) for _ in range(3)]
    assert [r.is_error for r in results] == [False, False, True]
    assert "Rate limit" in _text(results[2])
