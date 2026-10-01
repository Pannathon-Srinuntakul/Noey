"""Admin: blog moderation and the blog MCP connectors.

The same guard as routers/admin.py: the router-level IP allowlist plus
``current_admin`` on every route. Included by services/api/main.py at the top
level (not nested inside the admin router) so tests/test_admin_security.py's
route walk sees the full `/admin/blog/...` paths and denial-tests each one.

GET  /admin/blog/posts                       every status, filter by status/source
GET  /admin/blog/posts/{slug}                one post, every field (preview/edit)
PUT  /admin/blog/posts/{slug}                edit — the post becomes source = human
POST /admin/blog/posts/{slug}/publish        no daily cap for the owner
POST /admin/blog/posts/{slug}/unpublish
GET  /admin/blog/categories
GET/PUT /admin/blog/settings                 auto-publish switch + daily cap (overrides env)
GET  /admin/blog/audit                       the blog audit log
GET  /admin/blog/connectors                  approved OAuth clients (grants)
POST /admin/blog/connectors/{grant_id}/revoke
GET  /admin/blog/oauth/requests/{request_id}             the consent screen's data
POST /admin/blog/oauth/requests/{request_id}/approve     → {redirect_to}
POST /admin/blog/oauth/requests/{request_id}/deny        → {redirect_to}
"""

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.blog import oauth, service
from packages.blog.schemas import PostChanges
from packages.db.models.blog import BlogAuditLog
from services.api.admin_deps import CurrentAdmin, admin_ip_allowed
from services.api.deps import core_session

router = APIRouter(prefix="/admin/blog", tags=["admin"], dependencies=[Depends(admin_ip_allowed)])

CoreSession = Annotated[AsyncSession, Depends(core_session)]


class SettingsIn(BaseModel):
    #: null = follow the server's BLOG_AUTO_PUBLISH again.
    auto_publish: bool | None = None
    #: null = follow BLOG_MAX_PUBLISH_PER_DAY again.
    max_per_day: int | None = Field(default=None, ge=0, le=50)


def _actor(admin: Any) -> str:
    return f"admin:{admin.user_id}"


def _refusal(exc: service.BlogError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=" · ".join(exc.problems))


def _config_out(cfg: service.BlogConfig, used_today: int) -> dict[str, Any]:
    return {
        "auto_publish": cfg.auto_publish,
        "max_per_day": cfg.max_per_day,
        "auto_publish_source": cfg.auto_publish_source,
        "max_per_day_source": cfg.max_per_day_source,
        "published_today_via_mcp": used_today,
        "next_reset_at": service.iso(service.next_bangkok_midnight()),
    }


@router.get("/posts")
async def posts(
    admin: CurrentAdmin,
    db: CoreSession,
    status: Literal["draft", "published", "unpublished"] | None = None,
    source: Literal["ai", "human"] | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> dict[str, Any]:
    items, total = await service.list_all(db, status=status, source=source, limit=limit, offset=offset)
    return {"items": items, "total": total}


@router.get("/posts/{slug}")
async def post(slug: str, admin: CurrentAdmin, db: CoreSession) -> dict[str, Any]:
    row = await service.get_post_row(db, slug)
    if row is None:
        raise HTTPException(status_code=404, detail="ไม่พบบทความ")
    return await service.post_full(db, row, internal=True)


@router.put("/posts/{slug}")
async def edit(slug: str, body: PostChanges, admin: CurrentAdmin, db: CoreSession) -> dict[str, Any]:
    try:
        row = await service.update_post(db, slug, body, _actor(admin), by_admin=True)
    except service.BlogError as exc:
        raise _refusal(exc) from None
    return await service.post_full(db, row, internal=True)


@router.post("/posts/{slug}/publish")
async def publish(slug: str, admin: CurrentAdmin, db: CoreSession) -> dict[str, Any]:
    try:
        result = await service.publish(db, slug, _actor(admin), by_admin=True)
    except service.BlogError as exc:
        raise _refusal(exc) from None
    return {"outcome": result.outcome, "post": await service.post_full(db, result.post, internal=True)}


@router.post("/posts/{slug}/unpublish")
async def unpublish(slug: str, admin: CurrentAdmin, db: CoreSession) -> dict[str, Any]:
    try:
        row = await service.unpublish(db, slug, _actor(admin), by_admin=True)
    except service.BlogError as exc:
        raise _refusal(exc) from None
    return {"post": await service.post_full(db, row, internal=True)}


@router.get("/categories")
async def categories(admin: CurrentAdmin, db: CoreSession) -> list[dict[str, Any]]:
    return await service.categories_with_counts(db)


@router.get("/settings")
async def get_settings_(admin: CurrentAdmin, db: CoreSession) -> dict[str, Any]:
    return _config_out(await service.load_config(db), await service.publishes_today(db))


@router.put("/settings")
async def put_settings(body: SettingsIn, admin: CurrentAdmin, db: CoreSession) -> dict[str, Any]:
    _, after = await service.save_config(
        db, auto_publish=body.auto_publish, max_per_day=body.max_per_day, admin_user_id=admin.user_id
    )
    return _config_out(after, await service.publishes_today(db))


@router.get("/audit")
async def audit(
    admin: CurrentAdmin, db: CoreSession, limit: Annotated[int, Query(ge=1, le=500)] = 100
) -> list[dict[str, Any]]:
    rows = (await db.execute(select(BlogAuditLog).order_by(BlogAuditLog.id.desc()).limit(limit))).scalars()
    return [
        {"id": int(r.id), "at": service.iso(r.at), "actor": r.actor, "action": r.action, "slug": r.slug, "ok": r.ok, "detail": r.detail}
        for r in rows
    ]


@router.get("/connectors")
async def connectors(admin: CurrentAdmin, db: CoreSession) -> list[dict[str, Any]]:
    return await oauth.list_grants(db)


@router.post("/connectors/{grant_id}/revoke")
async def revoke(grant_id: int, admin: CurrentAdmin, db: CoreSession) -> dict[str, Any]:
    changed = await oauth.revoke_grant(db, grant_id, "admin_revoke", _actor(admin))
    return {"grant_id": grant_id, "revoked": changed}


@router.get("/oauth/requests/{request_id}")
async def consent_request(request_id: str, admin: CurrentAdmin, db: CoreSession) -> dict[str, Any]:
    try:
        req, client = await oauth.pending_request(db, request_id)
    except oauth.ConsentError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from None
    return oauth.describe_request(req, client)


@router.post("/oauth/requests/{request_id}/approve")
async def approve(request_id: str, admin: CurrentAdmin, db: CoreSession) -> dict[str, str]:
    try:
        target = await oauth.approve(db, request_id, admin.user)
    except oauth.ConsentError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from None
    return {"redirect_to": target}


@router.post("/oauth/requests/{request_id}/deny")
async def deny(request_id: str, admin: CurrentAdmin, db: CoreSession) -> dict[str, str]:
    try:
        target = await oauth.deny(db, request_id, admin.user)
    except oauth.ConsentError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from None
    return {"redirect_to": target}
