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
GET/POST /admin/blog/media                   the media library (คลังสื่อ): list / upload (multipart)
PATCH /admin/blog/media/{item_id}            alt, description, tags, archive
GET/PUT /admin/blog/brief                    the writing brief
GET/POST /admin/blog/plan                    the content plan / add a topic
PUT  /admin/blog/plan/order                  reorder (every id, in the new order)
PATCH/DELETE /admin/blog/plan/{item_id}      edit (topic, notes, status, post) / remove a topic
"""

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.blog import brief, library, oauth, service
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


# ── media library (คลังสื่อ) ────────────────────────────────────────────────


class MediaChanges(BaseModel):
    alt: str | None = Field(default=None, max_length=300)
    description: str | None = Field(default=None, max_length=library.DESCRIPTION_MAX)
    tags: list[Annotated[str, Field(max_length=library.TAG_MAX)]] | None = Field(default=None, max_length=library.MAX_TAGS)
    archived: bool | None = None


@router.get("/media")
async def media_list(
    admin: CurrentAdmin,
    db: CoreSession,
    kind: Literal["screenshot", "demo", "logo", "file"] | None = None,
    tag: Annotated[str | None, Query(max_length=40)] = None,
    archived: bool = False,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> dict[str, Any]:
    rows, total = await library.list_items(db, category=kind, tag=tag, include_archived=archived, limit=limit, offset=offset)
    return {"items": [library.item_out(r, internal=True) for r in rows], "total": total}


@router.post("/media")
async def media_upload(
    admin: CurrentAdmin,
    db: CoreSession,
    file: Annotated[UploadFile, File()],
    kind: Annotated[Literal["screenshot", "demo", "logo", "file"], Form()],
    alt: Annotated[str, Form(max_length=300)],
    description: Annotated[str, Form(max_length=library.DESCRIPTION_MAX)] = "",
    tags: Annotated[str, Form(max_length=600)] = "",
) -> dict[str, Any]:
    actor = _actor(admin)
    problems = library.problems_for_text(alt, description)
    limit = max(library.MAX_VIDEO_BYTES, library.MAX_IMAGE_BYTES, library.MAX_PDF_BYTES)
    data = await file.read(limit + 1)
    if len(data) > limit:
        problems.append(f"ไฟล์ใหญ่เกิน {limit // (1024 * 1024)} MB")
    detail = {"filename": (file.filename or "")[:200], "kind": kind, "bytes": len(data)}
    if not problems:
        try:
            processed = await library.process_async(data, kind)
        except library.LibraryRejected as exc:
            problems.append(str(exc))
    if problems:
        await service.audit(db, actor, "admin_media_upload", None, False, {**detail, "problems": problems})
        await db.commit()
        raise HTTPException(status_code=400, detail=" · ".join(problems))
    row = await library.save(
        db, processed, category=kind, alt=alt, description=description, tags=library.clean_tags(tags),
        filename=file.filename or "", actor=actor,
    )
    await service.audit(db, actor, "admin_media_upload", None, True, {**detail, "key": row.key, "stored_bytes": row.bytes})
    return library.item_out(row, internal=True)


@router.patch("/media/{item_id}")
async def media_update(item_id: int, body: MediaChanges, admin: CurrentAdmin, db: CoreSession) -> dict[str, Any]:
    if body.alt is not None or body.description is not None:
        problems = library.problems_for_text(body.alt if body.alt is not None else "ok-alt", body.description or "")
        if problems:
            raise HTTPException(status_code=400, detail=" · ".join(problems))
    row = await library.update(db, item_id, alt=body.alt, description=body.description, tags=body.tags, archived=body.archived)
    if row is None:
        raise HTTPException(status_code=404, detail="ไม่พบสื่อนี้")
    await service.audit(db, _actor(admin), "admin_media_update", None, True, {"id": item_id, **body.model_dump(exclude_none=True)})
    return library.item_out(row, internal=True)


# ── writing brief + content plan ─────────────────────────────────────────────


class BriefIn(BaseModel):
    tone: str = Field(default="", max_length=brief.BRIEF_FIELDS["tone"])
    focus_topics: str = Field(default="", max_length=brief.BRIEF_FIELDS["focus_topics"])
    avoid_topics: str = Field(default="", max_length=brief.BRIEF_FIELDS["avoid_topics"])
    length: str = Field(default="", max_length=brief.BRIEF_FIELDS["length"])
    media: str = Field(default="", max_length=brief.BRIEF_FIELDS["media"])
    monthly_note: str = Field(default="", max_length=brief.BRIEF_FIELDS["monthly_note"])


class TopicIn(BaseModel):
    topic: str = Field(min_length=3, max_length=brief.TOPIC_MAX)
    notes: str = Field(default="", max_length=brief.NOTES_MAX)


class TopicChanges(BaseModel):
    topic: str | None = Field(default=None, max_length=brief.TOPIC_MAX)
    notes: str | None = Field(default=None, max_length=brief.NOTES_MAX)
    status: Literal["planned", "writing", "done", "skipped"] | None = None
    post_slug: str | None = Field(default=None, max_length=80)
    clear_post: bool = False


class OrderIn(BaseModel):
    ids: list[int] = Field(max_length=brief.MAX_PLAN_ITEMS)


@router.get("/brief")
async def brief_get(admin: CurrentAdmin, db: CoreSession) -> dict[str, Any]:
    return await brief.get_brief(db)


@router.put("/brief")
async def brief_put(body: BriefIn, admin: CurrentAdmin, db: CoreSession) -> dict[str, Any]:
    try:
        return await brief.save_brief(db, body.model_dump(), admin.user_id)
    except service.BlogError as exc:
        raise _refusal(exc) from None


@router.get("/plan")
async def plan_get(admin: CurrentAdmin, db: CoreSession) -> list[dict[str, Any]]:
    return await brief.plan(db)


@router.post("/plan")
async def plan_add(body: TopicIn, admin: CurrentAdmin, db: CoreSession) -> dict[str, Any]:
    try:
        return await brief.add_item(db, body.topic, body.notes, admin.user_id)
    except service.BlogError as exc:
        raise _refusal(exc) from None


@router.put("/plan/order")
async def plan_order(body: OrderIn, admin: CurrentAdmin, db: CoreSession) -> list[dict[str, Any]]:
    try:
        return await brief.reorder(db, body.ids, admin.user_id)
    except service.BlogError as exc:
        raise _refusal(exc) from None


@router.patch("/plan/{item_id}")
async def plan_update(item_id: int, body: TopicChanges, admin: CurrentAdmin, db: CoreSession) -> dict[str, Any]:
    try:
        item = await brief.update_item(
            db, item_id, topic=body.topic, notes=body.notes, status=body.status, post_slug=body.post_slug,
            clear_post=body.clear_post, admin_user_id=admin.user_id,
        )
    except service.BlogError as exc:
        raise _refusal(exc) from None
    if item is None:
        raise HTTPException(status_code=404, detail="ไม่พบหัวข้อนี้")
    return item


@router.delete("/plan/{item_id}")
async def plan_delete(item_id: int, admin: CurrentAdmin, db: CoreSession) -> dict[str, Any]:
    if not await brief.delete_item(db, item_id, admin.user_id):
        raise HTTPException(status_code=404, detail="ไม่พบหัวข้อนี้")
    return {"deleted": item_id}
