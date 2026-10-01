"""What `get_site_info` tells a writer: the product, its honest scope, plans,
existing guides, CTAs and the brand's writing rules.

Product facts come from site_info.json, EXTRACTED from noey-frontend/src/lib by
scripts/build_site_info.py (never retyped here). Prices are read live from the
same source as GET /billing/plans. The writing rules are the owner's brand
policy for blog posts and live here because no site module states them.
"""

from __future__ import annotations

import json
import pathlib
from functools import lru_cache
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from packages.blog import validation as v

_JSON = pathlib.Path(__file__).with_name("site_info.json")
_BRAND_JSON = pathlib.Path(__file__).with_name("brand.json")

AUDIENCE = (
    "ครีเอเตอร์และแม่ค้าออนไลน์ชาวไทยที่ถ่ายคลิปเองลงเอง โดยเฉพาะครีเอเตอร์ TikTok Affiliate "
    "ที่ทำคลิปรีวิวสินค้า/ปักตะกร้า และคนที่มีไลฟ์หรือคลิปพูดยาวอยากตัดเป็นคลิปสั้น"
)

WRITING_RULES: tuple[str, ...] = (
    "Write in Thai. Tone: direct, friendly, plain — explain, never hype or over-promise.",
    "Never invent numbers, statistics, studies, benchmarks or customer testimonials. Use only facts in this document.",
    "Never claim the product does anything listed under scope.does_not_fit_yet, and stay within modes[].steps.",
    (
        "Never name an AI vendor or model (Gemini, Claude, ChatGPT/OpenAI, ElevenLabs, …) anywhere in the post — "
        "say what the system does ('ระบบถอดเสียง', 'AI คัดช็อต') instead. create_post refuses posts that do."
    ),
    "Do not use real brand or person names in a misleading way, and give no medical, legal or financial advice.",
    (
        "Structure: `##`/`###` headings only (the title is the H1), short paragraphs, and answer the reader's question "
        "directly in the FIRST paragraph (good for AI search engines)."
    ),
    f"Include {v.FAQ_MIN}–{v.FAQ_MAX} FAQ pairs in the `faq` field (plain-text answers), not inside content_md.",
    (
        f"Link to at least {v.MIN_INTERNAL_LINKS} relevant pages of this site (e.g. /pricing, /scope, a /guide page) "
        "with relative links like [ดูราคา](/pricing)."
    ),
    (
        "Do NOT write a post on a topic an existing guide already covers (see `guides`); link to that guide instead. "
        "Check `list_posts` first so you never repeat a topic or a slug already used (drafts and unpublished included)."
    ),
    (
        f"Body length: at least {{min_words}} words. meta_title <= {v.META_TITLE_MAX} chars, meta_description <= "
        f"{v.META_DESCRIPTION_MAX}, excerpt <= {v.EXCERPT_MAX}, slug lowercase a-z0-9- <= {v.SLUG_MAX}."
    ),
    (
        "Pictures (required): a cover made with `render_cover` (or chosen from `list_media`) plus at least 2 pictures in "
        "the body, each with alt text — HTML visuals from `create_visual` (paste the returned `::visual[alt](id)` on its "
        "own line) and/or real screenshots and demo videos from `list_media` (`![alt](url)`). At most 3 animated visuals "
        "per post. Never hotlink other sites; `upload_image` is only for small extra images."
    ),
    (
        "Draw visuals in the brand (see `brand`): its colours and fonts, a fixed canvas (e.g. 1600×1000), no links, "
        "no forms, nothing loaded from outside. Prefer real screenshots from `list_media` inside a visual over "
        "imitations of the product UI, and never invent numbers in a chart."
    ),
    (
        "Follow the owner's `brief`, and when `content_plan` lists open topics write the FIRST one (unless it is already "
        "covered); after create_post call `mark_topic_done(topic_id, slug)`."
    ),
)


@lru_cache(maxsize=1)
def _static() -> dict[str, Any]:
    return json.loads(_JSON.read_text(encoding="utf-8"))


async def live_prices(db: AsyncSession) -> dict[str, Any]:
    """The paid plans' monthly prices — the same answer GET /billing/plans gives."""
    from services.api.routers.billing import list_plans, optional_stripe_client

    try:
        plans = await list_plans(optional_stripe_client(), db)
    except Exception as exc:  # noqa: BLE001 — a price outage must not break site info
        return {"available": False, "reason": type(exc).__name__}
    return {
        "available": True,
        "currency": "THB",
        "source": plans.source,
        "monthly": {p.tier: p.unit_amount / 100 for p in plans.plans},
        "note": "Prices change; link to /pricing instead of quoting exact prices in a post.",
    }


@lru_cache(maxsize=1)
def _brand_tokens() -> dict[str, Any]:
    tokens: dict[str, Any] = json.loads(_BRAND_JSON.read_text(encoding="utf-8"))
    return tokens


async def brand(db: AsyncSession) -> dict[str, Any]:
    """What a writer needs to draw on-brand covers and visuals."""
    from packages.blog import cover, kit, visual
    from packages.blog.logo import logo_asset
    from packages.core.settings import get_settings

    tokens = _brand_tokens()
    logo = await logo_asset(db)
    return {
        "name": "Noey Studio",
        "colors": {
            "primary": tokens["primary"],
            "secondary": tokens["secondary"],
            "primary_on_dark": tokens["primary_on_dark"],
            "night": tokens["night"],
            "light_theme": tokens["colors"]["light"],
            "dark_theme": tokens["colors"]["dark"],
            "roles": tokens["roles"],
        },
        "fonts": kit.fonts_info(get_settings().blog_embed_origin),
        "font_stack": kit.FONT_STACK,
        "logo": logo,
        "icons": {
            "set": kit.icon_set(),
            "how": (
                "Icons are inline SVG: call get_icons(['scissors', 'captions']) and paste the returned <svg> into the "
                "html (visuals and covers). Set its size with width/height and its colour with the stroke attribute. "
                "Browse names at https://lucide.dev/icons. `<i data-lucide>` and icon fonts do not work."
            ),
        },
        "visual": {
            "recommended_sizes": visual.RECOMMENDED,
            "rules": [
                "width/height is the designed canvas in CSS px; the page scales it like an image and keeps that aspect ratio.",
                "html + css + js together <= 200 KB. No <iframe>, <form>, <a>, <input>, <object>, <embed>, <link>, <meta>, <base>, @import or @font-face.",
                "Images: only media-store urls (list_media) or data:image URLs. Nothing else loads; network access is blocked.",
                "Fonts: font-family 'Noto Sans Thai' (default) or 'IBM Plex Sans Thai' — already loaded.",
                "Animation: CSS @keyframes or requestAnimationFrame (set animated: true). The page pauses it off-screen and for reduced-motion readers. Make loops seamless.",
                "It is a picture: no hover, clicks or scrolling; text cannot be selected. Put links in the article text.",
            ],
            "markdown": "::visual[alt](id) on its own line",
        },
        "cover": {
            "size": {"width": cover.WIDTH, "height": cover.HEIGHT},
            "supported_css": list(cover.SUPPORTED_CSS),
            "unsupported": list(cover.UNSUPPORTED_CSS),
        },
        "examples": {"visual": visual.example(), "cover": cover.example()},
    }


async def site_info(db: AsyncSession, *, min_words: int) -> dict[str, Any]:
    from packages.blog import brief as brief_mod

    data = _static()
    site = data["product"]["site_url"].rstrip("/")
    return {
        "product": {**data["product"], "audience": AUDIENCE},
        "modes": data["modes"],
        "scope": data["scope"],
        "plans": data["plans"],
        "plans_note": data["plans_note"],
        "prices": await live_prices(db),
        "cta_links": {
            "signup": f"{site}/signup",
            "pricing": f"{site}/pricing",
            "scope": f"{site}/scope",
            "guide": f"{site}/guide",
        },
        "pages": data["pages"],
        "guides": data["guides"],
        "writing_rules": [r.replace("{min_words}", str(min_words)) for r in WRITING_RULES],
        "brand": await brand(db),
        "brief": await brief_mod.get_brief(db),
        "content_plan": await brief_mod.plan(db, unwritten_only=True),
    }
