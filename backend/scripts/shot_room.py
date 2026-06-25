"""Open a room by clicking a building, then screenshot it."""

import asyncio
import sys

from playwright.async_api import async_playwright

X, Y = int(sys.argv[1]), int(sys.argv[2])
OUT = sys.argv[3] if len(sys.argv) > 3 else "scripts/room.png"


async def main() -> None:
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        page = await browser.new_page(viewport={"width": 1100, "height": 1000})
        await page.goto("http://localhost:5173/", wait_until="networkidle")
        await page.wait_for_timeout(2500)
        await page.mouse.click(X, Y)
        await page.wait_for_timeout(2500)
        await page.screenshot(path=OUT)
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
