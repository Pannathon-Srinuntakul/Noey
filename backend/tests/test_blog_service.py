# ruff: noqa: F811  (pytest fixtures imported from tests/admin_helpers.py are parameters here)
"""Blog rules against the real database: the daily publish cap on the Bangkok
calendar, owner switches, human-post protection, slug lock, the public API
contract (BLOG_CONTRACT.md), audit rows, the migration and site_info drift."""

from __future__ import annotations

import shutil
import subprocess
import sys
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import create_engine, text

from packages.blog import revalidate, service
from packages.blog.schemas import NewPost, PostChanges
from packages.core.settings import get_settings
from packages.db.session import get_sessionmaker
from tests import blog_helpers as bh
from tests.admin_helpers import (  # noqa: F401  (fixtures)
    _admin_env,
    bearer,
    client,
    db,
    mail,
    new_admin,
)
from tests.test_admin_security import PROTECTED

BKK = ZoneInfo("Asia/Bangkok")
ACTOR = "mcp:test-client"


@pytest.fixture(autouse=True)
async def _clean():
    yield
    await revalidate.drain()
    await bh.purge_blog()


async def _session():  # type: ignore[no-untyped-def]
    s = get_sessionmaker()()
    await s.execute(text("SET search_path TO core, public"))
    return s


async def _create(slug: str, **over: object) -> None:
    async with await _session() as s:
        await service.create_post(s, NewPost.model_validate(await bh.full_post_args(slug, ACTOR, **over)), ACTOR)
        await s.commit()


async def _publish(slug: str, *, by_admin: bool = False) -> service.PublishResult:
    async with await _session() as s:
        r = await service.publish(s, slug, ACTOR if not by_admin else "admin:1", by_admin=by_admin)
        await s.commit()
        return r


def _at(monkeypatch, local: datetime) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setattr(service, "_clock", lambda: local.astimezone(UTC))


async def test_daily_cap_counts_the_bangkok_day(monkeypatch):
    slugs = [f"{bh.PREFIX}cap-{i}" for i in range(4)]
    for s in slugs:
        await _create(s)
    # 23:50 Bangkok = 16:50 UTC the same date; 00:10 Bangkok next day is still
    # the previous UTC date — a UTC-day count would get both wrong.
    _at(monkeypatch, datetime(2026, 10, 1, 23, 50, tzinfo=BKK))
    assert (await _publish(slugs[0])).outcome == "published"
    assert (await _publish(slugs[1])).outcome == "published"
    with pytest.raises(service.BlogError) as refused:
        await _publish(slugs[2])
    assert refused.value.code == "daily_cap"
    assert "2026-10-02T00:00:00+07:00" in refused.value.problems[0]
    _at(monkeypatch, datetime(2026, 10, 2, 0, 10, tzinfo=BKK))
    assert (await _publish(slugs[2])).outcome == "published"
    # The refusal stayed a draft and was audited as refused.
    rows = await db("SELECT ok, detail->>'refused' FROM core.blog_audit_log WHERE slug = :s AND action = 'publish_post'", s=slugs[2])
    assert (False, "daily_cap") in [tuple(r) for r in rows]
    # The owner is never capped.
    _at(monkeypatch, datetime(2026, 10, 2, 0, 20, tzinfo=BKK))
    assert (await _publish(slugs[3])).outcome == "published"
    assert (await _publish(slugs[3])).outcome == "already_published"


async def test_cap_and_switch_from_admin_override_env(monkeypatch, mail):
    slug = f"{bh.PREFIX}switch"
    await _create(slug)
    async with client() as c:
        _, _, s = await new_admin(c, mail)
        tok = s["access_token"]
        before = (await c.get("/admin/blog/settings", headers=bearer(tok))).json()
        assert before["auto_publish"] is True and before["max_per_day"] == 2 and before["auto_publish_source"] == "env"
        put = await c.put("/admin/blog/settings", json={"auto_publish": False, "max_per_day": 1}, headers=bearer(tok))
        assert put.status_code == 200 and put.json()["auto_publish_source"] == "admin"
        waiting = await _publish(slug)
        assert waiting.outcome == "awaiting_owner" and waiting.post.status == "draft"
        approve = await c.post(f"/admin/blog/posts/{slug}/publish", headers=bearer(tok))
        assert approve.status_code == 200 and approve.json()["outcome"] == "published"
        reset = await c.put("/admin/blog/settings", json={"auto_publish": None, "max_per_day": None}, headers=bearer(tok))
        assert reset.json()["auto_publish_source"] == "env" and reset.json()["max_per_day"] == 2
        audit = (await c.get("/admin/blog/audit", headers=bearer(tok))).json()
    actions = [a["action"] for a in audit]
    assert actions.count("admin_settings") == 2 and "admin_publish" in actions


async def test_human_posts_are_out_of_mcp_reach_and_slug_locks(mail):
    slug = f"{bh.PREFIX}lock"
    await _create(slug)
    async with await _session() as s:
        renamed = await service.update_post(s, slug, PostChanges(new_slug=f"{slug}-new"), ACTOR, by_admin=False)
        await s.commit()
        assert renamed.slug == f"{slug}-new"  # allowed before the first publish
    slug = f"{slug}-new"
    await _publish(slug)
    async with await _session() as s:
        with pytest.raises(service.BlogError) as locked:
            await service.update_post(s, slug, PostChanges(new_slug=f"{slug}-again"), ACTOR, by_admin=False)
    assert locked.value.code == "slug_locked"
    async with client() as c:
        _, _, sess = await new_admin(c, mail)
        r = await c.put(f"/admin/blog/posts/{slug}", json={"new_slug": "x-y"}, headers=bearer(sess["access_token"]))
        assert r.status_code == 409  # not even the owner moves a published URL
        r = await c.put(f"/admin/blog/posts/{slug}", json={"excerpt": "บทสรุปที่เจ้าของเว็บแก้ไขเองแล้วให้ยาวพอสำหรับกฎ"}, headers=bearer(sess["access_token"]))
        assert r.status_code == 200 and r.json()["source"] == "human"
    async with await _session() as s:
        with pytest.raises(service.BlogError) as human:
            await service.update_post(s, slug, PostChanges(title="แก้โดย AI อีกรอบหนึ่ง"), ACTOR, by_admin=False)
    assert human.value.code == "human_post"
    async with await _session() as s:
        await service.unpublish(s, slug, ACTOR, by_admin=False)  # taking it offline stays possible
        await s.commit()
    async with await _session() as s:
        with pytest.raises(service.BlogError) as republish:
            await service.publish(s, slug, ACTOR, by_admin=False)
    assert republish.value.code == "human_post"  # but only the owner brings it back


async def test_published_at_is_set_once():
    slug = f"{bh.PREFIX}once"
    await _create(slug)
    first = (await _publish(slug)).post.published_at
    async with await _session() as s:
        await service.unpublish(s, slug, ACTOR, by_admin=False)
        await s.commit()
    again = (await _publish(slug)).post.published_at
    assert first is not None and again == first


async def test_public_api_contract_and_visibility():
    a, b, c_, d = (f"{bh.PREFIX}{x}" for x in ("a", "b", "c", "draft"))
    tag = [{"slug": f"{bh.PREFIX}shared", "name": "แท็กร่วม"}]
    await _create(a, tags=tag)
    await _create(b, tags=tag, category="subtitles-audio")
    await _create(c_, category="editing-tips")
    await _create(d)
    for s in (a, b, c_):
        await _publish(s, by_admin=True)
    async with await _session() as s:
        await service.unpublish(s, c_, ACTOR, by_admin=False)
        await s.commit()
    async with client() as c:
        one = await c.get(f"/blog/posts/{a}")
        hidden = [await c.get(f"/blog/posts/{x}") for x in (c_, d, "nope")]
        page = await c.get("/blog/posts", params={"per_page": 50})
        by_tag = await c.get("/blog/posts", params={"tag": f"{bh.PREFIX}shared"})
        by_cat = await c.get("/blog/posts", params={"category": "subtitles-audio"})
        slugs = await c.get("/blog/slugs")
        cats = await c.get("/blog/categories")
        tags = await c.get("/blog/tags")
        bad = await c.get("/blog/posts", params={"per_page": 500})
    post = one.json()
    contract_keys = {
        "slug", "title", "meta_title", "meta_description", "excerpt", "content_md", "cover_image_url", "cover_alt",
        "cover_width", "cover_height", "category", "tags", "faq", "author", "source", "reading_minutes",
        "published_at", "updated_at", "related", "media",
    }
    assert set(post) == contract_keys
    assert post["author"] == "Noey Studio" and post["published_at"].endswith("Z")
    assert post["tags"] == [{"slug": f"{bh.PREFIX}shared", "name": "แท็กร่วม"}]
    assert [r["slug"] for r in post["related"]] == [b]  # shares a tag; the unpublished one never appears
    assert set(post["related"][0]) == {"slug", "title", "excerpt", "cover_image_url", "cover_alt", "category", "published_at"}
    assert [h.status_code for h in hidden] == [404, 404, 404]
    listed = [i["slug"] for i in page.json()["items"]]
    assert a in listed and b in listed and c_ not in listed and d not in listed
    assert set(page.json()) == {"items", "page", "per_page", "total"}
    assert not {"content_md", "faq", "related"} & set(page.json()["items"][0])
    assert {i["slug"] for i in by_tag.json()["items"]} == {a, b}
    assert [i["slug"] for i in by_cat.json()["items"]] == [b]
    assert {s["slug"] for s in slugs.json()} >= {a, b} and c_ not in {s["slug"] for s in slugs.json()}
    assert set(cats.json()[0]) == {"slug", "name", "description", "post_count"}
    assert [x["slug"] for x in cats.json()][:4] == ["editing-tips", "subtitles-audio", "selling-on-tiktok", "content-ideas"]
    assert {"slug": f"{bh.PREFIX}shared", "name": "แท็กร่วม", "post_count": 2} in tags.json()
    for r in (one, page, slugs, cats, tags):
        assert r.headers["cache-control"] == "public, max-age=60"
    assert bad.status_code == 422


async def test_every_write_is_audited():
    slug = f"{bh.PREFIX}audit"
    await _create(slug)
    async with await _session() as s:
        await service.update_post(s, slug, PostChanges(title="ชื่อใหม่ของบทความทดสอบ"), ACTOR, by_admin=False)
        await s.commit()
    await _publish(slug)
    async with await _session() as s:
        await service.unpublish(s, slug, ACTOR, by_admin=False)
        await s.commit()
    with pytest.raises(service.BlogError):
        await _create(slug)  # duplicate slug: refused, still audited
    rows = await db("SELECT action, ok FROM core.blog_audit_log WHERE slug = :s ORDER BY id", s=slug)
    assert [tuple(r) for r in rows] == [
        ("create_post", True), ("update_post", True), ("publish_post", True), ("unpublish_post", True), ("create_post", False),
    ]


async def test_categories_cannot_be_invented():
    with pytest.raises(service.BlogError) as e:
        await _create(f"{bh.PREFIX}cat", category="brand-new")
    assert e.value.code in ("invalid_post", "unknown_category")
    assert "Categories cannot be created" in " ".join(e.value.problems)
    assert (await db("SELECT count(*) FROM core.blog_categories WHERE slug = 'brand-new'"))[0][0] == 0


def test_admin_blog_routes_are_in_the_security_walk():
    blog = {p for _, p in PROTECTED if p.startswith("/admin/blog")}
    assert {
        "/admin/blog/posts", "/admin/blog/posts/{slug}", "/admin/blog/posts/{slug}/publish",
        "/admin/blog/posts/{slug}/unpublish", "/admin/blog/settings", "/admin/blog/audit",
        "/admin/blog/connectors", "/admin/blog/connectors/{grant_id}/revoke",
        "/admin/blog/oauth/requests/{request_id}", "/admin/blog/oauth/requests/{request_id}/approve",
        "/admin/blog/oauth/requests/{request_id}/deny",
    } <= blog


def test_models_match_the_migration():
    """Autogenerate finds nothing to do for the blog tables (no hand drift)."""
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext

    import packages.db.models  # noqa: F401
    from packages.db.base import Base

    engine = create_engine(get_settings().sync_database_url)
    try:
        with engine.connect() as conn:
            ctx = MigrationContext.configure(conn, opts={"include_schemas": True, "compare_type": True})
            diffs = compare_metadata(ctx, Base.metadata)
    finally:
        engine.dispose()
    blog = [d for d in diffs if "blog_" in repr(d)]
    assert blog == []


@pytest.mark.skipif(shutil.which("node") is None, reason="node is needed to read noey-frontend's TypeScript")
def test_site_info_json_matches_the_site():
    r = subprocess.run([sys.executable, "scripts/build_site_info.py", "--check"], capture_output=True, text=True, timeout=120, check=False)
    assert r.returncode == 0, r.stderr
