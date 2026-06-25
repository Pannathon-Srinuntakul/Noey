"""Download CC0 .glb models from Poly Pizza by capturing the viewer's network fetch.

The model-viewer on each page fetches the .glb itself, so we just navigate and grab the
response body. CC0 — free for commercial use.
"""

import asyncio
from pathlib import Path

from playwright.async_api import async_playwright

OUT = Path(__file__).resolve().parents[2] / "frontend" / "public" / "models"

# name -> Poly Pizza model page (all CC0). Island theme.
MODELS = {
    "island": "https://poly.pizza/m/C03O8OQq6O",  # Island (J-Toastie)
    "island_alt": "https://poly.pizza/m/esKAALJfsrG",  # Simple Island (Don Carson)
    "lighthouse": "https://poly.pizza/m/0SWQTv1whoA",  # Lighthouse (jeremy) — activity
    "chest": "https://poly.pizza/m/haqf9qoiOG",  # Chest with Gold (Quaternius) — revenue
    "hut": "https://poly.pizza/m/wxi3kAu5ey",  # Hut — profile
    "palm": "https://poly.pizza/m/A6cKJYFsIb",  # Palm Tree (Quaternius)
    "coins": "https://poly.pizza/m/VaGFKE0n0F",  # Coins (Quaternius) — gold accent
}


async def fetch_one(context, name: str, url: str) -> str:
    page = await context.new_page()
    glb_bytes: bytes | None = None
    try:
        async with page.expect_response(
            lambda r: ".glb" in r.url.lower(), timeout=25000
        ) as resp_info:
            await page.goto(url, wait_until="commit")
        resp = await resp_info.value
        glb_bytes = await resp.body()
    except Exception as exc:  # noqa: BLE001
        await page.close()
        return f"{name}: FAIL ({exc})"
    await page.close()
    if not glb_bytes:
        return f"{name}: FAIL (empty)"
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{name}.glb").write_bytes(glb_bytes)
    return f"{name}: ok ({len(glb_bytes)} bytes)"


async def main() -> None:
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        context = await browser.new_context()
        for name, url in MODELS.items():
            print(await fetch_one(context, name, url))
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
