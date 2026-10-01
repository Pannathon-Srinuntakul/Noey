"""Open the posts scripts/blog_media_e2e.py published on the running site and
check, in Chromium (local verification only — never on the server):

- every visual is the spec's iframe (sandbox="allow-scripts" only, lazy,
  aria-hidden, tabindex -1, no border), scales with the column, shows no
  scrollbar, cannot be clicked (the click lands on the figure) and has its alt
  text in the page; no layout shift (CLS) while the page loads and scrolls;
- a visual scrolled off screen is paused and resumes when back; with
  prefers-reduced-motion it never moves, and the clip does not autoplay;
- the clip autoplays muted and loops, with its poster;
- every image has alt text; the JSON-LD parses and holds the cover + library
  image and a VideoObject, and no visual URL;
- the 6-visual post on a mid-range phone profile (CPU throttled 4×): long
  tasks and frame times while scrolling.

Screenshots and a JSON report go to --out.
    python scripts/blog_media_page_check.py --site http://localhost:3260 --out /tmp/blogmedia
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

CLS_OBSERVER = """
// The site's beta notice (a modal) would cover the article: dismiss it for good.
try { if (window.top === window) localStorage.setItem('noey.beta-notice.v1', JSON.stringify({dismissedAt: Date.now(), forever: true})); } catch (e) {}
window.__cls = 0; window.__shiftSources = [];
new PerformanceObserver(list => { for (const e of list.getEntries()) { if (!e.hadRecentInput) { window.__cls += e.value;
  for (const s of e.sources) if (s.node) window.__shiftSources.push(s.node.nodeName + '.' + (typeof s.node.className === 'string' ? s.node.className : '')); } } })
  .observe({type: 'layout-shift', buffered: true});
window.__long = [];
try { new PerformanceObserver(list => { for (const e of list.getEntries()) window.__long.push(e.duration); }).observe({type: 'longtask', buffered: true}); } catch (e) {}
"""


def frame_state(page: Page, index: int) -> dict:
    frames = [f for f in page.frames if "/visual/" in f.url]
    frame = frames[index]
    return frame.evaluate(
        "() => ({paused: window.noeyVisual ? window.noeyVisual.paused : null,"
        " running: document.getAnimations().filter(a => a.playState === 'running').length,"
        " scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,"
        " scrollH: document.documentElement.scrollHeight, clientH: document.documentElement.clientHeight})"
    )


def check_post(p, site: str, slug: str, out: Path) -> dict:  # type: ignore[no-untyped-def]
    report: dict = {}
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, device_scale_factor=2)
    ctx.add_init_script(CLS_OBSERVER)
    page = ctx.new_page()
    errors: list[str] = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(f"{site}/blog/{slug}", wait_until="networkidle")
    page.screenshot(path=str(out / "page-desktop-top.png"))
    figures = page.locator("figure.visual")
    report["visuals"] = figures.count()
    shots = []
    for i in range(figures.count()):
        fig = figures.nth(i)
        fig.evaluate("el => el.scrollIntoView({block: 'center'})")
        page.wait_for_timeout(1200)
        attrs = fig.locator("iframe").evaluate(
            "f => ({sandbox: f.getAttribute('sandbox'), loading: f.getAttribute('loading'), tabindex: f.getAttribute('tabindex'),"
            " hidden: f.getAttribute('aria-hidden'), border: getComputedStyle(f).borderTopWidth, pe: getComputedStyle(f).pointerEvents,"
            " ratio: f.parentElement.style.aspectRatio, w: f.getBoundingClientRect().width, h: f.getBoundingClientRect().height,"
            " src: f.src, figH: f.parentElement.getBoundingClientRect().height, caption: (f.parentElement.querySelector('figcaption')||{}).textContent || null})"
        )
        alt = fig.locator(".sr-only").inner_text()
        box = fig.bounding_box()
        assert box is not None
        # Where a click in the middle of the picture lands: on the figure
        # (pointer-events: none on the frame), never inside the visual.
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        hit = page.evaluate("([x, y]) => { const e = document.elementFromPoint(x, y); return e.tagName + '.' + e.className; }", [cx, cy])
        page.mouse.click(cx, cy, button="right")
        state = frame_state(page, i)
        fig.screenshot(path=str(out / f"visual-{i + 1}.png"))
        shots.append({**attrs, "alt": alt, "click_lands_on": hit, "state": state})
    report["visual_checks"] = shots
    # Scroll the first animated visual out of view and back.
    page.evaluate("window.scrollTo(0, 0)")
    page.wait_for_timeout(800)
    report["after_scrolling_away"] = [frame_state(page, i)["paused"] for i in range(report["visuals"])]
    # The clip.
    video = page.locator("video.blog-video__clip")
    if video.count():
        video.first.scroll_into_view_if_needed()
        page.wait_for_timeout(2500)
        report["video"] = video.first.evaluate(
            "v => ({autoplay: v.autoplay, muted: v.muted, loop: v.loop, paused: v.paused, time: v.currentTime, poster: !!v.poster,"
            " preload: v.getAttribute('preload'), controls: v.controls, src: v.currentSrc})"
        )
        video.first.screenshot(path=str(out / "video-frame.png"))
    report["images_without_alt"] = page.evaluate("[...document.querySelectorAll('main img')].filter(i => !i.alt).map(i => i.src)")
    report["cls"] = page.evaluate("window.__cls")
    # Which elements moved: the visuals and figures must never be among them.
    report["layout_shift_sources"] = sorted(set(page.evaluate("window.__shiftSources")))
    ld = page.evaluate("[...document.querySelectorAll('script[type=\"application/ld+json\"]')].map(s => s.textContent)")
    parsed = [json.loads(x) for x in ld]
    article = next(n for doc in parsed for n in doc.get("@graph", [doc]) if n.get("@type") == "BlogPosting")
    report["jsonld"] = {
        "image": [i["url"] for i in (article["image"] if isinstance(article["image"], list) else [article["image"]])],
        "video": [{k: v.get(k) for k in ("@type", "name", "contentUrl", "thumbnailUrl", "uploadDate", "duration")} for v in article.get("video", [])],
        "mentions_visual_url": "/visual/" in json.dumps(parsed),
    }
    page.screenshot(path=str(out / "page-desktop-full.png"), full_page=True)
    report["console_errors"] = errors
    ctx.close()
    # Reduced motion: still visuals, a still clip with controls.
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, reduced_motion="reduce")
    ctx.add_init_script(CLS_OBSERVER)
    page = ctx.new_page()
    page.goto(f"{site}/blog/{slug}", wait_until="networkidle")
    states = []
    for i in range(page.locator("figure.visual").count()):
        page.locator("figure.visual").nth(i).scroll_into_view_if_needed()
        page.wait_for_timeout(1000)
        states.append(frame_state(page, i))
    report["reduced_motion_visuals"] = states
    if page.locator("video.blog-video__clip").count():
        v = page.locator("video.blog-video__clip").first
        v.scroll_into_view_if_needed()
        page.wait_for_timeout(1500)
        report["reduced_motion_video"] = v.evaluate("v => ({autoplay: v.autoplay, paused: v.paused, controls: v.controls, time: v.currentTime})")
    ctx.close()
    # Phone width: visuals scale with the column.
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True, has_touch=True)
    ctx.add_init_script(CLS_OBSERVER)
    page = ctx.new_page()
    page.goto(f"{site}/blog/{slug}", wait_until="networkidle")
    page.locator("figure.visual").first.scroll_into_view_if_needed()
    page.wait_for_timeout(1500)
    page.screenshot(path=str(out / "page-mobile-visual.png"))
    report["mobile_visual_box"] = page.locator("figure.visual").first.bounding_box()
    ctx.close()
    browser.close()
    return report


def perf(p, site: str, slug: str, out: Path) -> dict:  # type: ignore[no-untyped-def]
    """A mid-range phone: Moto G-class viewport, CPU throttled 4× through CDP."""
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 412, "height": 869}, device_scale_factor=2.625, is_mobile=True, has_touch=True)
    ctx.add_init_script(CLS_OBSERVER)
    page = ctx.new_page()
    cdp = ctx.new_cdp_session(page)
    cdp.send("Emulation.setCPUThrottlingRate", {"rate": 4})
    page.goto(f"{site}/blog/{slug}", wait_until="networkidle")
    page.wait_for_timeout(1500)
    page.evaluate(
        "window.__frames = []; (function tick(t){ if (window.__last) window.__frames.push(t - window.__last); window.__last = t; requestAnimationFrame(tick); })(performance.now()); window.__long = [];"
    )
    height = page.evaluate("document.documentElement.scrollHeight")
    y = 0
    while y < height:
        page.mouse.wheel(0, 300)
        page.wait_for_timeout(120)
        y += 300
    page.wait_for_timeout(1000)
    frames = page.evaluate("window.__frames")
    longs = page.evaluate("window.__long")
    cls = page.evaluate("window.__cls")
    page.screenshot(path=str(out / "perf-phone.png"))
    ctx.close()
    browser.close()
    frames = [f for f in frames if f > 0]
    return {
        "profile": "412×869 @2.625x, mobile+touch, CPU 4× slower (CDP)",
        "visuals": 6,
        "animated": 3,
        "frames": len(frames),
        "frame_ms_median": round(statistics.median(frames), 1) if frames else None,
        "frame_ms_p95": round(sorted(frames)[int(len(frames) * 0.95) - 1], 1) if frames else None,
        "frames_over_50ms": sum(1 for f in frames if f > 50),
        "long_tasks": len(longs),
        "long_task_ms_total": round(sum(longs)),
        "long_task_ms_max": round(max(longs)) if longs else 0,
        "cls": cls,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--site", default="http://localhost:3260")
    parser.add_argument("--out", default="/tmp/blogmedia")
    a = parser.parse_args()
    out = Path(a.out)
    state = json.loads((out / "e2e-state.json").read_text())
    with sync_playwright() as p:
        report = {"post": check_post(p, a.site.rstrip("/"), state["slug"], out), "perf": perf(p, a.site.rstrip("/"), state["perf_slug"], out)}
    (out / "page-check.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
