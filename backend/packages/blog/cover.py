"""render_cover: a post's cover as a real image file, drawn without a browser.

    html + css (a subset) → checked here (packages/blog/markup.py, mode "cover")
      → backend/cover_renderer/worker.mjs: satori (→ SVG, text shaped with
        HarfBuzz and drawn as paths) → resvg (→ PNG)
      → Pillow: WebP → the blog media store (`<sha256>.webp`, origin render_cover)

Why a Node process: satori is a JavaScript library (it needs a JS engine with
WebAssembly for its layout and shaping). The lightest reliable way to run it
from this Python service is ONE small, long-lived `node` child per API
process, spoken to in JSON lines over stdin/stdout:

- the fonts are read once when it starts and reused for every render;
- jobs run one at a time per process (an asyncio lock is the queue; at most
  `MAX_WAITING` callers wait, the rest are told to retry);
- every render has a hard 10 s timeout — on timeout, a crash or garbled
  output the child is killed and the next call starts a fresh one;
- it is started on first use and stopped after BLOG_COVER_IDLE_SEC without
  work, so it holds no memory between writing sessions; it also exits by
  itself when its stdin closes (the API process is gone) — no orphans.

Measured RAM is in docs/blog-mcp.md (the budget is ~150 MB per process).
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import io
import json
import os
import pathlib
import time
from bisect import bisect_right
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from packages.blog import kit, markup, media
from packages.core.logging import get_logger
from packages.core.settings import get_settings

log = get_logger(__name__)

WIDTH, HEIGHT = 1600, 900
TIMEOUT_SEC = 10.0
START_TIMEOUT_SEC = 15.0
MAX_WAITING = 3
MAX_SOURCE_BYTES = 100 * 1024
#: Images a cover may embed (media-store WebP, sent to the renderer as PNG).
MAX_IMAGES = 6
WEBP_QUALITY = 90
RENDERER_DIR = pathlib.Path(__file__).resolve().parents[2] / "cover_renderer"
COVERAGE_JSON = kit.FONTS_DIR / "cover-coverage.json"

#: What covers support — the tool description and get_site_info repeat it.
SUPPORTED_CSS = (
    "flexbox layout (display:flex, flex-direction, gap, align-items, justify-content, flex-wrap)",
    "position: relative | absolute with top/left/right/bottom",
    "width/height/min-/max-, padding, margin",
    "linear-gradient / radial-gradient backgrounds, background-color, opacity",
    "border, border-radius, box-shadow, text-shadow",
    "font-family (Noto Sans Thai, IBM Plex Sans Thai), font-size, font-weight 400–700, line-height, letter-spacing, text-align",
    "transform (translate/rotate/scale), filter: blur()",
    "inline <svg> (icons from get_icons), <img> from the media store with width and height",
)
UNSUPPORTED_CSS = (
    "display: grid (and grid-*), inline/inline-block/table layouts — use flexbox",
    "animation, @keyframes, transition — a cover is a still image",
    "JavaScript, event handlers, <script>",
    "external URLs, @import, @font-face, @media",
    "float, columns, position: fixed/sticky, ::before/::after content",
    "emoji and characters outside Thai/Latin — use an inline SVG icon",
    "every <div> with more than one child needs display:flex (or display:none)",
)


class CoverError(Exception):
    """A refused or failed cover; `problems` are fix-it sentences."""

    def __init__(self, problems: list[str] | str, *, code: str = "invalid_cover") -> None:
        self.problems = [problems] if isinstance(problems, str) else list(problems)
        self.code = code
        super().__init__("; ".join(self.problems))


# ── font coverage (no emoji / unknown scripts: they would draw nothing) ─────


@lru_cache(maxsize=1)
def _coverage() -> tuple[list[int], list[int]]:
    data = json.loads(COVERAGE_JSON.read_text(encoding="utf-8"))
    starts = [a for a, _ in data["ranges"]]
    ends = [b for _, b in data["ranges"]]
    return starts, ends


def uncovered(chars: set[str]) -> list[str]:
    starts, ends = _coverage()
    out = []
    for ch in sorted(chars):
        if ch.isspace() or ch in "\u200b‌‍﻿":
            continue
        cp = ord(ch)
        i = bisect_right(starts, cp) - 1
        if i < 0 or cp > ends[i]:
            out.append(ch)
    return out


# ── the renderer process ─────────────────────────────────────────────────────


def _font_list() -> list[dict[str, Any]]:
    return [{"name": family, "file": file, "weight": weight} for family, faces in kit.COVER_FONTS.items() for file, weight in faces]


class _Renderer:
    def __init__(self) -> None:
        self.proc: asyncio.subprocess.Process | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.lock: asyncio.Lock | None = None
        self.waiting = 0
        self.seq = 0
        self.last_used = 0.0
        self.reaper: asyncio.Task[None] | None = None
        self.stderr_task: asyncio.Task[None] | None = None
        self.started_info: dict[str, Any] = {}

    def _bind_loop(self) -> None:
        loop = asyncio.get_running_loop()
        if self.loop is not loop:
            # A new event loop (tests run one per test): the old child and its
            # pipes belong to the dead loop — kill it outright and start over.
            self._kill_sync()
            self.loop, self.lock, self.waiting = loop, asyncio.Lock(), 0

    def _kill_sync(self) -> None:
        proc, self.proc = self.proc, None
        if proc is not None and proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()

    async def _start(self) -> None:
        node = get_settings().blog_cover_node
        if not (RENDERER_DIR / "node_modules").is_dir():
            raise CoverError(
                "The cover renderer is not installed on this server (backend/cover_renderer/node_modules missing).",
                code="renderer_unavailable",
            )
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "NOEY_FONTS_DIR": str(kit.FONTS_DIR),
            "NOEY_COVER_FONTS": json.dumps(_font_list()),
            # The V8 heap stays small: a cover needs a few MB of JS objects;
            # the pixel buffers live outside the heap and are freed per job.
            "NODE_OPTIONS": "--max-old-space-size=96 --max-semi-space-size=2",
        }
        try:
            self.proc = await asyncio.create_subprocess_exec(
                node, str(RENDERER_DIR / "worker.mjs"),
                cwd=str(RENDERER_DIR), env=env,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                limit=32 * 1024 * 1024,
            )
        except FileNotFoundError:
            raise CoverError("The cover renderer cannot start on this server (node is missing).", code="renderer_unavailable") from None
        assert self.proc.stdout is not None
        self.stderr_task = asyncio.create_task(self._drain_stderr(self.proc))
        try:
            line = await asyncio.wait_for(self.proc.stdout.readline(), START_TIMEOUT_SEC)
            info = json.loads(line or b"{}")
        except (TimeoutError, ValueError):
            self._kill_sync()
            raise CoverError("The cover renderer did not start. Try again in a minute.", code="renderer_unavailable") from None
        if not info.get("ready"):
            self._kill_sync()
            raise CoverError("The cover renderer did not start. Try again in a minute.", code="renderer_unavailable")
        self.started_info = info
        log.info("blog_cover_renderer_started", pid=self.proc.pid, memory=info.get("memory"))

    @staticmethod
    async def _drain_stderr(proc: asyncio.subprocess.Process) -> None:
        assert proc.stderr is not None
        with contextlib.suppress(Exception):
            async for raw in proc.stderr:
                log.warning("blog_cover_renderer_stderr", line=raw.decode(errors="replace")[:500])

    async def _call(self, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
        if self.proc is None or self.proc.returncode is not None:
            await self._start()
        assert self.proc is not None and self.proc.stdin is not None and self.proc.stdout is not None
        self.seq += 1
        payload = {**payload, "id": self.seq}
        try:
            self.proc.stdin.write(json.dumps(payload).encode() + b"\n")
            await self.proc.stdin.drain()
            line = await asyncio.wait_for(self.proc.stdout.readline(), timeout)
        except TimeoutError:
            log.warning("blog_cover_renderer_timeout", timeout=timeout)
            self._kill_sync()
            raise CoverError(
                f"Drawing the cover took longer than {timeout:.0f} seconds and was stopped. Simplify it "
                "(fewer elements, smaller images, fewer shadows) and try again.",
                code="timeout",
            ) from None
        except (BrokenPipeError, ConnectionResetError):
            self._kill_sync()
            raise CoverError("The cover renderer stopped unexpectedly. Try again.", code="renderer_crashed") from None
        if not line:
            self._kill_sync()
            raise CoverError("The cover renderer stopped unexpectedly. Try again.", code="renderer_crashed")
        try:
            answer: dict[str, Any] = json.loads(line)
        except ValueError:
            self._kill_sync()
            raise CoverError("The cover renderer answered nonsense and was restarted. Try again.", code="renderer_crashed") from None
        if answer.get("id") != self.seq:
            self._kill_sync()
            raise CoverError("The cover renderer got out of step and was restarted. Try again.", code="renderer_crashed")
        return answer

    async def run(self, payload: dict[str, Any], timeout: float = TIMEOUT_SEC) -> dict[str, Any]:
        self._bind_loop()
        assert self.lock is not None
        if self.waiting >= MAX_WAITING:
            raise CoverError("The cover renderer is busy with other covers. Try again in a minute.", code="busy")
        self.waiting += 1
        try:
            async with self.lock:
                answer = await self._call(payload, timeout)
        finally:
            self.waiting -= 1
            self.last_used = time.monotonic()
            self._schedule_reaper()
        return answer

    def _schedule_reaper(self) -> None:
        if self.reaper is None or self.reaper.done():
            self.reaper = asyncio.create_task(self._reap())

    async def _reap(self) -> None:
        idle = max(5, get_settings().blog_cover_idle_sec)
        while self.proc is not None:
            await asyncio.sleep(max(1.0, idle - (time.monotonic() - self.last_used)))
            if time.monotonic() - self.last_used >= idle and (self.lock is None or not self.lock.locked()):
                log.info("blog_cover_renderer_idle_stop", pid=self.proc.pid if self.proc else None)
                await self.close()
                return

    async def stats(self) -> dict[str, Any] | None:
        if self.proc is None or self.proc.returncode is not None:
            return None
        answer = await self.run({"cmd": "stats"}, timeout=5)
        memory: dict[str, Any] | None = answer.get("memory")
        return memory

    @property
    def pid(self) -> int | None:
        return self.proc.pid if self.proc is not None and self.proc.returncode is None else None

    async def close(self) -> None:
        proc, self.proc = self.proc, None
        if proc is None or proc.returncode is not None:
            return
        with contextlib.suppress(Exception):
            assert proc.stdin is not None
            proc.stdin.close()
        try:
            await asyncio.wait_for(proc.wait(), 2)
        except TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
            with contextlib.suppress(Exception):
                await proc.wait()


renderer = _Renderer()


async def shutdown() -> None:
    await renderer.close()


# ── the pipeline ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Checked:
    html: str
    css: str
    media_urls: list[str]


def check(html: str, css: str) -> Checked:
    """Everything wrong with a cover's markup, all at once (CoverError)."""
    problems: list[str] = []
    size = len(html.encode()) + len(css.encode())
    if size > MAX_SOURCE_BYTES:
        problems.append(f"html + css is {size // 1024} KB; the limit for a cover is {MAX_SOURCE_BYTES // 1024} KB.")
    result = markup.sanitize(html, css, mode="cover", media_base=media.media_base())
    problems += result.problems
    missing = uncovered(result.text_chars)
    if missing:
        shown = ", ".join(f"`{c}` (U+{ord(c):04X})" for c in missing[:8])
        problems.append(
            f"These characters are not in the brand fonts and would not be drawn: {shown}. Emoji are not supported in "
            "covers — use an inline SVG icon from get_icons instead."
        )
    if len(result.media_urls) > MAX_IMAGES:
        problems.append(f"The cover uses {len(result.media_urls)} images; at most {MAX_IMAGES}.")
    if problems:
        raise CoverError(problems)
    return Checked(html=result.html, css=result.css, media_urls=result.media_urls)


async def _inline_images(checked: Checked) -> tuple[str, str]:
    """Media-store images become PNG data: URLs — the renderer fetches nothing."""
    from PIL import Image

    html, css = checked.html, checked.css
    for url in checked.media_urls:
        name = media.name_of_url(url)
        body = await media.read(name) if name else None
        if body is None:
            raise CoverError(f"`{url}` is not in the media store.")
        with Image.open(io.BytesIO(body)) as img:
            img.load()
            out = io.BytesIO()
            img.convert("RGBA").save(out, format="PNG", optimize=False)
        data = "data:image/png;base64," + base64.b64encode(out.getvalue()).decode()
        html = html.replace(url, data)
        css = css.replace(url, data)
    return html, css


_HINTS = {
    "explicit \"display: flex\"": "every <div> with more than one child needs `display: flex` (or `display: none`).",
    "is not supported": "use only the CSS listed as supported for covers (see get_site_info brand.cover).",
}


async def draw(checked: Checked) -> bytes:
    """PNG bytes of the checked cover (1600×900)."""
    html, css = await _inline_images(checked)
    answer = await renderer.run(
        {"html": html, "css": css, "width": WIDTH, "height": HEIGHT, "defaultFont": kit.DEFAULT_FONT}
    )
    if not answer.get("ok"):
        error = str(answer.get("error") or "unknown error")
        hint = next((h for k, h in _HINTS.items() if k in error), "")
        raise CoverError(f"The cover could not be drawn: {error}" + (f" — {hint}" if hint else ""), code="render_failed")
    return base64.b64decode(answer["png"])


def to_webp(png: bytes) -> tuple[bytes, int, int]:
    from PIL import Image

    with Image.open(io.BytesIO(png)) as img:
        img.load()
        if img.size != (WIDTH, HEIGHT):
            raise CoverError(f"The renderer returned {img.size[0]}×{img.size[1]} instead of {WIDTH}×{HEIGHT}.", code="render_failed")
        has_alpha = img.mode in ("RGBA", "LA") and img.getextrema()[-1][0] < 255
        clean = img.convert("RGBA" if has_alpha else "RGB")
        out = io.BytesIO()
        clean.save(out, format="WEBP", quality=WEBP_QUALITY, method=6)
        return out.getvalue(), WIDTH, HEIGHT


def example() -> dict[str, str]:
    """A minimal cover that draws (get_site_info brand.examples.cover)."""
    return {
        "alt": "ปกบทความ: ตัดคลิปรีวิวสินค้าให้ไวขึ้น",
        "html": (
            '<div class="bg"><div class="tag">Noey Studio</div>'
            '<div class="title">ตัดคลิปรีวิวสินค้าให้ไวขึ้น</div>'
            '<div class="sub">ดราฟต์แรกจาก AI แล้วเกลาเองในไทม์ไลน์</div></div>'
        ),
        "css": (
            ".bg{display:flex;flex-direction:column;justify-content:center;width:1600px;height:900px;padding:120px;"
            "background:linear-gradient(135deg,#171614 0%,#5a3b0a 100%);color:#f3f2f2}"
            ".tag{display:flex;font-size:36px;font-weight:600;color:#d9a441;margin-bottom:28px}"
            ".title{display:flex;font-size:104px;font-weight:700;line-height:1.2;text-shadow:0 8px 24px rgba(0,0,0,.45)}"
            ".sub{display:flex;font-size:44px;font-weight:400;margin-top:32px;color:#bdb8b0}"
        ),
    }
