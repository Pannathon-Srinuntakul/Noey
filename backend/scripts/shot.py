"""Screenshot the frontend + capture console/page errors (debug aid)."""

import asyncio
import sys

from playwright.async_api import async_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5173"
OUT = sys.argv[2] if len(sys.argv) > 2 else "scripts/frontend.png"


async def main() -> None:
    logs: list[str] = []
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        page = await browser.new_page(viewport={"width": 1100, "height": 1000})
        page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
        await page.goto(URL, wait_until="networkidle")
        await page.wait_for_timeout(2500)
        await page.screenshot(path=OUT)
        await browser.close()
    print("=== console/page logs ===")
    for line in logs:
        print(line)
    print("=== saved scripts/frontend.png ===")


if __name__ == "__main__":
    asyncio.run(main())
