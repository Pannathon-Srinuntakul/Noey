"""In-article visuals: HTML that behaves like an image (create_visual).

The writer sends html + css (+ js) and a canvas size. This module checks and
re-serialises them (packages/blog/markup.py), wraps them in the ONE wrapper
below, and stores the finished document under the bucket's `visual/` prefix
(or DATA_DIR/visual without a bucket). Nothing is rendered on the server.

The document is served by the embed origin (services/api/embed.py):

    https://embed.noeystudio.com/visual/<id>

and the site shows it in `<iframe sandbox="allow-scripts">` (no
allow-same-origin): the visual runs in an opaque origin, on a domain with no
cookies and no login, with `connect-src 'none'` — it can draw and animate,
and nothing else. The wrapper makes it behave like a picture:

- the canvas is laid out at its designed size (width × height CSS px) and
  scaled with a CSS transform to the iframe's width, so text and spacing
  scale together like an image;
- no margin, no scrollbars, no selection, no callout, `pointer-events: none`
  on everything, context menu and drag cancelled;
- `postMessage({type: "pause"|"play"})` from the parent page pauses/resumes
  every CSS animation (animation-play-state), Web Animation and
  requestAnimationFrame loop; `prefers-reduced-motion: reduce` keeps it
  paused whatever the parent says.

The id is sha256(creator + document)[:32], so the bytes behind an id never
change: the file is served `immutable` and Cloudflare keeps it at the edge.
"""

from __future__ import annotations

import asyncio
import hashlib
import pathlib
import re
from dataclasses import dataclass

from packages.blog import kit, markup
from packages.core.settings import get_settings
from packages.video import s3
from packages.video.storage import data_root

KEY_PREFIX = "visual/"
ID_RE = re.compile(r"^[0-9a-f]{32}$")

MAX_SOURCE_BYTES = 200 * 1024
MIN_SIDE, MAX_SIDE = 200, 2400
#: Width/height ratio bounds: 1:4 (tall) to 4:1 (wide).
MIN_RATIO, MAX_RATIO = 0.25, 4.0
MAX_ANIMATED_PER_POST = 3
#: Sizes get_site_info recommends (designed canvas, CSS px).
RECOMMENDED = {
    "infographic": {"width": 1600, "height": 1000},
    "wide": {"width": 1600, "height": 900},
    "square": {"width": 1200, "height": 1200},
    "portrait": {"width": 1080, "height": 1350},
}


class VisualRejected(ValueError):
    def __init__(self, problems: list[str]) -> None:
        self.problems = problems
        super().__init__("; ".join(problems))


@dataclass(frozen=True)
class Prepared:
    id: str
    key: str
    document: bytes
    width: int
    height: int


def frame_ancestors() -> list[str]:
    """Who may frame a visual: the site, plus local origins ONLY when the
    BLOG_EMBED_DEV_ANCESTORS flag is set (local testing)."""
    out = ["https://noeystudio.com", "https://www.noeystudio.com"]
    for raw in get_settings().blog_embed_dev_ancestors.split(","):
        origin = raw.strip().rstrip("/")
        if origin and origin not in out:
            out.append(origin)
    return out


def media_origin() -> str:
    from urllib.parse import urlsplit

    from packages.blog import media

    u = urlsplit(media.media_base())
    return f"{u.scheme}://{u.netloc}"


def csp() -> str:
    """Exactly the policy of the spec (§2): scripts and styles only inline,
    images only from the media store (and data:), fonts only from the font
    origin (= the embed origin), no connections, no forms, framed only by
    the site."""
    return (
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
        f"img-src {media_origin()} data:; font-src {get_settings().blog_embed_origin}; connect-src 'none'; "
        f"form-action 'none'; frame-ancestors {' '.join(frame_ancestors())}"
    )


def response_headers() -> dict[str, str]:
    return {
        "Content-Security-Policy": csp(),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "public, max-age=31536000, immutable",
        "Referrer-Policy": "no-referrer",
    }


#: Runs before the writer's script: scaling, the picture behaviour and the
#: pause/play protocol. Kept small and dependency-free.
_WRAPPER_JS = """(function(){
var W=__W__,H=__H__,c=document.getElementById('noey-canvas'),root=document.documentElement;
function fit(){var w=root.clientWidth||window.innerWidth||W;c.style.transform='scale('+(w/W)+')';}
fit();addEventListener('resize',fit);
['contextmenu','dragstart','selectstart'].forEach(function(t){addEventListener(t,function(e){e.preventDefault();},true);});
var rm=window.matchMedia?matchMedia('(prefers-reduced-motion: reduce)'):{matches:false};
var paused=false,queue=[],held=[],raf=window.requestAnimationFrame.bind(window);
window.requestAnimationFrame=function(cb){if(paused){queue.push(cb);return 0;}return raf(cb);};
function set(p){if(rm.matches)p=true;if(p===paused&&p)return;paused=p;root.classList.toggle('noey-paused',p);
try{if(p){held=document.getAnimations().filter(function(a){return a.playState==='running';});held.forEach(function(a){a.pause();});}
else{held.forEach(function(a){try{a.play();}catch(e){}});held=[];var q=queue;queue=[];q.forEach(function(cb){raf(cb);});}}catch(e){}}
addEventListener('message',function(e){if(e.source!==window.parent)return;var d=e.data;if(!d||typeof d!=='object')return;if(d.type==='pause')set(true);else if(d.type==='play')set(false);});
if(rm.addEventListener)rm.addEventListener('change',function(){if(rm.matches)set(true);});
if(rm.matches)set(true);
window.noeyVisual={get paused(){return paused;}};
})();"""


def build_document(*, html: str, css: str, js: str, width: int, height: int, font_origin: str) -> str:
    """The served file: the writer's (already re-serialised) markup inside
    the picture wrapper. `css`/`js` were checked by markup.py."""
    wrapper_css = (
        kit.font_face_css(font_origin)
        + "html,body{margin:0;padding:0;overflow:hidden;background:transparent;height:100%}"
        + f"#noey-canvas{{position:absolute;left:0;top:0;width:{width}px;height:{height}px;overflow:hidden;"
        + f"transform-origin:0 0;font-family:{kit.FONT_STACK};-webkit-font-smoothing:antialiased}}"
    )
    # Applied AFTER the writer's CSS with !important: the picture behaviour
    # cannot be switched off from inside the visual.
    enforce_css = (
        "html,body{margin:0!important;overflow:hidden!important;user-select:none!important;"
        "-webkit-user-select:none!important;-webkit-touch-callout:none!important;cursor:default!important}"
        "*,*::before,*::after{pointer-events:none!important;user-select:none!important;-webkit-user-select:none!important;"
        "-webkit-user-drag:none!important}"
        "html.noey-paused *,html.noey-paused *::before,html.noey-paused *::after{animation-play-state:paused!important}"
        "@media (prefers-reduced-motion: reduce){*,*::before,*::after{animation-play-state:paused!important}}"
    )
    script = _WRAPPER_JS.replace("__W__", str(width)).replace("__H__", str(height))
    return (
        '<!doctype html><html lang="th"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<meta name="robots" content="noindex">'
        f"<style>{wrapper_css}</style><style>{css}</style><style>{enforce_css}</style></head>"
        f'<body><div id="noey-canvas">{html}</div>'
        f"<script>{script}</script>"
        + (f"<script>{js}</script>" if js.strip() else "")
        + "</body></html>"
    )


def prepare(
    *, html: str, css: str, js: str, width: int, height: int, actor: str, media_base: str
) -> tuple[Prepared | None, list[str], list[str]]:
    """(prepared visual or None, problems, media urls referenced). Pure."""
    problems: list[str] = []
    size = len(html.encode()) + len(css.encode()) + len(js.encode())
    if size > MAX_SOURCE_BYTES:
        problems.append(f"html + css + js is {size // 1024} KB; the limit is {MAX_SOURCE_BYTES // 1024} KB. Simplify it.")
    if not (MIN_SIDE <= width <= MAX_SIDE and MIN_SIDE <= height <= MAX_SIDE):
        problems.append(f"width/height must each be {MIN_SIDE}–{MAX_SIDE} (the designed canvas, e.g. 1600×1000).")
    elif not MIN_RATIO <= width / height <= MAX_RATIO:
        problems.append("the canvas is too narrow or too wide — keep width:height between 1:4 and 4:1.")
    result = markup.sanitize(html, css, mode="visual", media_base=media_base)
    markup.check_js(js, media_base, result)
    problems += result.problems
    if problems:
        return None, problems, result.media_urls
    document = build_document(
        html=result.html, css=result.css, js=js, width=width, height=height, font_origin=get_settings().blog_embed_origin
    ).encode()
    vid = hashlib.sha256(actor.encode() + b"\0" + document).hexdigest()[:32]
    return Prepared(id=vid, key=f"{KEY_PREFIX}{vid}.html", document=document, width=width, height=height), [], result.media_urls


# ── storage ──────────────────────────────────────────────────────────────────


def local_dir() -> pathlib.Path:
    return data_root() / "visual"


def _put_s3(key: str, body: bytes) -> None:
    s3._client().put_object(
        Bucket=s3._bucket(), Key=key, Body=body, ContentType="text/html; charset=utf-8",
        CacheControl="public, max-age=31536000, immutable",
    )


def _get_s3(key: str) -> bytes | None:
    try:
        obj = s3._client().get_object(Bucket=s3._bucket(), Key=key)
    except Exception:  # noqa: BLE001 — NoSuchKey and transport errors alike: not served
        return None
    body: bytes = obj["Body"].read()
    return body


async def store(p: Prepared) -> None:
    if s3.s3_enabled():
        await asyncio.to_thread(_put_s3, p.key, p.document)
        return
    folder = local_dir()
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{p.id}.html"
    if not target.exists():
        tmp = target.with_suffix(".part")
        tmp.write_bytes(p.document)
        tmp.replace(target)


async def read(visual_id: str) -> bytes | None:
    if not ID_RE.match(visual_id):
        return None
    if s3.s3_enabled():
        return await asyncio.to_thread(_get_s3, f"{KEY_PREFIX}{visual_id}.html")
    path = local_dir() / f"{visual_id}.html"
    return path.read_bytes() if path.is_file() else None


def public_url(visual_id: str) -> str:
    return f"{get_settings().blog_embed_public_url.rstrip('/')}/visual/{visual_id}"


def markdown_for(visual_id: str, alt: str) -> str:
    safe = alt.replace("[", "(").replace("]", ")").replace("\n", " ").strip()
    return f"::visual[{safe}]({visual_id})"


def example() -> dict[str, str | int | bool]:
    """A minimal working create_visual call (get_site_info brand.examples)."""
    return {
        "width": 1600,
        "height": 1000,
        "alt": "สามขั้นตอนตัดคลิปรีวิว: อัปโหลด ตรวจไทม์ไลน์ ส่งออก",
        "animated": True,
        "html": (
            '<div class="card"><h2>ตัดคลิปรีวิวใน 3 ขั้น</h2><ol>'
            "<li>อัปโหลดฟุตเทจ</li><li>ตรวจไทม์ไลน์</li><li>ส่งออก</li></ol>"
            '<div class="bar"></div></div>'
        ),
        "css": (
            ".card{position:absolute;inset:0;background:#f3f2f2;color:#201f1d;padding:96px;"
            "font-family:'Noto Sans Thai'}h2{font-size:84px;font-weight:700;margin:0 0 40px}"
            "li{font-size:52px;margin:12px 0}.bar{position:absolute;left:96px;bottom:96px;height:16px;"
            "width:0;background:#b68235;border-radius:8px;animation:grow 4s ease-in-out infinite}"
            "@keyframes grow{to{width:1408px}}"
        ),
        "js": "",
    }
