import asyncio, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
from playwright.async_api import async_playwright

async def run():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, slow_mo=200)
        page = await browser.new_page(viewport={'width': 1400, 'height': 900})
        await page.goto('http://localhost:5174')
        await page.wait_for_timeout(3500)
        await page.screenshot(path='shot_loaded.png')

        # check metric cards have real numbers
        cards = await page.locator('.absolute.inset-x-0.top-0 >> [class*=rounded]').all_inner_texts()
        print('metric cards:', cards)

        # click buildings one by one and screenshot
        coords = [(760,310,'lighthouse'), (490,450,'hut'), (620,530,'chest')]
        for x,y,name in coords:
            await page.mouse.click(x, y)
            await page.wait_for_timeout(1000)
            await page.screenshot(path=f'shot_{name}.png')
            # try close
            try:
                await page.locator('button').filter(has_text='x').first.click(timeout=500)
            except:
                pass
            await page.wait_for_timeout(400)

        await browser.close()
        print('done')

asyncio.run(run())
