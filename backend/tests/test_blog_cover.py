"""render_cover: what the cover checker refuses (and names), a real Thai
render through the node renderer, and the process rules — one job at a time,
a hard timeout that kills the child, restart after a crash, idle stop, the
fonts loaded once — plus the RAM the renderer actually uses."""

from __future__ import annotations

import asyncio
import io
import itertools
import os
import shutil
import subprocess
import sys
import time

import pytest
from PIL import Image

from packages.blog import cover, kit
from packages.core.settings import get_settings

NODE_READY = shutil.which("node") is not None and (cover.RENDERER_DIR / "node_modules").is_dir()
needs_node = pytest.mark.skipif(not NODE_READY, reason="needs node + backend/cover_renderer/node_modules (npm ci)")


@pytest.fixture(autouse=True)
async def _stop_renderer():
    yield
    await cover.shutdown()


@pytest.mark.parametrize(
    ("html", "css", "needle"),
    [
        ("<div>x</div>", ".a{display:grid}", "`display: grid`"),
        ("<div>x</div>", ".a{grid-template-columns:1fr 1fr}", "`grid-template-columns`"),
        ('<div style="display:inline-block">x</div>', "", "`display: inline-block`"),
        ("<div>x</div>", ".a{animation:spin 1s infinite}", "`animation`"),
        ("<div>x</div>", "@keyframes spin{to{transform:rotate(1turn)}}", "@keyframes"),
        ("<div>x</div>", ".a{transition:all 1s}", "`transition`"),
        ("<div>x</div><script>alert(1)</script>", "", "<script>"),
        ('<div onclick="x()">x</div>', "", "event handler"),
        ('<img src="https://evil.example/a.png" width="10" height="10">', "", "outside the blog media store"),
        ("<div>x</div>", ".a{background:url(http://169.254.169.254/)}", "outside the blog media store"),
        ("<div>x</div>", "@import 'x.css';", "@import"),
        ("<div>ตัดคลิป 🎬</div>", "", "U+1F3AC"),
        ("<div>x</div>", ".a{position:fixed}", "`position: fixed`"),
        ("<style>.a{}</style><div>x</div>", "", "<style> in the cover html"),
    ],
)
def test_unsupported_cover_markup_is_named(html, css, needle):
    with pytest.raises(cover.CoverError) as e:
        cover.check(html, css)
    assert any(needle in p for p in e.value.problems), e.value.problems


def test_every_problem_is_reported_at_once():
    with pytest.raises(cover.CoverError) as e:
        cover.check('<div style="display:grid">🎬</div><script>x</script>', ".a{animation:x 1s}")
    assert len(e.value.problems) >= 4


def test_coverage_knows_thai_and_latin():
    assert cover.uncovered(set("ตัดคลิปรีวิวสินค้าให้ไวขึ้น ที่นี่ น้ำ ฤๅษี Noey 2026 — “quotes” ฿")) == []
    assert cover.uncovered({"🎬", "中"}) == ["中", "🎬"]


@needs_node
async def test_thai_cover_renders_1600x900(tmp_path):
    ex = cover.example()
    icon = kit.icon_svg("scissors", size=96, color="#d9a441")
    assert icon is not None
    html = ex["html"].replace('<div class="tag">Noey Studio</div>', f'<div class="tag">{icon}<span>Noey Studio</span></div>')
    checked = cover.check(html, ex["css"])
    png = await cover.draw(checked)
    webp, w, h = cover.to_webp(png)
    with Image.open(io.BytesIO(webp)) as img:
        assert img.format == "WEBP" and img.size == (1600, 900) == (w, h)
        # The title is drawn: light pixels where the text is, on a dark gradient.
        crop = img.convert("L").crop((120, 380, 1200, 520))
        assert max(crop.getdata()) > 200 and min(crop.getdata()) < 80
    assert len(webp) < 400_000


@needs_node
async def test_empty_elements_and_absolute_decoration_render():
    """An empty decorative <div> (a glow, a dot) must not trip the layout rule."""
    html = '<div class="bg"><div class="glow"></div><div class="t">ปก</div><div class="t">สอง</div></div>'
    css = (
        ".bg{display:flex;flex-direction:column;position:relative;width:1600px;height:900px;background:#171614}"
        ".glow{position:absolute;right:0;top:0;width:400px;height:400px;border-radius:200px;"
        "background:radial-gradient(circle,rgba(217,164,65,.5) 0%,rgba(217,164,65,0) 70%)}.t{display:flex;color:#fff;font-size:80px}"
    )
    png = await cover.draw(cover.check(html, css))
    assert png.startswith(b"\x89PNG")


@needs_node
async def test_renderer_errors_are_explained():
    checked = cover.check("<div><span>a</span><span>b</span></div>", "")
    with pytest.raises(cover.CoverError) as e:
        await cover.draw(checked)
    assert e.value.code == "render_failed" and "display: flex" in " ".join(e.value.problems)


def _fake_renderer(tmp_path, body: str):  # type: ignore[no-untyped-def]
    (tmp_path / "node_modules").mkdir(exist_ok=True)
    (tmp_path / "worker.mjs").write_text(
        "import readline from 'node:readline';\n"
        "process.stdout.write(JSON.stringify({ready:true})+'\\n');\n"
        "const rl = readline.createInterface({input: process.stdin});\n"
        f"rl.on('line', (line) => {{ const job = JSON.parse(line); {body} }});\n"
        "rl.on('close', () => process.exit(0));\n"
    )
    return tmp_path


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # A zombie still answers kill(0); ask ps for its state.
    state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True, check=False).stdout.strip()
    return bool(state) and not state.startswith("Z")


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node")
async def test_timeout_kills_the_child_and_the_next_call_starts_fresh(tmp_path, monkeypatch):
    monkeypatch.setattr(cover, "RENDERER_DIR", _fake_renderer(tmp_path, "/* never answers */"))
    monkeypatch.setattr(cover, "TIMEOUT_SEC", 1.0)
    started = time.monotonic()
    with pytest.raises(cover.CoverError) as e:
        await cover.renderer.run({"html": "x"}, timeout=1.0)
    assert e.value.code == "timeout" and time.monotonic() - started < 5
    assert cover.renderer.pid is None  # killed
    _fake_renderer(tmp_path, "process.stdout.write(JSON.stringify({id: job.id, ok: true, png: ''})+'\\n');")
    answer = await cover.renderer.run({"html": "x"})
    assert answer["ok"] is True and cover.renderer.pid is not None


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node")
async def test_crash_is_reported_and_recovered(tmp_path, monkeypatch):
    monkeypatch.setattr(cover, "RENDERER_DIR", _fake_renderer(tmp_path, "process.exit(3);"))
    with pytest.raises(cover.CoverError) as e:
        await cover.renderer.run({"html": "x"})
    assert e.value.code == "renderer_crashed"
    _fake_renderer(tmp_path, "process.stdout.write(JSON.stringify({id: job.id, ok: true})+'\\n');")
    assert (await cover.renderer.run({"html": "x"}))["ok"] is True


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node")
async def test_one_job_at_a_time_and_a_bounded_queue(tmp_path, monkeypatch):
    monkeypatch.setattr(
        cover, "RENDERER_DIR",
        _fake_renderer(tmp_path, "setTimeout(() => process.stdout.write(JSON.stringify({id: job.id, ok: true, t: Date.now()})+'\\n'), 300);"),
    )
    monkeypatch.setattr(cover, "MAX_WAITING", 3)
    results = await asyncio.gather(*(cover.renderer.run({"html": str(i)}) for i in range(5)), return_exceptions=True)
    done = [r for r in results if isinstance(r, dict)]
    busy = [r for r in results if isinstance(r, cover.CoverError)]
    assert len(done) == 3 and len(busy) == 2 and all(b.code == "busy" for b in busy)
    stamps = sorted(r["t"] for r in done)
    assert all(b - a >= 250 for a, b in itertools.pairwise(stamps))  # strictly one after another


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node")
async def test_idle_renderer_stops_and_stdin_eof_ends_it(tmp_path, monkeypatch):
    monkeypatch.setattr(cover, "RENDERER_DIR", _fake_renderer(tmp_path, "process.stdout.write(JSON.stringify({id: job.id, ok: true})+'\\n');"))
    monkeypatch.setenv("BLOG_COVER_IDLE_SEC", "5")
    get_settings.cache_clear()
    await cover.renderer.run({"html": "x"})
    pid = cover.renderer.pid
    assert pid is not None and _alive(pid)
    await asyncio.sleep(6.5)
    assert cover.renderer.pid is None and not _alive(pid)


@needs_node
async def test_renderer_memory_budget():
    """RAM of the renderer process: idle after start (fonts loaded) and after
    ten covers. The budget is ~150 MB extra per API process (spec §10); the
    numbers are printed for docs/blog-mcp.md (`pytest -s`)."""
    ex = cover.example()
    checked = cover.check(ex["html"], ex["css"])
    await cover.draw(checked)
    pid = cover.renderer.pid
    assert pid is not None

    def rss_mb() -> float:
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True, check=False).stdout.strip()
        return int(out) / 1024

    after_first = rss_mb()
    for _ in range(10):
        await cover.draw(checked)
    after_ten = rss_mb()
    stats = await cover.renderer.stats()
    print(f"\ncover renderer RSS: after 1 render {after_first:.0f} MB, after 11 renders {after_ten:.0f} MB, "
          f"V8 heap {stats['heapUsed'] / 2**20:.0f} MB, platform {sys.platform}")
    assert after_ten < 200  # macOS reports more than Linux; Linux numbers are in the docs
    assert after_ten - after_first < 40  # no growth per render
