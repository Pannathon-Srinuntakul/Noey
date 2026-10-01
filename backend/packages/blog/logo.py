"""The Noey Studio mark as a media-store image, for get_site_info `brand.logo`.

Made once, on first use: the site's icon.svg (render_assets/brand/, kept in
step by scripts/build_brand_info.py) is rasterised by the cover renderer's
resvg to a 512 px PNG, re-encoded to WebP and stored like any other blog
image (origin `brand`, library category `logo`). Content-addressed, so a
second call — from any process — finds the same row instead of a new file.
"""

from __future__ import annotations

import base64
import io
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from packages.blog import kit, media
from packages.core.logging import get_logger
from packages.db.models.blog import BlogImage

log = get_logger(__name__)

LOGO_FILENAME = "noey-mark.svg"
LOGO_SIDE = 512
LOGO_ALT = "โลโก้ Noey Studio"


async def _render() -> tuple[bytes, int, int]:
    from PIL import Image

    from packages.blog import cover

    answer = await cover.renderer.run({"cmd": "svg", "svg": kit.mark_svg(), "width": LOGO_SIDE}, timeout=cover.TIMEOUT_SEC)
    if not answer.get("ok"):
        raise cover.CoverError(str(answer.get("error")), code="render_failed")
    with Image.open(io.BytesIO(base64.b64decode(answer["png"]))) as img:
        img.load()
        out = io.BytesIO()
        img.convert("RGBA").save(out, format="WEBP", quality=90, method=6)
        return out.getvalue(), img.width, img.height


async def logo_asset(db: AsyncSession) -> dict[str, Any]:
    info: dict[str, Any] = {
        "svg_inline": kit.mark_svg(),
        "note": "Paste svg_inline into a visual or cover to draw the mark; use url where an image URL is needed.",
    }
    row = (
        await db.execute(
            select(BlogImage).where(BlogImage.origin == "brand", BlogImage.filename == LOGO_FILENAME).order_by(BlogImage.id.desc())
        )
    ).scalars().first()
    if row is None:
        try:
            body, w, h = await _render()
        except Exception as exc:  # noqa: BLE001 — the logo is a convenience; site info must still answer
            log.warning("blog_logo_render_failed", error=str(exc)[:200])
            return {**info, "url": None, "width": None, "height": None}
        stored = await media.store_bytes(body, "webp", width=w, height=h)
        await db.execute(
            pg_insert(BlogImage)
            .values(
                url=stored.url, key=stored.key, mime=stored.mime, bytes=stored.bytes, width=w, height=h, alt=LOGO_ALT,
                uploaded_by="system:brand", kind="image", origin="brand", category="logo", filename=LOGO_FILENAME,
                description="The Noey Studio mark (the site's icon).", tags=["brand", "logo"],
            )
            .on_conflict_do_nothing(index_elements=[BlogImage.key])
        )
        row = (await db.execute(select(BlogImage).where(BlogImage.key == stored.key))).scalar_one()
    return {**info, "url": row.url, "width": row.width, "height": row.height, "alt": row.alt}
