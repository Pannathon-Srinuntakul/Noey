# ruff: noqa: F811  (pytest fixtures imported from tests/admin_helpers.py are parameters here)
"""The post picture rules (spec §7), the media library (upload → list_media),
the writing brief + content plan (admin and get_site_info / mark_topic_done),
upload_image's new size cap and the new admin routes' place in the guard walk."""

from __future__ import annotations

import base64
import io
import shutil
import subprocess

import pytest
from PIL import Image

from packages.blog import library, media, revalidate, service
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

ACTOR = "mcp:test-media"


@pytest.fixture(autouse=True)
async def _clean(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    yield
    await revalidate.drain()
    await bh.purge_blog()


async def _session():  # type: ignore[no-untyped-def]
    from sqlalchemy import text

    s = get_sessionmaker()()
    await s.execute(text("SET search_path TO core, public"))
    return s


async def _create(args: dict, actor: str = ACTOR) -> None:
    async with await _session() as s:
        await service.create_post(s, NewPost.model_validate(args), actor)
        await s.commit()


async def _refused(args: dict, actor: str = ACTOR) -> list[str]:
    with pytest.raises(service.BlogError) as e:
        await _create(args, actor)
    return e.value.problems


# ── §7 picture rules ─────────────────────────────────────────────────────────


async def test_cover_and_two_pictures_are_required_and_all_listed_at_once():
    problems = await _refused(bh.post_args(f"{bh.PREFIX}nomedia"))
    joined = " ".join(problems)
    assert "cover_image_url is required" in joined and "at least 2 are required" in joined


async def test_iframe_and_outside_images_are_refused():
    args = await bh.full_post_args(f"{bh.PREFIX}iframe", ACTOR)
    args["content_md"] += '\n\n<iframe src="https://evil.example"></iframe>\n\n![ภาพ](https://evil.example/a.png)\n'
    joined = " ".join(await _refused(args))
    assert "<script>/<iframe>" in joined and "not from the blog media store" in joined


async def test_more_than_three_animated_visuals_are_refused():
    media_args = await bh.seed_media(ACTOR, visuals=4, animated=4)
    joined = " ".join(await _refused(bh.post_args(f"{bh.PREFIX}anim", **media_args)))
    assert "4 animated visuals; at most 3" in joined
    ok_args = await bh.seed_media(ACTOR, visuals=4, animated=3)
    await _create(bh.post_args(f"{bh.PREFIX}anim3", **ok_args))


async def test_visuals_must_belong_to_the_same_connection():
    other = await bh.seed_media("mcp:someone-else")
    joined = " ".join(await _refused(bh.post_args(f"{bh.PREFIX}theirs", **other)))
    assert "made by another connection" in joined


async def test_visual_ids_must_exist_and_have_alt():
    args = await bh.full_post_args(f"{bh.PREFIX}ghost", ACTOR)
    args["content_md"] += "\n\n::visual[ภาพที่ไม่มีอยู่](" + "f" * 32 + ")\n\n::visual[](" + "e" * 32 + ")\n"
    joined = " ".join(await _refused(args))
    assert "There is no visual" in joined and "has no alt text" in joined


async def test_upload_image_cannot_be_the_cover_but_library_and_render_cover_can(tmp_path):
    png = io.BytesIO()
    Image.new("RGB", (800, 450), (10, 20, 30)).save(png, format="PNG")
    encoded, w, h = media.reencode(png.getvalue())
    stored = await media.store(encoded, w, h)
    async with await _session() as s:
        await service.record_image(s, stored, "รูปเล็ก", ACTOR)
        await s.commit()
    args = await bh.full_post_args(f"{bh.PREFIX}upcover", ACTOR, cover_image_url=stored.url)
    assert "cannot be the cover" in " ".join(await _refused(args))
    await db("UPDATE core.blog_images SET origin = 'library', category = 'screenshot' WHERE url = :u", u=stored.url)
    await _create(args)


async def test_pdf_is_a_link_not_an_image_and_library_video_counts(tmp_path):
    pdf = await media.store_bytes(b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "pdf")
    vid = await media.store_bytes(b"\x00\x00\x00\x18ftypisom-fake-video", "mp4", width=1280, height=720)
    for stored, kind, cat in ((pdf, "file", "file"), (vid, "video", "demo")):
        await db(
            "INSERT INTO core.blog_images (url, key, mime, bytes, width, height, alt, uploaded_by, kind, origin, category, poster_url) "
            "VALUES (:u, :k, :m, 10, :w, :h, 'สื่อ', 'test-seed', :kind, 'library', :cat, :p)",
            u=stored.url, k=stored.key, m=stored.mime, w=stored.width, h=stored.height, kind=kind, cat=cat,
            p=f"{media.media_base()}/{'c' * 64}.webp",
        )
    one_visual = await bh.seed_media(ACTOR, visuals=1)
    bad = bh.post_args(f"{bh.PREFIX}pdfimg", **{**one_visual, "content_md": one_visual["content_md"] + f"\n\n![เอกสาร]({pdf.url})\n"})
    joined = " ".join(await _refused(bad))
    assert "is a PDF" in joined and "is a file, not a picture" in joined
    good = bh.post_args(
        f"{bh.PREFIX}pdflink",
        **{**one_visual, "content_md": one_visual["content_md"] + f"\n\n![เดโม]({vid.url})\n\nดาวน์โหลด [คู่มือ PDF]({pdf.url})\n"},
    )
    await _create(good)
    async with await _session() as s:
        row = await service.get_post_row(s, f"{bh.PREFIX}pdflink")
        assert row is not None
        full = await service.post_full(s, row)
    assert [m["type"] for m in full["media"]] == ["visual", "video"]
    assert full["media"][1]["poster_url"].endswith(".webp") and full["media"][1]["width"] == 1280
    ghost = bh.post_args(
        f"{bh.PREFIX}pdfghost",
        **{**one_visual, "content_md": one_visual["content_md"] + f"\n\n![เดโม]({vid.url})\n\n[ไฟล์]({media.media_base()}/{'d' * 64}.pdf)\n"},
    )
    assert "no such file exists" in " ".join(await _refused(ghost))


async def test_owner_edits_skip_the_count_rule_but_not_the_animated_cap(mail):
    slug = f"{bh.PREFIX}owner"
    await _create(await bh.full_post_args(slug, ACTOR))
    four = await bh.seed_media("mcp:another", visuals=4, animated=4)
    async with client() as c:
        _, _, sess = await new_admin(c, mail)
        tok = sess["access_token"]
        fewer = await c.put(f"/admin/blog/posts/{slug}", json={"content_md": bh.article()}, headers=bearer(tok))
        too_many = await c.put(f"/admin/blog/posts/{slug}", json={"content_md": four["content_md"]}, headers=bearer(tok))
    assert fewer.status_code == 200
    assert too_many.status_code == 400 and "at most 3" in too_many.json()["detail"]


async def test_mcp_update_rechecks_the_rules():
    slug = f"{bh.PREFIX}upd"
    await _create(await bh.full_post_args(slug, ACTOR))
    async with await _session() as s:
        with pytest.raises(service.BlogError) as e:
            await service.update_post(s, slug, PostChanges(content_md=bh.article()), ACTOR, by_admin=False)
    assert "at least 2 are required" in " ".join(e.value.problems)


# ── media library ────────────────────────────────────────────────────────────


def _png(w: int = 3000, h: int = 1500) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (182, 130, 53)).save(buf, format="PNG")
    return buf.getvalue()


def _mp4(seconds: int = 2) -> bytes | None:
    from packages.video.ffmpeg_bin import ffmpeg_cmd

    try:
        out = subprocess.run(
            [ffmpeg_cmd(), "-v", "error", "-f", "lavfi", "-i", f"testsrc=size=640x360:rate=25:duration={seconds}",
             "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}", "-c:v", "libx264", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-metadata", "title=secret-gps", "-f", "mp4", "-movflags", "frag_keyframe+empty_moov", "pipe:1"],
            capture_output=True, timeout=60, check=True,
        )
    except Exception:  # noqa: BLE001
        return None
    return out.stdout


async def test_library_upload_list_and_list_media(mail):
    video = _mp4()
    async with client() as c:
        _, _, sess = await new_admin(c, mail)
        h = bearer(sess["access_token"])
        shot = await c.post(
            "/admin/blog/media", headers=h,
            data={"kind": "screenshot", "alt": "หน้าจอไทม์ไลน์", "description": "ไทม์ไลน์ของโปรเจกต์", "tags": "Editor, timeline"},
            files={"file": ("shot.png", _png(), "image/png")},
        )
        wrong = await c.post(
            "/admin/blog/media", headers=h, data={"kind": "demo", "alt": "คลิปเดโม"},
            files={"file": ("x.mp4", _png(), "video/mp4")},
        )
        exe = await c.post(
            "/admin/blog/media", headers=h, data={"kind": "file", "alt": "ไฟล์"},
            files={"file": ("x.pdf", b"MZ\x90\x00 not a pdf", "application/pdf")},
        )
        pdf = await c.post(
            "/admin/blog/media", headers=h, data={"kind": "file", "alt": "คู่มือ PDF"},
            files={"file": ("guide.pdf", b"%PDF-1.4\n%%EOF\n", "application/pdf")},
        )
        demo = None
        if video is not None:
            demo = await c.post(
                "/admin/blog/media", headers=h, data={"kind": "demo", "alt": "คลิปสาธิต", "tags": "demo"},
                files={"file": ("demo.mp4", video, "video/mp4")},
            )
        listed = await c.get("/admin/blog/media", headers=h)
        archive = await c.patch(f"/admin/blog/media/{shot.json()['id']}", json={"archived": True, "tags": ["x"]}, headers=h)
        after = await c.get("/admin/blog/media", headers=h)
        with_archived = await c.get("/admin/blog/media", params={"archived": "true"}, headers=h)
        served_pdf = await c.get(pdf.json()["url"].replace("http://localhost:8000", ""))
    assert shot.status_code == 200, shot.text
    item = shot.json()
    assert item["type"] == "image" and item["kind"] == "screenshot" and (item["width"], item["height"]) == (2400, 1200)
    assert item["tags"] == ["editor", "timeline"] and item["url"].endswith(".webp")
    assert wrong.status_code == 400 and "วิดีโอ MP4" in wrong.json()["detail"]
    assert exe.status_code == 400
    assert pdf.status_code == 200 and pdf.json()["type"] == "file" and pdf.json()["markdown"].startswith("[")
    assert served_pdf.headers["content-disposition"].startswith("attachment") and served_pdf.headers["content-type"] == "application/pdf"
    assert "sandbox" in served_pdf.headers["content-security-policy"]
    if demo is not None:
        assert demo.status_code == 200, demo.text
        d = demo.json()
        assert d["type"] == "video" and d["poster_url"].endswith(".webp") and d["url"].endswith(".mp4")
        stored = await media.read(d["url"].rsplit("/", 1)[1])
        assert stored is not None and b"secret-gps" not in stored  # metadata dropped
        probe = subprocess.run(  # noqa: ASYNC221 — a test helper, not request code
            [shutil.which("ffprobe") or "ffprobe", "-v", "error", "-show_streams", "-of", "csv=p=0", "pipe:0"],
            input=stored, capture_output=True, check=False,
        ).stdout.decode()
        assert "audio" not in probe and "h264" in probe
        assert stored.index(b"moov") < stored.index(b"mdat")  # faststart
    assert {i["kind"] for i in listed.json()["items"]} >= {"screenshot", "file"}
    assert archive.status_code == 200 and archive.json()["archived"] is True
    assert shot.json()["url"] not in [i["url"] for i in after.json()["items"]]
    assert shot.json()["url"] in [i["url"] for i in with_archived.json()["items"]]
    t = None
    async with client() as c:
        _, _, sess2 = await new_admin(c, mail)
        t = await bh.connect(c, sess2["access_token"])
    async with bh.mcp_client(t["access_token"]) as mcp:
        files = await mcp.call_tool("list_media", {"kind": "file"})
        demos = await mcp.call_tool("list_media", {"tag": "demo"})
    assert [i["alt"] for i in files.structured_content["items"]] == ["คู่มือ PDF"]
    assert set(files.structured_content["items"][0]) >= {"url", "alt", "description", "tags", "width", "height", "markdown"}
    if demo is not None:
        assert [i["poster_url"] for i in demos.structured_content["items"]] == [demo.json()["poster_url"]]


def test_library_rejects_by_content():
    with pytest.raises(library.LibraryRejected):
        library.process(b"<svg onload=alert(1)>", "screenshot")
    with pytest.raises(library.LibraryRejected):
        library.process(b"%PDF-1.4 truncated", "file")
    with pytest.raises(library.LibraryRejected):
        library.process(_png(), "file")


# ── brief + content plan ─────────────────────────────────────────────────────


async def test_brief_plan_site_info_and_mark_topic_done(mail):
    async with client() as c:
        _, _, sess = await new_admin(c, mail)
        h = bearer(sess["access_token"])
        empty = await c.get("/admin/blog/brief", headers=h)
        saved = await c.put("/admin/blog/brief", json={
            "tone": "เป็นกันเอง ตรงไปตรงมา", "focus_topics": "ซับไทย", "avoid_topics": "การเมือง", "length": "900–1200 คำ",
            "media": "visual 2–3 ชิ้น", "monthly_note": "เดือนนี้เน้นคลิปรีวิว",
        }, headers=h)
        vendor = await c.put("/admin/blog/brief", json={"tone": "เขียนแบบ ChatGPT"}, headers=h)
        a = (await c.post("/admin/blog/plan", json={"topic": "t-blog-ซับไทยอ่านง่าย", "notes": "เน้นมือใหม่"}, headers=h)).json()
        b = (await c.post("/admin/blog/plan", json={"topic": "t-blog-ตัดคลิปยาวเป็นสั้น"}, headers=h)).json()
        cc = (await c.post("/admin/blog/plan", json={"topic": "t-blog-หัวข้อที่ข้าม"}, headers=h)).json()
        order = await c.put("/admin/blog/plan/order", json={"ids": [b["id"], a["id"], cc["id"]]}, headers=h)
        bad_order = await c.put("/admin/blog/plan/order", json={"ids": [a["id"]]}, headers=h)
        skip = await c.patch(f"/admin/blog/plan/{cc['id']}", json={"status": "skipped"}, headers=h)
        t = await bh.connect(c, sess["access_token"])
    assert empty.json()["updated_at"] is None and empty.json()["tone"] == ""
    assert saved.status_code == 200 and saved.json()["updated_at"] and saved.json()["monthly_note"] == "เดือนนี้เน้นคลิปรีวิว"
    assert vendor.status_code == 400
    assert [i["id"] for i in order.json() if i["topic"].startswith("t-blog-")] == [b["id"], a["id"], cc["id"]]
    assert bad_order.status_code == 400 and skip.json()["status"] == "skipped"
    slug = f"{bh.PREFIX}plan"
    args = await bh.full_post_args(slug, f"mcp:{t['client_id']}")
    async with bh.mcp_client(t["access_token"]) as mcp:
        info = (await mcp.call_tool("get_site_info", {})).structured_content
        early = await mcp.call_tool("mark_topic_done", {"topic_id": b["id"], "slug": slug})
        created = await mcp.call_tool("create_post", args)
        done = await mcp.call_tool("mark_topic_done", {"topic_id": b["id"], "slug": slug})
        skipped = await mcp.call_tool("mark_topic_done", {"topic_id": cc["id"], "slug": slug})
        info2 = (await mcp.call_tool("get_site_info", {})).structured_content
    assert info["brief"]["tone"] == "เป็นกันเอง ตรงไปตรงมา" and info["brief"]["updated_at"]
    open_topics = [i["topic"] for i in info["content_plan"] if i["topic"].startswith("t-blog-")]
    assert open_topics == ["t-blog-ตัดคลิปยาวเป็นสั้น", "t-blog-ซับไทยอ่านง่าย"]  # in order; skipped one hidden
    brand = info["brand"]
    assert brand["colors"]["primary"] == "#b68235" and brand["colors"]["dark_theme"]["bg"] == "#171614"
    assert [f["family"] for f in brand["fonts"]] == ["Noto Sans Thai", "IBM Plex Sans Thai"]
    assert brand["fonts"][0]["urls"][0].startswith(get_settings().blog_embed_origin + "/fonts/")
    assert brand["visual"]["recommended_sizes"]["infographic"] == {"width": 1600, "height": 1000}
    assert brand["examples"]["visual"]["html"] and brand["examples"]["cover"]["css"]
    assert "get_icons" in brand["icons"]["how"]
    assert early.is_error and not created.is_error and not done.is_error and skipped.is_error
    assert done.structured_content["topic"]["post_slug"] == slug
    assert [i["topic"] for i in info2["content_plan"] if i["topic"].startswith("t-blog-")] == ["t-blog-ซับไทยอ่านง่าย"]
    audit = await db("SELECT ok FROM core.blog_audit_log WHERE action = 'mark_topic_done' ORDER BY id")
    assert [r[0] for r in audit][-3:] == [False, True, False]


async def test_logo_is_made_once(mail):
    from packages.blog.logo import logo_asset

    async with await _session() as s:
        first = await logo_asset(s)
        await s.commit()
    async with await _session() as s:
        second = await logo_asset(s)
    assert first["svg_inline"].startswith("<svg") and first["url"] == second["url"]
    if first["url"]:  # the renderer is installed locally
        assert (first["width"], first["height"]) == (512, 512)
        n = await db("SELECT count(*) FROM core.blog_images WHERE origin = 'brand'")
        assert n[0][0] == 1
    await db("DELETE FROM core.blog_images WHERE origin = 'brand'")


# ── tools, limits, guard ─────────────────────────────────────────────────────


async def test_upload_image_is_capped_at_300_kb(mail):
    async with client() as c:
        _, _, sess = await new_admin(c, mail)
        t = await bh.connect(c, sess["access_token"])
    big = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 240_000).decode()
    async with bh.mcp_client(t["access_token"]) as mcp:
        tools = {tool.name: tool for tool in (await mcp.list_tools()).tools}
        r = await mcp.call_tool("upload_image", {"image_base64": big, "filename": "x.png", "alt": "ภาพใหญ่เกิน"})
    assert tools["upload_image"].input_schema["properties"]["image_base64"]["maxLength"] == 300 * 1024
    assert "create_visual" in tools["upload_image"].description and "render_cover" in tools["upload_image"].description
    assert r.is_error


async def test_icons_tool(mail):
    async with client() as c:
        _, _, sess = await new_admin(c, mail)
        t = await bh.connect(c, sess["access_token"])
    async with bh.mcp_client(t["access_token"]) as mcp:
        r = (await mcp.call_tool("get_icons", {"names": ["scissors", "no-such-icon"], "size": 64, "color": "#d9a441"})).structured_content
    assert r["icons"]["scissors"].startswith('<svg xmlns="http://www.w3.org/2000/svg" width="64"') and 'stroke="#d9a441"' in r["icons"]["scissors"]
    assert "no-such-icon" in r["unknown"]


def test_new_admin_routes_are_in_the_security_walk():
    walked = set(PROTECTED)
    assert {
        ("GET", "/admin/blog/media"), ("POST", "/admin/blog/media"), ("PATCH", "/admin/blog/media/{item_id}"),
        ("GET", "/admin/blog/brief"), ("PUT", "/admin/blog/brief"), ("GET", "/admin/blog/plan"),
        ("POST", "/admin/blog/plan"), ("PUT", "/admin/blog/plan/order"), ("PATCH", "/admin/blog/plan/{item_id}"),
        ("DELETE", "/admin/blog/plan/{item_id}"),
    } <= walked


@pytest.mark.skipif(shutil.which("node") is None, reason="node is needed to read noey-frontend's CSS")
def test_brand_json_matches_the_site():
    import sys

    r = subprocess.run([sys.executable, "scripts/build_brand_info.py", "--check"], capture_output=True, text=True, timeout=60, check=False)
    assert r.returncode == 0, r.stderr
