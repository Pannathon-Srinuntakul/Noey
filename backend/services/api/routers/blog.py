"""Public, read-only blog API — the shape is fixed by BLOG_CONTRACT.md (repo root).

GET /blog/posts?page&per_page&category&tag   published posts, newest first
GET /blog/posts/{slug}                       one published post (404 otherwise)
GET /blog/slugs                              every published slug + updated_at
GET /blog/categories                         categories + published post counts
GET /blog/tags                               tags with >= 1 published post
GET /blog/media/{name}                       blog images (bucket `blog/` or DATA_DIR/blog)

No auth; every answer is `Cache-Control: public, max-age=60`. Only
`status = published` posts ever leave this router.
"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response
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


@router.get("/media/{name}", include_in_schema=False)
async def blog_media(name: str) -> Response:
    """A blog image (`<sha256>.webp`, from the bucket's `blog/` or DATA_DIR/blog).
    Content-addressed, so cacheable forever — Cloudflare keeps it at the edge."""
    body = await media.read(name)
    if body is None:
        raise HTTPException(status_code=404, detail="not found")
    return Response(
        content=body,
        media_type="image/webp",
        headers={"Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff"},
    )
