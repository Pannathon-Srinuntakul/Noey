"""The blog MCP server: tools an AI client (a claude.ai custom connector) uses to
write blog posts for noeystudio.com, behind OAuth 2.1 (packages/blog/oauth.py).

Mounted INSIDE the API process (services/api/main.py) — no extra service:

    POST/GET/DELETE /mcp                               Streamable HTTP (stateless, JSON)
    GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728 metadata
    GET  /.well-known/oauth-authorization-server       RFC 8414 metadata
    GET/POST /mcp/oauth/authorize   POST /mcp/oauth/token
    POST /mcp/oauth/register        POST /mcp/oauth/revoke

Stateless mode on purpose: the API runs several uvicorn workers and replicas,
and an in-memory MCP session would live in only one of them. Every request
carries its bearer token and stands alone.

There is deliberately NO delete tool. Unpublishing is the strongest action an
AI client has; deleting is not possible from MCP at all.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Annotated, Any, Literal

from fastapi import HTTPException
from mcp.server.auth.handlers.authorize import AuthorizationHandler
from mcp.server.auth.handlers.register import RegistrationHandler
from mcp.server.auth.handlers.revoke import RevocationHandler
from mcp.server.auth.handlers.token import TokenHandler
from mcp.server.auth.middleware.auth_context import AuthContextMiddleware
from mcp.server.auth.middleware.bearer_auth import (
    AuthenticatedUser,
    BearerAuthBackend,
    RequireAuthMiddleware,
)
from mcp.server.auth.middleware.client_auth import ClientAuthenticator
from mcp.server.auth.provider import AccessToken
from mcp.server.auth.routes import build_metadata
from mcp.server.auth.settings import ClientRegistrationOptions, RevocationOptions
from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp_types import ToolAnnotations
from pydantic import AnyHttpUrl, Field
from starlette.middleware.authentication import AuthenticationMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import BaseRoute, Route, request_response
from starlette.types import ASGIApp, Receive, Scope, Send

from packages.blog import media, oauth, service, site_info
from packages.blog import validation as v
from packages.blog.schemas import FaqItem, NewPost, PostChanges, TagIn
from packages.core.logging import get_logger
from packages.core.settings import get_settings
from packages.db.session import get_sessionmaker
from services.api import ratelimit

log = get_logger(__name__)

#: The largest call is a 200 KB visual or a 300 KB upload_image, plus JSON.
MAX_BODY_BYTES = 2 * 1024 * 1024
#: upload_image takes small pictures only (render_cover / create_visual /
#: list_media are the ways to put pictures in a post).
UPLOAD_IMAGE_MAX_BASE64 = 300 * 1024

INSTRUCTIONS = """\
Noey Studio blog writer. Workflow for a new article:
1. get_site_info — product facts, honest scope, guides, CTAs, the WRITING RULES, the brand kit, the owner's
   brief and the open content-plan topics (write the first one).
2. list_posts — every post in every status: never repeat a topic or a slug.
3. Pictures: list_media (real screenshots, demo videos, logos), create_visual (HTML/CSS/JS drawn in the brand,
   behaves like an image; returns `::visual[alt](id)` to paste on its own line), get_icons (inline SVG icons),
   render_cover (the 1600x900 cover image). A post needs a cover and at least 2 pictures in the body.
4. create_post — always saved as a draft; the reply lists exactly what to fix if it is refused.
5. publish_post — publishes within the daily limit, or tells you the owner will approve it.
6. mark_topic_done(topic_id, slug) when the post covers a content-plan topic.
There is no delete. unpublish_post takes a post offline.
"""

READ = ToolAnnotations(read_only_hint=True, destructive_hint=False, open_world_hint=False)
WRITE = ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=False, open_world_hint=False)


# ── per-call context ─────────────────────────────────────────────────────────


def _token(ctx: Context) -> AccessToken:
    request = getattr(ctx.request_context, "request", None)
    user = request.scope.get("user") if request is not None else None
    if not isinstance(user, AuthenticatedUser):
        raise ToolError("Not authenticated.")
    return user.access_token


async def _begin(ctx: Context) -> tuple[str, int]:
    """(actor, grant id) for this call, after the per-grant rate limit."""
    tok = _token(ctx)
    gid = int((tok.claims or {}).get("gid", 0))
    limit = ratelimit.Limit("blog_mcp:grant", max(1, get_settings().blog_mcp_calls_per_min), 60)
    try:
        await ratelimit.enforce([(limit, f"grant:{gid}")])
    except HTTPException as exc:
        if exc.status_code == 429:
            wait = (exc.headers or {}).get("Retry-After", "60")
            raise ToolError(f"Rate limit reached ({limit.max_hits} calls per minute). Wait {wait} seconds and retry.") from None
        raise ToolError("The server is temporarily unavailable. Retry in a minute.") from None
    return f"mcp:{tok.client_id}", gid


@asynccontextmanager
async def _db() -> AsyncIterator[Any]:
    from sqlalchemy import text

    async with get_sessionmaker()() as db:
        await db.execute(text("SET search_path TO core, public"))
        try:
            yield db
            await db.commit()
        except Exception:
            await db.rollback()
            raise


async def _missing_images(db: Any, urls: list[str]) -> list[str]:
    """Media-store URLs that are not stored images (a visual/cover may only
    show what the store holds)."""
    from sqlalchemy import select

    from packages.db.models.blog import BlogImage

    rows = {r.url: r for r in (await db.execute(select(BlogImage).where(BlogImage.url.in_(urls)))).scalars()}
    return [
        f"`{u[:120]}` is not an image of the media store — use an image url from list_media."
        for u in urls
        if u not in rows or rows[u].kind != "image"
    ]


def _fail(exc: service.BlogError) -> ToolError:
    lines = "\n".join(f"- {p}" for p in exc.problems)
    return ToolError(f"Refused ({exc.code}). Fix the following and call again:\n{lines}")


# ── tools ────────────────────────────────────────────────────────────────────

Slug = Annotated[str, Field(min_length=1, max_length=v.SLUG_MAX, description="The post's slug.")]


def build_server() -> MCPServer:
    mcp = MCPServer(
        name="noey-studio-blog",
        title="Noey Studio blog",
        instructions=INSTRUCTIONS,
        website_url="https://noeystudio.com",
        version="1.0.0",
    )

    @mcp.tool(
        annotations=READ,
        description=(
            "Product facts and the brand's writing rules for noeystudio.com articles: product description, audience, "
            "real features (modes), what the product can and cannot do (scope), plans and live prices, CTA links, the "
            "existing /guide articles (link to them; never write a post on the same topic), the WRITING RULES every "
            "post must follow, the brand kit (colours, fonts, logo, icons, canvas sizes, a minimal visual and cover "
            "example), the owner's writing brief (with updated_at) and the content-plan topics not written yet. "
            "Call this first."
        ),
    )
    async def get_site_info(ctx: Context) -> dict[str, Any]:
        await _begin(ctx)
        async with _db() as db:
            return await site_info.site_info(db, min_words=get_settings().blog_min_words)

    @mcp.tool(
        annotations=READ,
        description=(
            "List blog posts in every status (draft, published, unpublished), newest first — use it to avoid "
            "repeating a topic or slug. Returns slug, title, status, category, tags and published_at."
        ),
    )
    async def list_posts(
        ctx: Context,
        status: Annotated[
            Literal["draft", "published", "unpublished"] | None, Field(description="Only this status; omit for all.")
        ] = None,
        limit: Annotated[int, Field(ge=1, le=100, description="Page size.")] = 20,
        cursor: Annotated[str | None, Field(description="`next_cursor` from the previous page.")] = None,
    ) -> dict[str, Any]:
        await _begin(ctx)
        offset = int(cursor) if cursor and cursor.isdigit() else 0
        async with _db() as db:
            items, total = await service.list_all(db, status=status, limit=limit, offset=offset)
        nxt = offset + len(items)
        return {"items": items, "total": total, "next_cursor": str(nxt) if nxt < total else None}

    @mcp.tool(annotations=READ, description="Every field of one post (any status), including content_md, faq and status.")
    async def get_post(ctx: Context, slug: Slug) -> dict[str, Any]:
        await _begin(ctx)
        async with _db() as db:
            post = await service.get_post_row(db, slug)
            if post is None:
                raise ToolError(f"No post with slug `{slug}`. Use list_posts to see existing slugs.")
            return await service.post_full(db, post, internal=True)

    @mcp.tool(
        annotations=WRITE,
        description=(
            "Create a blog post. It is ALWAYS saved as a draft (call publish_post next). Requirements: unique slug "
            "(lowercase a-z0-9-, <= 80), meta_title <= 60, meta_description <= 160, excerpt <= 300 chars; content_md "
            "in Markdown with headings from `##`, no raw HTML/script/iframe; a cover (cover_image_url from "
            "render_cover or list_media, with cover_alt); at least 2 pictures in the body, each with alt text: "
            "`::visual[alt](id)` lines from create_visual (yours only, at most 3 animated) and/or `![alt](url)` "
            "images or .mp4 demos from list_media; PDF links `[text](url)` only from list_media; at least "
            f"2 links to pages of this site, at least {get_settings().blog_min_words} words; an existing category "
            f"slug (list_categories); {v.FAQ_MIN}-{v.FAQ_MAX} FAQ pairs; never name an AI vendor. A refusal lists "
            "every problem to fix."
        ),
    )
    async def create_post(
        ctx: Context,
        slug: Annotated[str, Field(min_length=1, max_length=v.SLUG_MAX, description="URL slug, lowercase a-z0-9 and hyphens.")],
        title: Annotated[str, Field(min_length=1, max_length=v.TITLE_MAX, description="Article title (H1), Thai.")],
        meta_title: Annotated[str, Field(min_length=1, max_length=v.META_TITLE_MAX, description="SEO title, <= 60 chars.")],
        meta_description: Annotated[
            str, Field(min_length=1, max_length=v.META_DESCRIPTION_MAX, description="Meta description, <= 160 chars.")
        ],
        excerpt: Annotated[str, Field(min_length=1, max_length=v.EXCERPT_MAX, description="Listing summary, <= 300 chars.")],
        content_md: Annotated[str, Field(min_length=1, max_length=v.CONTENT_MAX_CHARS, description="Markdown body (headings from ##).")],
        category: Annotated[str, Field(min_length=1, max_length=80, description="Existing category slug.")],
        faq: Annotated[list[FaqItem], Field(min_length=v.FAQ_MIN, max_length=v.FAQ_MAX, description="FAQ pairs, plain text.")],
        tags: Annotated[list[TagIn], Field(max_length=v.MAX_TAGS, description="Up to 8 tags.")] = [],  # noqa: B006
        cover_image_url: Annotated[
            str | None, Field(max_length=500, description="The url from render_cover (or an image from list_media).")
        ] = None,
        cover_alt: Annotated[str | None, Field(max_length=v.ALT_MAX, description="Cover alt text (required with a cover).")] = None,
    ) -> dict[str, Any]:
        actor, _ = await _begin(ctx)
        data = NewPost(
            slug=slug, title=title, meta_title=meta_title, meta_description=meta_description, excerpt=excerpt,
            content_md=content_md, category=category, faq=faq, tags=tags,
            cover_image_url=cover_image_url, cover_alt=cover_alt,
        )
        try:
            async with _db() as db:
                post = await service.create_post(db, data, actor)
                return {"slug": post.slug, "status": post.status, "message": "Saved as a draft. Call publish_post to publish."}
        except service.BlogError as exc:
            raise _fail(exc) from None

    @mcp.tool(
        annotations=WRITE,
        description=(
            "Change fields of a post this AI wrote (source = ai). Omitted fields keep their value; the whole post is "
            "re-validated with the create_post rules. Posts the owner wrote or edited (source = human) cannot be "
            "changed. new_slug works only before the first publish. A published post is updated live."
        ),
    )
    async def update_post(
        ctx: Context,
        slug: Slug,
        changes: Annotated[PostChanges, Field(description="Only the fields to change.")],
    ) -> dict[str, Any]:
        actor, _ = await _begin(ctx)
        try:
            async with _db() as db:
                post = await service.update_post(db, slug, changes, actor, by_admin=False)
                return {"slug": post.slug, "status": post.status, "message": "Updated."}
        except service.BlogError as exc:
            raise _fail(exc) from None

    @mcp.tool(
        annotations=WRITE,
        description=(
            "Publish a draft. Respects the owner's switches: when auto-publish is off the post waits for the owner's "
            "approval (nothing more to do); at most BLOG_MAX_PUBLISH_PER_DAY publishes per Asia/Bangkok day — when "
            "reached, the reply says when publishing is possible again. The slug is locked after the first publish."
        ),
    )
    async def publish_post(ctx: Context, slug: Slug) -> dict[str, Any]:
        actor, _ = await _begin(ctx)
        try:
            async with _db() as db:
                result = await service.publish(db, slug, actor, by_admin=False)
                return {
                    "slug": slug,
                    "outcome": result.outcome,
                    "status": result.post.status,
                    "url": f"{site_info._static()['product']['site_url'].rstrip('/')}/blog/{slug}"
                    if result.outcome != "awaiting_owner" else None,
                    "message": result.message,
                }
        except service.BlogError as exc:
            raise _fail(exc) from None

    @mcp.tool(
        annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True, idempotent_hint=True, open_world_hint=False),
        description="Take a post offline (status unpublished). It is kept, never deleted; the owner can republish it.",
    )
    async def unpublish_post(ctx: Context, slug: Slug) -> dict[str, Any]:
        actor, _ = await _begin(ctx)
        try:
            async with _db() as db:
                post = await service.unpublish(db, slug, actor, by_admin=False)
                return {"slug": post.slug, "status": post.status}
        except service.BlogError as exc:
            raise _fail(exc) from None

    @mcp.tool(
        annotations=WRITE,
        description=(
            "Upload a SMALL image (base64 <= 300 KB) — e.g. a tiny diagram you already have as a file. For pictures in "
            "a post use create_visual (drawn HTML), render_cover (the cover) or list_media (the owner's real "
            "screenshots and videos) instead. PNG, JPEG or WebP only (checked by content); re-encoded to WebP "
            "(metadata removed, longest side <= 1600 px) and named by its hash. alt is required. Returns "
            "{url, width, height}: use it as ![alt](url)."
        ),
    )
    async def upload_image(
        ctx: Context,
        image_base64: Annotated[
            str, Field(min_length=8, max_length=UPLOAD_IMAGE_MAX_BASE64, description="The file bytes, base64 (<= 300 KB).")
        ],
        filename: Annotated[str, Field(min_length=1, max_length=200, description="Original file name (informational only).")],
        alt: Annotated[str, Field(min_length=3, max_length=v.ALT_MAX, description="What the image shows, Thai.")],
    ) -> dict[str, Any]:
        actor, _ = await _begin(ctx)
        if v.banned_terms([alt]):
            raise ToolError("alt names an AI vendor — describe the picture instead.")
        try:
            data = media.decode_base64(image_base64)
            encoded, width, height = media.reencode(data)
            stored = await media.store(encoded, width, height)
        except media.ImageRejected as exc:
            async with _db() as db:
                await service.audit(db, actor, "upload_image", None, False, {"filename": filename, "refused": str(exc)})
            raise ToolError(str(exc)) from None
        async with _db() as db:
            await service.record_image(db, stored, alt.strip(), actor)
        return {"url": stored.url, "width": stored.width, "height": stored.height, "alt": alt.strip()}

    @mcp.tool(
        annotations=WRITE,
        description=(
            "Create an in-article visual — a still picture, infographic, chart or animation drawn with HTML + CSS "
            "(+ optional JS) that the page shows exactly like an image: fixed aspect ratio (width x height is your "
            "designed canvas, e.g. 1600x1000, 1200x1200, 1080x1350), scaled to the column, not clickable or "
            "selectable, no scrollbars. Nothing is rendered on the server; it is stored and served sandboxed. "
            "Rules: html + css + js <= 200 KB; no <iframe>, <form>, <a>, <input>, <object>, <embed>, <link>, <meta>, "
            "<base>, @import, @font-face or event-handler attributes (put JS in `js`); images only from the media "
            "store (list_media) or data:image; fonts 'Noto Sans Thai' / 'IBM Plex Sans Thai' are preloaded; icons "
            "via get_icons (inline SVG); no network access. Set animated: true when it moves (CSS animation or "
            "requestAnimationFrame) — at most 3 animated visuals per post; the page pauses them off-screen and for "
            "reduced-motion readers. Returns {id, markdown}: paste markdown (`::visual[alt](id)`) on its own line "
            "in content_md. A refusal names every spot to fix."
        ),
    )
    async def create_visual(
        ctx: Context,
        html: Annotated[str, Field(min_length=1, max_length=200 * 1024, description="The markup inside the canvas (no <html>/<head>).")],
        css: Annotated[str, Field(max_length=200 * 1024, description="Styles for that markup.")],
        width: Annotated[int, Field(ge=200, le=2400, description="Designed canvas width in CSS px, e.g. 1600.")],
        height: Annotated[int, Field(ge=200, le=2400, description="Designed canvas height in CSS px, e.g. 1000.")],
        alt: Annotated[str, Field(min_length=3, max_length=v.ALT_MAX, description="What the visual shows, Thai (screen readers and search read it).")],
        animated: Annotated[bool, Field(description="true when anything moves.")],
        js: Annotated[str, Field(max_length=200 * 1024, description="Optional script (runs sandboxed, no network).")] = "",
        caption: Annotated[str | None, Field(max_length=300, description="Optional caption shown under it, Thai.")] = None,
        filename: Annotated[str | None, Field(max_length=200, description="Optional name, informational only.")] = None,
    ) -> dict[str, Any]:
        actor, _ = await _begin(ctx)
        from packages.blog import visual

        problems: list[str] = []
        if v.banned_terms([alt, caption, html, css]):
            problems.append("Do not name AI vendors or models in a visual, its alt text or caption.")
        prepared, more, media_urls = visual.prepare(
            html=html, css=css, js=js, width=width, height=height, actor=actor, media_base=media.media_base()
        )
        problems += more
        async with _db() as db:
            if media_urls:
                problems += await _missing_images(db, media_urls)
            if problems or prepared is None:
                await service.audit(
                    db, actor, "create_visual", None, False,
                    {"bytes": len(html) + len(css) + len(js), "w": width, "h": height, "problems": problems[:25]},
                )
                raise ToolError("Refused (invalid_visual). Fix the following and call again:\n" + "\n".join(f"- {p}" for p in problems))
        await visual.store(prepared)
        async with _db() as db:
            await service.record_visual(
                db, visual_id=prepared.id, key=prepared.key, width=width, height=height, alt=alt.strip(),
                caption=(caption or "").strip() or None, animated=animated, size=len(prepared.document), actor=actor,
            )
        return {
            "id": prepared.id,
            "markdown": visual.markdown_for(prepared.id, alt.strip()),
            "preview_url": visual.public_url(prepared.id),
            "width": width,
            "height": height,
            "animated": animated,
        }

    @mcp.tool(
        annotations=WRITE,
        description=(
            "Draw the post's COVER as a real 1600x900 WebP image (used as cover_image_url, og:image and in search "
            "results). Send html + css; the server lays it out without a browser, so only this CSS subset works: "
            "flexbox (display:flex — every <div> with more than one child needs it), position relative/absolute, "
            "sizes, padding/margin, linear/radial gradients, border, border-radius, box-shadow, text-shadow, opacity, "
            "transform, font-family 'Noto Sans Thai' or 'IBM Plex Sans Thai' (weights 400-700), inline <svg> icons "
            "from get_icons and <img> from the media store with width/height. NOT supported: CSS grid, "
            "inline/inline-block/table layout, animation/transition, JavaScript, external URLs, @import/@font-face, "
            "emoji. The root element should be 1600x900. A refusal names each spot to fix. Returns {url, width, height}."
        ),
    )
    async def render_cover(
        ctx: Context,
        html: Annotated[str, Field(min_length=1, max_length=100 * 1024, description="The cover markup.")],
        css: Annotated[str, Field(max_length=100 * 1024, description="Styles (selectors are inlined before drawing).")],
        alt: Annotated[str, Field(min_length=3, max_length=v.ALT_MAX, description="What the cover shows, Thai — use it as cover_alt.")],
    ) -> dict[str, Any]:
        actor, gid = await _begin(ctx)
        from packages.blog import cover

        limit = ratelimit.Limit("blog_cover:grant", max(1, get_settings().blog_cover_calls_per_min), 60)
        try:
            await ratelimit.enforce([(limit, f"grant:{gid}")])
        except HTTPException:
            raise ToolError(f"Cover limit reached ({limit.max_hits} per minute). Wait a minute and retry.") from None
        detail: dict[str, Any] = {"bytes": len(html) + len(css)}
        try:
            if v.banned_terms([alt, html]):
                raise cover.CoverError("Do not name AI vendors or models on the cover or in its alt text.")
            checked = cover.check(html, css)
            async with _db() as db:
                missing = await _missing_images(db, checked.media_urls)
            if missing:
                raise cover.CoverError(missing)
            png = await cover.draw(checked)
            body, w, h = cover.to_webp(png)
        except cover.CoverError as exc:
            async with _db() as db:
                await service.audit(db, actor, "render_cover", None, False, {**detail, "refused": exc.code, "problems": exc.problems[:25]})
            raise ToolError(f"Refused ({exc.code}). Fix the following and call again:\n" + "\n".join(f"- {p}" for p in exc.problems)) from None
        stored = await media.store_bytes(body, "webp", width=w, height=h)
        async with _db() as db:
            await service.record_image(db, stored, alt.strip(), actor, origin="render_cover")
        return {"url": stored.url, "width": w, "height": h, "alt": alt.strip()}

    @mcp.tool(
        annotations=READ,
        description=(
            "The owner's media library: real screenshots, demo videos (MP4), logos and PDF files, with alt text, "
            "description and tags. Use images/videos in content_md as `![alt](url)` (a video plays muted and looped "
            "with its poster), PDFs as links `[text](url)`, images inside create_visual or render_cover, or an image "
            "as the cover. Filter by kind (screenshot | demo | logo | file) and/or tag."
        ),
    )
    async def list_media(
        ctx: Context,
        kind: Annotated[
            Literal["screenshot", "demo", "logo", "file"] | None, Field(description="Only this kind; omit for all.")
        ] = None,
        tag: Annotated[str | None, Field(max_length=40, description="Only items with this tag.")] = None,
    ) -> dict[str, Any]:
        await _begin(ctx)
        from packages.blog import library

        async with _db() as db:
            rows, total = await library.list_items(db, category=kind, tag=tag, limit=200)
            return {"items": [library.item_out(r) for r in rows], "total": total}

    @mcp.tool(
        annotations=READ,
        description=(
            "Lucide icons as inline <svg> elements to paste into create_visual or render_cover html (icon fonts and "
            "<i data-lucide> do not work). Give exact names (see https://lucide.dev/icons), e.g. ['scissors', "
            "'captions', 'clapperboard']; unknown names come back with close matches. Size and colour are set here "
            "and can be changed on the pasted <svg> (width/height, stroke)."
        ),
    )
    async def get_icons(
        ctx: Context,
        names: Annotated[list[Annotated[str, Field(max_length=60)]], Field(min_length=1, max_length=20, description="Icon names.")],
        size: Annotated[int, Field(ge=8, le=512, description="Pixel size.")] = 48,
        color: Annotated[str, Field(pattern=r"^#[0-9a-fA-F]{6}$", description="Stroke colour, #rrggbb.")] = "#b68235",
        stroke: Annotated[float, Field(ge=0.5, le=4, description="Stroke width.")] = 2,
    ) -> dict[str, Any]:
        await _begin(ctx)
        from packages.blog import kit

        icons: dict[str, str] = {}
        unknown: dict[str, list[str]] = {}
        for raw in names:
            name = raw.strip().lower()
            svg = kit.icon_svg(name, size=size, color=color, stroke=stroke)
            if svg is None:
                unknown[name] = kit.icon_search(name.split("-")[0], limit=8)
            else:
                icons[name] = svg
        return {"icons": icons, "unknown": unknown, "set": kit.icon_set()}

    @mcp.tool(
        annotations=WRITE,
        description=(
            "Link a content-plan topic (get_site_info content_plan[].id) to the post that covers it, marking the "
            "topic done. Call it after create_post for the topic you wrote."
        ),
    )
    async def mark_topic_done(
        ctx: Context,
        topic_id: Annotated[int, Field(ge=1, description="content_plan[].id")],
        slug: Slug,
    ) -> dict[str, Any]:
        actor, _ = await _begin(ctx)
        from packages.blog import brief

        try:
            async with _db() as db:
                item = await brief.mark_done(db, topic_id, slug, actor)
                return {"topic": item, "message": "Marked done."}
        except service.BlogError as exc:
            raise _fail(exc) from None

    @mcp.tool(annotations=READ, description="The fixed set of categories (slug, name, description). New ones cannot be created.")
    async def list_categories(ctx: Context) -> dict[str, Any]:
        await _begin(ctx)
        async with _db() as db:
            return {"categories": await service.categories_with_counts(db)}

    @mcp.tool(annotations=READ, description="Every existing tag (slug, name, post_count). Reuse tags instead of near-duplicates.")
    async def list_tags(ctx: Context) -> dict[str, Any]:
        await _begin(ctx)
        async with _db() as db:
            return {"tags": await service.tags_with_counts(db, published_only=False)}

    return mcp


#: The tool names — tests pin this list (and that no delete exists).
TOOL_NAMES = (
    "get_site_info", "list_posts", "get_post", "create_post", "update_post", "publish_post",
    "unpublish_post", "upload_image", "create_visual", "render_cover", "list_media", "get_icons",
    "mark_topic_done", "list_categories", "list_tags",
)


# ── HTTP: runtime, auth wrappers, OAuth routes ──────────────────────────────


class _Runtime:
    server: MCPServer | None = None


_runtime = _Runtime()


@asynccontextmanager
async def run() -> AsyncIterator[MCPServer]:
    """Build a fresh server and run its session manager (once per process — the
    API lifespan, or a test). The /mcp route serves whichever is current."""
    server = build_server()
    server.streamable_http_app(
        stateless_http=True,
        json_response=True,
        max_request_body_size=MAX_BODY_BYTES,
        # Bearer auth is mandatory on every request, so DNS rebinding cannot
        # reach anything; the Host check would only break the public domain.
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )
    async with server.session_manager.run():
        previous, _runtime.server = _runtime.server, server
        try:
            yield server
        finally:
            _runtime.server = previous


async def _mcp_asgi(scope: Scope, receive: Receive, send: Send) -> None:
    server = _runtime.server
    if server is None:
        response = JSONResponse({"error": "MCP server is not running"}, status_code=503)
        await response(scope, receive, send)
        return
    await server.session_manager.handle_request(scope, receive, send)


def _prm_url() -> str:
    return f"{oauth.issuer()}/.well-known/oauth-protected-resource/mcp"


class _RequireBlogScope(RequireAuthMiddleware):
    """The SDK's 401/403, plus `scope=` in WWW-Authenticate (the MCP spec's
    SHOULD) and a resource_metadata URL read from settings per request."""

    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app, [oauth.SCOPE], None)

    async def _send_auth_error(self, send: Send, status_code: int, error: str, description: str) -> None:
        value = (
            f'Bearer error="{error}", error_description="{description}", '
            f'scope="{oauth.SCOPE}", resource_metadata="{_prm_url()}"'
        )
        body = json.dumps({"error": error, "error_description": description}).encode()
        await send({
            "type": "http.response.start",
            "status": status_code,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
                (b"www-authenticate", value.encode()),
                (b"cache-control", b"no-store"),
            ],
        })
        await send({"type": "http.response.body", "body": body})


_provider = oauth.BlogOAuthProvider()


class _ResourceCheckingBackend(BearerAuthBackend):
    """Only tokens bound to THIS resource (RFC 8707), compared per request."""

    def __init__(self) -> None:
        super().__init__(_provider)

    async def authenticate(self, conn):  # type: ignore[no-untyped-def]
        self.resource_server_url = AnyHttpUrl(oauth.resource_url())
        return await super().authenticate(conn)


def _mcp_endpoint() -> ASGIApp:
    return AuthenticationMiddleware(
        AuthContextMiddleware(_RequireBlogScope(_mcp_asgi)),
        backend=_ResourceCheckingBackend(),
    )


class _Limited:
    """Per-IP limit in front of an OAuth endpoint (registration and token floods).

    A class, not a function: Starlette treats a plain function endpoint as a
    request handler, an object with ``__call__`` as an ASGI app."""

    def __init__(self, app: ASGIApp, rule: ratelimit.Limit) -> None:
        self.app = app
        self.rule = rule

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        request = Request(scope)
        try:
            await ratelimit.enforce([(self.rule, ratelimit.client_ip(request))])
        except HTTPException as exc:
            await JSONResponse(
                {"error": "temporarily_unavailable" if exc.status_code == 503 else "slow_down",
                 "error_description": "Too many requests."},
                status_code=exc.status_code,
                headers=dict(exc.headers or {}),
            )(scope, receive, send)
            return
        await self.app(scope, receive, send)


_limited = _Limited


OAUTH_REGISTER_IP = ratelimit.Limit("blog_oauth_register:ip", 10, 60 * 60)
OAUTH_AUTHORIZE_IP = ratelimit.Limit("blog_oauth_authorize:ip", 30, 15 * 60)
OAUTH_TOKEN_IP = ratelimit.Limit("blog_oauth_token:ip", 120, 15 * 60)

AUTHORIZE_PATH = "/mcp/oauth/authorize"
TOKEN_PATH = "/mcp/oauth/token"
REGISTER_PATH = "/mcp/oauth/register"
REVOKE_PATH = "/mcp/oauth/revoke"


def authorization_server_metadata() -> dict[str, Any]:
    base = oauth.issuer()
    meta = build_metadata(
        AnyHttpUrl(base),
        None,
        ClientRegistrationOptions(enabled=True, valid_scopes=[oauth.SCOPE], default_scopes=[oauth.SCOPE]),
        RevocationOptions(enabled=True),
    ).model_dump(mode="json", exclude_none=True)
    meta.update({
        "issuer": base,
        "authorization_endpoint": f"{base}{AUTHORIZE_PATH}",
        "token_endpoint": f"{base}{TOKEN_PATH}",
        "registration_endpoint": f"{base}{REGISTER_PATH}",
        "revocation_endpoint": f"{base}{REVOKE_PATH}",
        "scopes_supported": [oauth.SCOPE],
        # Public clients (DCR with token_endpoint_auth_method "none") are
        # accepted; PKCE is what protects their code.
        "token_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic", "none"],
        "revocation_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic", "none"],
        "code_challenge_methods_supported": ["S256"],
    })
    return meta


def protected_resource_metadata() -> dict[str, Any]:
    return {
        "resource": oauth.resource_url(),
        "authorization_servers": [oauth.issuer()],
        "scopes_supported": [oauth.SCOPE],
        "bearer_methods_supported": ["header"],
        "resource_name": "Noey Studio blog",
    }


def _json_handler(build: Callable[[], dict[str, Any]]) -> Callable[[Request], Any]:
    async def handler(request: Request) -> Response:
        if request.method == "OPTIONS":
            return Response(status_code=204, headers={"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS"})
        return JSONResponse(build(), headers={"Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*"})

    return handler


def routes() -> list[BaseRoute]:
    authenticator = ClientAuthenticator(_provider)
    registration = RegistrationHandler(
        _provider,  # type: ignore[arg-type]
        options=ClientRegistrationOptions(enabled=True, valid_scopes=[oauth.SCOPE], default_scopes=[oauth.SCOPE]),
    )
    return [
        Route("/mcp", endpoint=_mcp_endpoint(), methods=["GET", "POST", "DELETE"]),
        Route("/.well-known/oauth-protected-resource/mcp", endpoint=_json_handler(protected_resource_metadata), methods=["GET", "OPTIONS"]),
        Route("/.well-known/oauth-protected-resource", endpoint=_json_handler(protected_resource_metadata), methods=["GET", "OPTIONS"]),
        Route("/.well-known/oauth-authorization-server", endpoint=_json_handler(authorization_server_metadata), methods=["GET", "OPTIONS"]),
        Route(
            AUTHORIZE_PATH,
            endpoint=_limited(request_response(AuthorizationHandler(_provider).handle), OAUTH_AUTHORIZE_IP),  # type: ignore[arg-type]
            methods=["GET", "POST"],
        ),
        Route(
            TOKEN_PATH,
            endpoint=_limited(request_response(TokenHandler(_provider, authenticator).handle), OAUTH_TOKEN_IP),  # type: ignore[arg-type]
            methods=["POST"],
        ),
        Route(REGISTER_PATH, endpoint=_limited(request_response(registration.handle), OAUTH_REGISTER_IP), methods=["POST"]),
        Route(
            REVOKE_PATH,
            endpoint=_limited(request_response(RevocationHandler(_provider, authenticator).handle), OAUTH_TOKEN_IP),  # type: ignore[arg-type]
            methods=["POST"],
        ),
    ]
