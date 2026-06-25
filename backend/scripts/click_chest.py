"""Drive the island UI: click the treasure chest, verify the revenue overlay opens.

Diagnoses the reported chest bug. Captures console errors + before/after screenshots.
"""

import asyncio

from playwright.async_api import async_playwright

VIEW = {"width": 1100, "height": 1000}


async def main() -> None:
    logs: list[str] = []
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        page = await browser.new_page(viewport=VIEW)
        page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
        await page.goto("http://localhost:5173/", wait_until="networkidle")
        await page.wait_for_timeout(2500)
        await page.screenshot(path="scripts/chest_before.png")

        # Try clicking a grid of points over where the chest sits (auto-rotate moves it,
        # so probe a few nearby points until the overlay appears).
        targets = [(615, 545), (600, 560), (635, 525), (590, 535), (650, 555), (615, 510)]
        opened = False
        for (x, y) in targets:
            await page.mouse.click(x, y)
            await page.wait_for_timeout(400)
            if await page.locator("text=Treasure").count() > 0:
                opened = True
                hit = (x, y)
                break

        await page.screenshot(path="scripts/chest_after.png")
        print(f"overlay opened: {opened}" + (f" at {hit}" if opened else ""))
        print("=== logs ===")
        for line in logs[-15:]:
            print(line)
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
