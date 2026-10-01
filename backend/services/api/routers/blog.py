"""Public, read-only blog API — the shape is fixed by BLOG_CONTRACT.md (repo root).

GET /blog/posts?page&per_page&category&tag   published posts, newest first
GET /blog/posts/{slug}                       one published post (404 otherwise)
GET /blog/slugs                              every published slug + updated_at
GET /blog/categories                         categories + published post counts
GET /blog/tags                               tags with >= 1 published post
GET /blog/media/{name}                       blog media: WebP, MP4 (Range), PDF (download)

No auth; every answer is `Cache-Control: public, max-age=60`. Only
`status = published` posts ever leave this router.
"""

import re
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from packages.blog import media, service
from services.api.deps import core_session

router = APIRouter(prefix="/blog", tags=["blog"])

CoreSession = Annotated[AsyncSession, Depends(core_session)]
CACHE = "public, max-age=60"
SlugParam = Annotated[str, Query(max_length=80, pattern=r"^[a-z0-9-]+$")]


def _cache(response: Response) -> None:
    response.headers["Cache-Control"] = CACHE


@router.get("/posts")
async def list_posts(
    response: Response,
    db: CoreSession,
    page: Annotated[int, Query(ge=1, le=10_000)] = 1,
    per_page: Annotated[int, Query(ge=1, le=50)] = 12,
    category: SlugParam | None = None,
    tag: SlugParam | None = None,
) -> dict[str, Any]:
    _cache(response)
    return await service.list_published(db, page=page, per_page=per_page, category=category, tag=tag)


@router.get("/posts/{slug}")
async def get_post(slug: str, response: Response, db: CoreSession) -> dict[str, Any]:
    post = await service.get_post_row(db, slug) if len(slug) <= 80 else None
    if post is None or post.status != "published":
        raise HTTPException(status_code=404, detail="not found", headers={"Cache-Control": CACHE})
    _cache(response)
    return await service.post_full(db, post)


@router.get("/slugs")
async def slugs(response: Response, db: CoreSession) -> list[dict[str, Any]]:
    _cache(response)
    return await service.published_slugs(db)


@router.get("/categories")
async def categories(response: Response, db: CoreSession) -> list[dict[str, Any]]:
    _cache(response)
    return await service.categories_with_counts(db)


@router.get("/tags")
async def tags(response: Response, db: CoreSession) -> list[dict[str, Any]]:
    _cache(response)
    return await service.tags_with_counts(db, published_only=True)


#: Every media answer: content-addressed, so cacheable forever (Cloudflare
#: keeps it at the edge), never sniffed, and inert if opened as a document.
_MEDIA_HEADERS = {
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "cross-origin",
}
_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


@router.get("/media/{name}", include_in_schema=False)
async def blog_media(name: str, request: Request) -> Response:
    """A blog media file (`<sha256>.webp|mp4|pdf`, from the bucket's `blog/` or
    DATA_DIR/blog). Videos answer byte ranges (Safari will not play a video
    without them); a PDF is always a download, never rendered inline."""
    body = await media.read(name)
    if body is None:
        raise HTTPException(status_code=404, detail="not found")
    ext = name.rsplit(".", 1)[1]
    headers = dict(_MEDIA_HEADERS)
    if ext == "pdf":
        headers["Content-Disposition"] = f'attachment; filename="{name}"'
    if ext == "mp4":
        headers["Accept-Ranges"] = "bytes"
        m = _RANGE_RE.match(request.headers.get("range", "").strip())
        if m and (m.group(1) or m.group(2)):
            size = len(body)
            if m.group(1):
                start = int(m.group(1))
                end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
            else:  # a suffix range: the last N bytes
                start, end = max(0, size - int(m.group(2))), size - 1
            if start >= size or start > end:
                return Response(status_code=416, headers={**headers, "Content-Range": f"bytes */{size}"})
            headers["Content-Range"] = f"bytes {start}-{end}/{size}"
            return Response(content=body[start : end + 1], status_code=206, media_type=media.MIME[ext], headers=headers)
    return Response(content=body, media_type=media.MIME[ext], headers=headers)
