"""End-to-end check of the blog's pictures against a RUNNING local API and site.

Through the real MCP client (OAuth like a claude.ai connector, see
scripts/blog_mcp_e2e.py): get_site_info (brand, brief, plan), get_icons,
list_media, render_cover (Thai, gradient, shadow, icon), create_visual (a
still infographic with a real screenshot in a phone frame, and an animation),
create_post → publish_post → mark_topic_done; then the refusals (an <iframe>,
an outside image, four animated visuals). Through the admin API: the media
library (a real screenshot of the site, a demo clip recorded from the site,
a PDF), the brief and a content-plan topic.

A second post holds 6 visuals (3 animated) for the page performance check
(scripts/blog_media_page_check.py). The posts are kept so a browser can open
them; `--cleanup` removes everything this script made.

Start the API (from backend/) with the embed origin on another host name:
    API_PUBLIC_URL=http://localhost:8030 BLOG_EMBED_PUBLIC_URL=http://127.0.0.1:8030 \\
    BLOG_EMBED_DEV_ANCESTORS=http://localhost:3260 SITE_URL=http://localhost:3260 \\
    BLOG_REVALIDATE_SECRET=e2e-secret S3_BUCKET= uvicorn services.api.main:app --port 8030
and the site on :3260 (docs/blog-mcp.md §5), then:
    python scripts/blog_media_e2e.py --api http://localhost:8030 --site http://localhost:3260 --out /tmp/blogmedia
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import blog_mcp_e2e as base
import httpx
from mcp import Client
from mcp.client.auth import OAuthClientProvider
from mcp.shared.auth import AuthorizationCodeResult, OAuthClientMetadata

from packages.blog import kit
from packages.core.settings import get_settings, is_local_deployment

step = base.step


def _text(result) -> str:  # type: ignore[no-untyped-def]
    return " ".join(getattr(b, "text", "") for b in result.content)


# ── what the writer draws ────────────────────────────────────────────────────


def cover_markup() -> dict[str, str]:
    icon = kit.icon_svg("clapperboard", size=120, color="#d9a441", stroke=1.75)
    return {
        "html": (
            '<div class="bg"><div class="glow"></div>'
            f'<div class="row">{icon}<div class="brand">Noey Studio · บทความ</div></div>'
            '<div class="title">ตัดคลิปรีวิวสินค้าให้ไวขึ้น ด้วยดราฟต์แรกจาก AI</div>'
            '<div class="sub">ถ่ายให้ระบบคัดช็อตง่าย แล้วเกลาจังหวะเองในไทม์ไลน์</div>'
            '<div class="card">ซับไทย · ตัดช่วงเงียบ · ส่งออกแนวตั้ง</div></div>'
        ),
        "css": (
            ".bg{display:flex;flex-direction:column;justify-content:center;position:relative;width:1600px;height:900px;"
            "padding:0 120px;background:linear-gradient(135deg,#171614 0%,#3a270d 55%,#7d5411 100%);color:#f3f2f2}"
            ".glow{position:absolute;right:-160px;top:-160px;width:640px;height:640px;border-radius:320px;"
            "background:radial-gradient(circle,rgba(217,164,65,0.55) 0%,rgba(217,164,65,0) 70%)}"
            ".row{display:flex;align-items:center;margin-bottom:36px}"
            ".brand{display:flex;margin-left:28px;font-size:40px;font-weight:600;color:#d9a441}"
            ".title{display:flex;font-size:92px;font-weight:700;line-height:1.25;max-width:1300px;"
            "text-shadow:0 10px 30px rgba(0,0,0,0.55)}"
            ".sub{display:flex;margin-top:28px;font-size:42px;color:#d5d1ca}"
            ".card{display:flex;margin-top:48px;padding:22px 36px;border-radius:24px;background:#f3f2f2;color:#201f1d;"
            "font-size:36px;font-weight:600;box-shadow:0 24px 60px rgba(0,0,0,0.45);align-self:flex-start}"
        ),
    }


def infographic(screenshot_url: str) -> dict[str, object]:
    icons = {n: kit.icon_svg(n, size=72, color="#b68235", stroke=2) for n in ("upload", "scissors", "captions")}
    steps = [("upload", "อัปโหลดฟุตเทจ", "คลิปจากมือถือหลายไฟล์"), ("scissors", "ได้ดราฟต์แรก", "ระบบคัดช็อตและตัดช่วงเงียบ"), ("captions", "เกลาแล้วส่งออก", "แก้ซับไทยและจังหวะในไทม์ไลน์")]
    cards = "".join(
        f'<div class="step"><div class="ic">{icons[i]}</div><div><b>{n + 1}. {t}</b><p>{d}</p></div></div>'
        for n, (i, t, d) in enumerate(steps)
    )
    return {
        "html": (
            '<div class="wrap"><h2>ตัดคลิปรีวิวใน 3 ขั้น</h2><div class="cols">'
            f'<div class="steps">{cards}</div>'
            f'<div class="phone"><img src="{screenshot_url}" alt=""></div></div></div>'
        ),
        "css": (
            ".wrap{position:absolute;inset:0;background:#f3f2f2;color:#201f1d;padding:80px 96px;font-family:'Noto Sans Thai'}"
            "h2{margin:0 0 48px;font-size:76px;font-weight:700}"
            ".cols{display:flex;gap:64px;align-items:flex-start}.steps{flex:1;display:flex;flex-direction:column;gap:28px}"
            ".step{display:flex;gap:28px;align-items:center;background:#fff;border-radius:28px;padding:28px 32px;"
            "box-shadow:0 12px 32px rgba(32,31,29,.08)}"
            ".ic{width:112px;height:112px;border-radius:28px;background:#fff3e4;display:grid;place-items:center;flex:none}"
            "b{font-size:44px;font-weight:600}p{margin:6px 0 0;font-size:32px;color:#605d5d}"
            ".phone{width:420px;height:720px;border-radius:56px;background:#171614;padding:18px;box-shadow:0 30px 60px rgba(0,0,0,.25)}"
            ".phone img{width:100%;height:100%;object-fit:cover;object-position:top;border-radius:40px;display:block}"
        ),
        "width": 1600,
        "height": 1000,
        "alt": "สามขั้นตอนตัดคลิปรีวิว: อัปโหลดฟุตเทจ ได้ดราฟต์แรก แล้วเกลาและส่งออก ข้างภาพหน้าจอเว็บ Noey Studio ในกรอบมือถือ",
        "caption": "ขั้นตอนทั้งหมดในหน้าเดียว",
        "animated": False,
    }


def timeline_animation(seed: int = 0) -> dict[str, object]:
    colors = ["#b68235", "#e1ad66", "#7d5411", "#c28d41"]
    segs = "".join(
        f'<div class="seg" style="flex:{w};background:{colors[(i + seed) % 4]}"><span>{label}</span></div>'
        for i, (w, label) in enumerate([(3, "ฮุก"), (5, "รีวิวสินค้า"), (4, "สาธิตการใช้"), (2, "ปิดการขาย")])
    )
    return {
        "html": f'<div class="wrap"><h2>จังหวะคลิปรีวิว 30 วินาที</h2><div class="track">{segs}<div class="head"></div></div>'
                '<div class="cap"><span class="dot"></span>ดราฟต์แรกจากระบบ แล้วคุณเกลาต่อ</div></div>',
        "css": (
            ".wrap{position:absolute;inset:0;background:#171614;color:#f3f2f2;padding:96px;font-family:'Noto Sans Thai'}"
            "h2{margin:0 0 72px;font-size:72px;font-weight:700}"
            ".track{position:relative;display:flex;gap:10px;height:220px}"
            ".seg{border-radius:22px;display:flex;align-items:flex-end;padding:22px;font-size:38px;font-weight:600;color:#171614}"
            ".head{position:absolute;top:-24px;bottom:-24px;left:0;width:8px;border-radius:4px;background:#f3f2f2;"
            "box-shadow:0 0 24px rgba(243,242,242,.8);animation:play 6s linear infinite}"
            "@keyframes play{from{transform:translateX(0)}to{transform:translateX(1400px)}}"
            ".cap{display:flex;align-items:center;gap:20px;margin-top:80px;font-size:40px;color:#bdb8b0}"
            ".dot{width:24px;height:24px;border-radius:12px;background:#d9a441;animation:pulse 1.5s ease-in-out infinite}"
            "@keyframes pulse{50%{opacity:.25;transform:scale(.7)}}"
        ),
        "width": 1600,
        "height": 900,
        "alt": "แถบไทม์ไลน์คลิปรีวิวแบ่งเป็นฮุก รีวิวสินค้า สาธิตการใช้ และปิดการขาย มีหัวเล่นวิ่งผ่านแต่ละช่วง",
        "animated": True,
    }


def still_chart(n: int) -> dict[str, object]:
    items = ["ถ่ายแนวตั้ง", "แสงพอ", "เสียงชัด", "ช็อตสินค้าใกล้", "จบด้วยคำชวน"]
    rows = "".join(f'<li><span class="k">{i + 1}</span>{t}</li>' for i, t in enumerate(items[: 3 + n % 3]))
    return {
        "html": f'<div class="wrap"><h2>เช็กลิสต์ก่อนถ่าย #{n}</h2><ul>{rows}</ul></div>',
        "css": (
            ".wrap{position:absolute;inset:0;background:#fff3e4;color:#201f1d;padding:80px;font-family:'IBM Plex Sans Thai'}"
            "h2{margin:0 0 40px;font-size:64px}ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:22px}"
            "li{display:flex;align-items:center;gap:24px;font-size:44px;background:#fff;border-radius:20px;padding:18px 28px}"
            ".k{width:64px;height:64px;border-radius:32px;background:#b68235;color:#fff;display:grid;place-items:center;font-weight:700}"
        ),
        "width": 1200,
        "height": 1200,
        "alt": f"เช็กลิสต์ก่อนถ่ายคลิปชุดที่ {n}: ถ่ายแนวตั้ง แสงพอ เสียงชัด",
        "animated": False,
    }


# ── the library: real files from the running site ────────────────────────────


def site_screenshot(site: str) -> bytes:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 430, "height": 760}, device_scale_factor=2)
        page.goto(site, wait_until="networkidle")
        png = page.screenshot()
        browser.close()
    return png


def site_clip(site: str) -> bytes:
    """A short demo: the site scrolled in a recorded browser, as H.264 MP4."""
    from playwright.sync_api import sync_playwright

    from packages.video.ffmpeg_bin import ffmpeg_cmd

    with tempfile.TemporaryDirectory() as tmp, sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 960, "height": 540}, record_video_dir=tmp, record_video_size={"width": 960, "height": 540})
        page = ctx.new_page()
        page.goto(f"{site}/guide", wait_until="networkidle")
        for _ in range(12):
            page.mouse.wheel(0, 180)
            page.wait_for_timeout(250)
        ctx.close()
        browser.close()
        webm = next(Path(tmp).glob("*.webm"))
        out = Path(tmp) / "demo.mp4"
        subprocess.run(
            [ffmpeg_cmd(), "-v", "error", "-y", "-i", str(webm), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "26", "-an", str(out)],
            check=True, timeout=120,
        )
        return out.read_bytes()


def tiny_pdf() -> bytes:
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (1240, 1754), "white")
    ImageDraw.Draw(img).rectangle((100, 100, 1140, 300), fill=(182, 130, 53))
    out = io.BytesIO()
    img.save(out, format="PDF")
    return out.getvalue()


# ── the run ──────────────────────────────────────────────────────────────────


async def run(api: str, site: str, out_dir: Path, cleanup_only: bool) -> int:
    s = get_settings()
    if not is_local_deployment(s.postgres_host):
        print("refusing: POSTGRES_HOST is not a local database", file=sys.stderr)
        return 2
    out_dir.mkdir(parents=True, exist_ok=True)
    state_file = out_dir / "e2e-state.json"
    if cleanup_only:
        return await cleanup(json.loads(state_file.read_text()))
    user_id, admin_token = await base.temp_admin()
    admin = {"Authorization": f"Bearer {admin_token}"}
    http = httpx.AsyncClient(base_url=api, timeout=120)
    storage = base.MemoryStorage()
    pending: dict[str, str] = {}
    stamp = int(time.time())
    slug, perf_slug = f"blog-media-e2e-{stamp}", f"blog-media-perf-{stamp}"
    state: dict[str, object] = {"user_id": user_id, "slugs": [slug, perf_slug]}
    print(f"blog media e2e: API {api}, site {site}")

    # The owner's side: library, brief, plan.
    shot = await asyncio.to_thread(site_screenshot, site)
    (out_dir / "library-screenshot.png").write_bytes(shot)
    r = await http.post("/admin/blog/media", headers=admin, data={"kind": "screenshot", "alt": "หน้าแรกของ Noey Studio บนมือถือ", "description": "ภาพหน้าจอจริงของหน้าแรก", "tags": "homepage,mobile"}, files={"file": ("home.png", shot, "image/png")})
    assert r.status_code == 200, r.text
    screenshot = r.json()
    step(f"admin library: screenshot {screenshot['width']}×{screenshot['height']} → {screenshot['url']}")
    clip = await asyncio.to_thread(site_clip, site)
    r = await http.post("/admin/blog/media", headers=admin, data={"kind": "demo", "alt": "เลื่อนดูหน้าคู่มือการใช้งาน", "tags": "demo"}, files={"file": ("demo.mp4", clip, "video/mp4")})
    assert r.status_code == 200, r.text
    demo = r.json()
    step(f"admin library: demo clip {demo['width']}×{demo['height']} {demo['duration_sec']} s → {demo['url']} (poster {demo['poster_url'].rsplit('/', 1)[1][:12]}…)")
    r = await http.post("/admin/blog/media", headers=admin, data={"kind": "file", "alt": "เช็กลิสต์ก่อนถ่ายคลิป (PDF)"}, files={"file": ("checklist.pdf", tiny_pdf(), "application/pdf")})
    assert r.status_code == 200, r.text
    pdf = r.json()
    step(f"admin library: PDF → {pdf['url']}")
    exe = await http.post("/admin/blog/media", headers=admin, data={"kind": "file", "alt": "ไฟล์ปลอม"}, files={"file": ("x.pdf", b"MZ\x90\x00", "application/pdf")})
    step(f"admin library: an EXE named .pdf → {exe.status_code} {exe.json()['detail']}")
    r = await http.put("/admin/blog/brief", headers=admin, json={"tone": "เป็นกันเอง ตรงไปตรงมา", "focus_topics": "คลิปรีวิวสินค้า", "avoid_topics": "การเมือง", "length": "900–1200 คำ", "media": "ภาพประกอบ 2–3 ชิ้น", "monthly_note": "เดือนนี้เน้นคลิปรีวิว"})
    assert r.status_code == 200, r.text
    topic = (await http.post("/admin/blog/plan", headers=admin, json={"topic": "ตัดคลิปรีวิวสินค้าให้ไวขึ้น", "notes": "ใส่ภาพหน้าจอจริง"})).json()
    state.update({"topic_id": topic["id"], "media_ids": [screenshot["id"], demo["id"], pdf["id"]]})
    step(f"admin: brief saved, plan topic #{topic['id']}")

    async def redirect_handler(url: str) -> None:
        a = await http.get(url.replace(s.api_public_url.rstrip("/"), ""), follow_redirects=False)
        request_id = parse_qs(urlsplit(a.headers["location"]).query)["request"][0]
        ok = await http.post(f"/admin/blog/oauth/requests/{request_id}/approve", headers=admin)
        pending.update({k: v[0] for k, v in parse_qs(urlsplit(ok.json()["redirect_to"]).query).items()})

    async def callback_handler() -> AuthorizationCodeResult:
        return AuthorizationCodeResult(code=pending["code"], state=pending.get("state"), iss=pending.get("iss"))

    auth = OAuthClientProvider(
        server_url=f"{api}/mcp",
        client_metadata=OAuthClientMetadata(
            client_name="Noey blog media e2e", redirect_uris=[base.CALLBACK],  # type: ignore[list-item]
            grant_types=["authorization_code", "refresh_token"], response_types=["code"], token_endpoint_auth_method="none",
        ),
        storage=storage, redirect_handler=redirect_handler, callback_handler=callback_handler,
    )
    import httpx2
    from mcp.client.streamable_http import streamable_http_client

    try:
        async with httpx2.AsyncClient(auth=auth, timeout=60) as mcp_http, Client(streamable_http_client(f"{api}/mcp", http_client=mcp_http)) as mcp:
            assert storage.client is not None
            state["client_id"] = storage.client.client_id
            info = (await mcp.call_tool("get_site_info", {})).structured_content
            brand = info["brand"]
            step(f"get_site_info: brand primary {brand['colors']['primary']}, fonts {[f['family'] for f in brand['fonts']]}, logo {brand['logo']['url']}")
            step(f"get_site_info: brief updated_at {info['brief']['updated_at']}, open topics {[t['topic'] for t in info['content_plan']]}")
            media = (await mcp.call_tool("list_media", {})).structured_content
            step(f"list_media: {[(m['kind'], m['type']) for m in media['items']]}")
            icons = (await mcp.call_tool("get_icons", {"names": ["clapperboard", "scissors"]})).structured_content
            step(f"get_icons: {sorted(icons['icons'])}")

            t0 = time.monotonic()
            rc = await mcp.call_tool("render_cover", {**cover_markup(), "alt": "ปก: ตัดคลิปรีวิวสินค้าให้ไวขึ้น ด้วยดราฟต์แรกจาก AI"})
            assert not rc.is_error, _text(rc)
            cover = rc.structured_content
            step(f"render_cover → {cover['width']}×{cover['height']} in {time.monotonic() - t0:.2f} s → {cover['url']}")
            (out_dir / "cover.webp").write_bytes((await http.get(cover["url"].replace(api, ""))).content)
            bad_cover = await mcp.call_tool("render_cover", {"html": '<div style="display:grid">🎬</div><script>x()</script>', "css": ".a{animation:x 1s}", "alt": "ปกที่ผิดกฎ"})
            step(f"render_cover refused:\n{_text(bad_cover)}")

            v1 = await mcp.call_tool("create_visual", infographic(screenshot["url"]))
            assert not v1.is_error, _text(v1)
            v2 = await mcp.call_tool("create_visual", timeline_animation())
            assert not v2.is_error, _text(v2)
            step(f"create_visual → {v1.structured_content['markdown']} and {v2.structured_content['markdown']}")
            bad_visual = await mcp.call_tool("create_visual", {"html": '<iframe src="https://evil.example"></iframe><a href="/x">x</a>', "css": "@import 'https://evil.example/x.css';", "width": 1600, "height": 1000, "alt": "ภาพผิดกฎ", "animated": False})
            step(f"create_visual refused:\n{_text(bad_visual)}")

            article = base._article()
            article["content_md"] = article["content_md"].replace(
                "## ขั้นที่ 2",
                f"{v1.structured_content['markdown']}\n\n## ขั้นที่ 2",
            ).replace(
                "## ขั้นที่ 5",
                f"![{screenshot['alt']}]({screenshot['url']} \"หน้าแรกบนมือถือ\")\n\n{v2.structured_content['markdown']}\n\n## ขั้นที่ 5",
            ) + f"\n\n## ดูการใช้งานจริง\n\n![{demo['alt']}]({demo['url']})\n\nดาวน์โหลด [{pdf['alt']}]({pdf['url']}) ไว้ใช้ก่อนถ่าย\n"
            created = await mcp.call_tool("create_post", {"slug": slug, **article, "cover_image_url": cover["url"], "cover_alt": "ปก: ตัดคลิปรีวิวสินค้าให้ไวขึ้น"})
            assert not created.is_error, _text(created)
            published = await mcp.call_tool("publish_post", {"slug": slug})
            assert not published.is_error, _text(published)
            step(f"create_post + publish_post → {published.structured_content['outcome']} {published.structured_content['url']}")
            done = await mcp.call_tool("mark_topic_done", {"topic_id": topic["id"], "slug": slug})
            assert not done.is_error, _text(done)
            step(f"mark_topic_done → {done.structured_content['topic']['status']} /blog/{done.structured_content['topic']['post_slug']}")

            # The refusals (spec §9).
            iframe_post = {**article, "content_md": article["content_md"] + '\n\n<iframe src="https://evil.example"></iframe>\n'}
            r1 = await mcp.call_tool("create_post", {"slug": f"{slug}-iframe", **iframe_post, "cover_image_url": cover["url"], "cover_alt": "ปก"})
            outside = {**article, "content_md": article["content_md"] + "\n\n![ภาพนอก](https://evil.example/a.png)\n"}
            r2 = await mcp.call_tool("create_post", {"slug": f"{slug}-outside", **outside, "cover_image_url": cover["url"], "cover_alt": "ปก"})
            anims = [await mcp.call_tool("create_visual", timeline_animation(seed)) for seed in (1, 2, 3)]
            four = {**article, "content_md": article["content_md"] + "\n\n" + "\n\n".join(a.structured_content["markdown"] for a in anims) + "\n"}
            r3 = await mcp.call_tool("create_post", {"slug": f"{slug}-anim", **four, "cover_image_url": cover["url"], "cover_alt": "ปก"})
            no_cover = await mcp.call_tool("create_post", {"slug": f"{slug}-nocover", **base._article()})
            for name, res in (("<iframe>", r1), ("outside image", r2), ("4 animated", r3), ("no cover / no pictures", no_cover)):
                assert res.is_error, name
                step(f"create_post with {name} refused:\n{_text(res)}")

            # The performance post: 6 visuals, 3 of them animated.
            visuals = [v1.structured_content["markdown"], v2.structured_content["markdown"], anims[0].structured_content["markdown"], anims[1].structured_content["markdown"]]
            for n in (1, 2):
                vs = await mcp.call_tool("create_visual", still_chart(n))
                assert not vs.is_error, _text(vs)
                visuals.append(vs.structured_content["markdown"])
            perf = base._article()
            parts = perf["content_md"].split("\n\n## ")
            body = parts[0] + "".join(f"\n\n## {p}\n\n{visuals[i]}" if i < len(visuals) else f"\n\n## {p}" for i, p in enumerate(parts[1:]))
            perf.update({"content_md": body, "title": "เช็กลิสต์ภาพประกอบหกชิ้นสำหรับคลิปรีวิว", "meta_title": "เช็กลิสต์ภาพประกอบหกชิ้น | Noey Studio"})
            cp = await mcp.call_tool("create_post", {"slug": perf_slug, **perf, "cover_image_url": cover["url"], "cover_alt": "ปกบทความ"})
            assert not cp.is_error, _text(cp)
            pp = await mcp.call_tool("publish_post", {"slug": perf_slug})
            assert not pp.is_error, _text(pp)
            step(f"performance post /blog/{perf_slug}: {len(visuals)} visuals, 3 animated → {pp.structured_content['outcome']}")

        one = (await http.get(f"/blog/posts/{slug}")).json()
        step(f"GET /blog/posts/{slug} media: {[m['type'] for m in one['media']]}")
        audit = (await http.get("/admin/blog/audit?limit=200", headers=admin)).json()
        counts: dict[str, list[int]] = {}
        for a in audit:
            if a["action"] in ("create_visual", "render_cover", "admin_media_upload", "mark_topic_done", "create_post"):
                counts.setdefault(a["action"], [0, 0])[0 if a["ok"] else 1] += 1
        step(f"audit log (ok, refused): {counts}")
        state.update({"slug": slug, "perf_slug": perf_slug})
        state_file.write_text(json.dumps(state, indent=2))
        print(f"PASS — open {site}/blog/{slug} and {site}/blog/{perf_slug}")
        return 0
    finally:
        await http.aclose()


async def cleanup(state: dict) -> int:
    from sqlalchemy import text

    from packages.db.session import get_engine

    async with get_engine().begin() as conn:
        for slug in state.get("slugs", []):
            await conn.execute(text("DELETE FROM core.blog_post_tags WHERE post_id IN (SELECT id FROM core.blog_posts WHERE slug LIKE :s)"), {"s": f"{slug}%"})
            await conn.execute(text("DELETE FROM core.blog_posts WHERE slug LIKE :s"), {"s": f"{slug}%"})
        if state.get("topic_id"):
            await conn.execute(text("DELETE FROM core.blog_content_plan WHERE id = :i"), {"i": state["topic_id"]})
        if state.get("client_id"):
            await conn.execute(text("DELETE FROM core.blog_visuals WHERE created_by = :c"), {"c": f"mcp:{state['client_id']}"})
            await conn.execute(text("DELETE FROM core.blog_oauth_clients WHERE client_id = :c"), {"c": state["client_id"]})
        for mid in state.get("media_ids", []):
            await conn.execute(text("DELETE FROM core.blog_images WHERE id = :i"), {"i": mid})
    await base.cleanup(int(state["user_id"]), "none", None)  # the temporary admin
    print("cleaned up")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--api", default="http://localhost:8030")
    parser.add_argument("--site", default="http://localhost:3260")
    parser.add_argument("--out", default="/tmp/blogmedia")
    parser.add_argument("--cleanup", action="store_true", help="remove what the last run made (reads <out>/e2e-state.json)")
    a = parser.parse_args()
    return asyncio.run(run(a.api.rstrip("/"), a.site.rstrip("/"), Path(a.out), a.cleanup))


if __name__ == "__main__":
    raise SystemExit(main())
