"""Blog business rules — the ONE place posts are created, changed and published.

The MCP tools (services/mcp/server.py), the admin routes (routers/admin_blog.py)
and the public read API (routers/blog.py) are thin layers over this module.

Who may do what:

- MCP (`actor = "mcp:<client_id>"`): create (always a draft, `source = "ai"`),
  update only `source = "ai"` posts, publish within the daily cap and only
  when auto-publish is on, unpublish. Never delete — there is no delete at all.
- Admin (`actor = "admin:<user_id>"`): edit anything (the post becomes
  `source = "human"`, so MCP can no longer change it), publish/unpublish
  without the daily cap, change the auto-publish switch and the cap.

Every write — allowed or refused — appends a `blog_audit_log` row.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from packages.blog import media, revalidate
from packages.blog import validation as v
from packages.blog.schemas import FaqItem, NewPost, PostChanges, TagIn
from packages.core.settings import get_settings
from packages.db.models.admin import AdminSetting
from packages.db.models.blog import (
    DEFAULT_AUTHOR,
    BlogAuditLog,
    BlogCategory,
    BlogImage,
    BlogPost,
    BlogPostTag,
    BlogTag,
)

BANGKOK = ZoneInfo("Asia/Bangkok")
CONFIG_KEY = "blog_config"
#: pg_advisory_xact_lock key serialising the daily-cap check + publish.
_PUBLISH_LOCK_KEY = 8_713_204_119_470_017
RELATED_MAX = 3


class BlogError(Exception):
    """A refused request. `problems` are fix-it sentences for the writer."""

    def __init__(self, code: str, problems: list[str] | str, *, status: int = 400) -> None:
        self.code = code
        self.problems = [problems] if isinstance(problems, str) else list(problems)
        self.status = status
        super().__init__("; ".join(self.problems))


# ── config (env defaults, admin overrides in core.admin_settings) ───────────


@dataclass(frozen=True)
class BlogConfig:
    auto_publish: bool
    max_per_day: int
    #: Whether each value comes from the admin override ("admin") or the env ("env").
    auto_publish_source: str
    max_per_day_source: str


async def load_config(db: AsyncSession) -> BlogConfig:
    s = get_settings()
    raw = (await db.execute(select(AdminSetting.value).where(AdminSetting.key == CONFIG_KEY))).scalar_one_or_none() or {}
    auto = raw.get("auto_publish")
    cap = raw.get("max_per_day")
    return BlogConfig(
        auto_publish=bool(auto) if isinstance(auto, bool) else s.blog_auto_publish,
        max_per_day=int(cap) if isinstance(cap, int) and not isinstance(cap, bool) else s.blog_max_publish_per_day,
        auto_publish_source="admin" if isinstance(auto, bool) else "env",
        max_per_day_source="admin" if isinstance(cap, int) and not isinstance(cap, bool) else "env",
    )


async def save_config(
    db: AsyncSession, *, auto_publish: bool | None, max_per_day: int | None, admin_user_id: int
) -> tuple[BlogConfig, BlogConfig]:
    """Set (or with None, clear back to the env value) each override. Returns (before, after)."""
    before = await load_config(db)
    row = (
        await db.execute(select(AdminSetting).where(AdminSetting.key == CONFIG_KEY).with_for_update())
    ).scalar_one_or_none()
    value = {"auto_publish": auto_publish, "max_per_day": max_per_day}
    if row is None:
        db.add(AdminSetting(key=CONFIG_KEY, value=value, updated_by=admin_user_id))
    else:
        row.value = value
        row.updated_by = admin_user_id
    await db.flush()
    after = await load_config(db)
    await audit(
        db, f"admin:{admin_user_id}", "admin_settings", None, True,
        {"before": before.__dict__, "after": after.__dict__},
    )
    return before, after


# ── audit ────────────────────────────────────────────────────────────────────


def _trim(value: Any) -> Any:
    """Keep audit rows small: long strings are cut, Markdown bodies summarised."""
    if isinstance(value, str):
        return value if len(value) <= 300 else f"{value[:300]}… ({len(value)} chars)"
    if isinstance(value, dict):
        return {k: _trim(x) for k, x in value.items()}
    if isinstance(value, list):
        return [_trim(x) for x in value[:20]]
    return value


async def audit(
    db: AsyncSession,
    actor: str,
    action: str,
    slug: str | None,
    ok: bool,
    detail: dict[str, Any] | None = None,
    *,
    at: datetime | None = None,
) -> None:
    row = BlogAuditLog(actor=actor[:120], action=action[:40], slug=(slug or None) and slug[:80], ok=ok, detail=_trim(detail))
    if at is not None:
        # The publish clock: the daily cap counts these rows by Bangkok day.
        row.at = at
    db.add(row)
    await db.flush()


# ── lookups ──────────────────────────────────────────────────────────────────


async def categories(db: AsyncSession) -> list[BlogCategory]:
    return list((await db.execute(select(BlogCategory).order_by(BlogCategory.sort_order, BlogCategory.id))).scalars())


async def get_post_row(db: AsyncSession, slug: str, *, lock: bool = False) -> BlogPost | None:
    q = select(BlogPost).where(BlogPost.slug == slug)
    if lock:
        q = q.with_for_update()
    return (await db.execute(q)).scalar_one_or_none()


async def _category(db: AsyncSession, slug: str) -> BlogCategory:
    cat = (await db.execute(select(BlogCategory).where(BlogCategory.slug == slug))).scalar_one_or_none()
    if cat is None:
        known = ", ".join(c.slug for c in await categories(db))
        raise BlogError("unknown_category", f"category `{slug}` does not exist. Use one of: {known}. Categories cannot be created.")
    return cat


async def _resolve_tags(db: AsyncSession, tags: list[TagIn]) -> list[BlogTag]:
    out: list[BlogTag] = []
    seen: set[str] = set()
    problems: list[str] = []
    for t in tags:
        slug = v.slugify_tag(t.slug)
        if not slug:
            problems.append(f"tag slug `{t.slug}` has no a-z/0-9 characters — give an English slug (Thai goes in `name`).")
            continue
        if slug in seen:
            continue
        seen.add(slug)
        row = (await db.execute(select(BlogTag).where(BlogTag.slug == slug))).scalar_one_or_none()
        if row is None:
            name = (t.name or "").strip() or slug.replace("-", " ")
            if v.banned_terms([name]):
                problems.append(f"tag `{name}` names an AI vendor — not allowed.")
                continue
            row = BlogTag(slug=slug, name=name[: v.TAG_NAME_MAX])
            db.add(row)
            await db.flush()
        out.append(row)
    if problems:
        raise BlogError("invalid_tags", problems)
    return out


async def _post_tags(db: AsyncSession, post_ids: list[int]) -> dict[int, list[BlogTag]]:
    if not post_ids:
        return {}
    rows = await db.execute(
        select(BlogPostTag.post_id, BlogTag)
        .join(BlogTag, BlogTag.id == BlogPostTag.tag_id)
        .where(BlogPostTag.post_id.in_(post_ids))
        .order_by(BlogTag.slug)
    )
    out: dict[int, list[BlogTag]] = {pid: [] for pid in post_ids}
    for pid, tag in rows.all():
        out[int(pid)].append(tag)
    return out


async def _set_tags(db: AsyncSession, post: BlogPost, tags: list[BlogTag]) -> None:
    await db.execute(delete(BlogPostTag).where(BlogPostTag.post_id == post.id))
    for t in tags:
        db.add(BlogPostTag(post_id=post.id, tag_id=t.id))
    await db.flush()


async def _cover(db: AsyncSession, url: str | None) -> BlogImage | None:
    if not url:
        return None
    if not v.media_url_ok(url, media.media_base()):
        raise BlogError("invalid_cover", f"cover_image_url must be a url returned by `upload_image` (starting with {media.media_base()}/).")
    img = (await db.execute(select(BlogImage).where(BlogImage.url == url))).scalar_one_or_none()
    if img is None:
        raise BlogError("invalid_cover", "cover_image_url was not uploaded through `upload_image` — upload the image first.")
    return img


# ── validation of a whole post ───────────────────────────────────────────────


@dataclass
class _Draft:
    slug: str
    title: str = ""
    meta_title: str = ""
    meta_description: str = ""
    excerpt: str = ""
    content_md: str = ""
    cover_image_url: str | None = None
    cover_alt: str | None = None
    category: str = ""
    tags: list[TagIn] = field(default_factory=list)
    faq: list[FaqItem] = field(default_factory=list)


def _problems(d: _Draft, *, strict: bool) -> list[str]:
    """`strict` = the MCP rules (min words, FAQ count, internal links)."""
    s = get_settings()
    problems: list[str] = []
    if p := v.slug_problem(d.slug):
        problems.append(p)
    problems += v.field_problems(title=d.title, meta_title=d.meta_title, meta_description=d.meta_description, excerpt=d.excerpt)
    problems += v.content_problems(
        d.content_md,
        media_base=media.media_base(),
        min_words=s.blog_min_words if strict else 0,
        require_internal_links=strict,
    )
    problems += v.faq_problems([f.model_dump() for f in d.faq], required=strict)
    if not d.category:
        problems.append("category is required — pick a slug from `list_categories`.")
    if d.cover_image_url and not (d.cover_alt or "").strip():
        problems.append("cover_alt is required when there is a cover image.")
    banned = v.banned_terms(
        [d.title, d.meta_title, d.meta_description, d.excerpt, d.content_md, d.cover_alt]
        + [f"{f.question} {f.answer}" for f in d.faq]
        + [f"{t.slug} {t.name or ''}" for t in d.tags]
    )
    if banned:
        problems.append(
            "Do not name AI vendors or models anywhere in the post (found: "
            + ", ".join(banned)
            + "). Say what the product does instead (e.g. 'ระบบถอดเสียง')."
        )
    return problems


async def _draft_of(db: AsyncSession, post: BlogPost) -> _Draft:
    cat = (await db.execute(select(BlogCategory.slug).where(BlogCategory.id == post.category_id))).scalar_one()
    tags = (await _post_tags(db, [int(post.id)]))[int(post.id)]
    return _Draft(
        slug=post.slug,
        title=post.title,
        meta_title=post.meta_title,
        meta_description=post.meta_description,
        excerpt=post.excerpt,
        content_md=post.content_md,
        cover_image_url=post.cover_image_url,
        cover_alt=post.cover_alt,
        category=cat,
        tags=[TagIn(slug=t.slug, name=t.name) for t in tags],
        faq=[FaqItem.model_validate(f) for f in (post.faq or [])],
    )


def _apply(d: _Draft, fields: dict[str, Any]) -> _Draft:
    for key, value in fields.items():
        if key == "tags":
            d.tags = [x if isinstance(x, TagIn) else TagIn.model_validate(x) for x in (value or [])]
        elif key == "faq":
            d.faq = [x if isinstance(x, FaqItem) else FaqItem.model_validate(x) for x in (value or [])]
        elif key == "new_slug":
            continue
        else:
            setattr(d, key, value.strip() if isinstance(value, str) and key not in ("content_md",) else value)
    return d


async def _write(db: AsyncSession, post: BlogPost, d: _Draft) -> None:
    cat = await _category(db, d.category)
    cover = await _cover(db, d.cover_image_url)
    tags = await _resolve_tags(db, d.tags)
    post.slug = d.slug
    post.title = d.title
    post.meta_title = d.meta_title
    post.meta_description = d.meta_description
    post.excerpt = d.excerpt
    post.content_md = d.content_md
    post.cover_image_url = cover.url if cover else None
    post.cover_alt = (d.cover_alt or "").strip() or None if cover else None
    post.cover_width = cover.width if cover else None
    post.cover_height = cover.height if cover else None
    post.category_id = cat.id
    post.faq = [f.model_dump() for f in d.faq]
    post.updated_at = datetime.now(UTC)
    await db.flush()
    await _set_tags(db, post, tags)


# ── writes ───────────────────────────────────────────────────────────────────


async def create_post(db: AsyncSession, data: NewPost, actor: str) -> BlogPost:
    """MCP create: always a draft, always `source = "ai"`."""
    d = _apply(_Draft(slug=data.slug.strip()), data.model_dump(exclude={"slug"}, exclude_none=True))
    detail = {"input": data.model_dump(exclude_none=True)}
    problems = _problems(d, strict=True)
    if not problems and await get_post_row(db, d.slug) is not None:
        problems.append(f"slug `{d.slug}` is already used — pick another (see `list_posts`).")
    if problems:
        await _refuse(db, actor, "create_post", d.slug, "invalid_post", problems, detail)
    post = BlogPost(
        slug=d.slug, status="draft", source="ai", author=DEFAULT_AUTHOR, created_by=actor,
        title="", meta_title="", meta_description="", excerpt="", content_md="", category_id=0, faq=[],
    )
    try:
        await _write_new(db, post, d)
    except BlogError as exc:
        await _refuse(db, actor, "create_post", d.slug, exc.code, exc.problems, detail)
    await audit(db, actor, "create_post", post.slug, True, detail)
    return post


async def _write_new(db: AsyncSession, post: BlogPost, d: _Draft) -> None:
    cat = await _category(db, d.category)
    post.category_id = cat.id
    db.add(post)
    await db.flush()
    await _write(db, post, d)


async def _refuse(
    db: AsyncSession, actor: str, action: str, slug: str | None, code: str, problems: list[str], detail: dict[str, Any] | None
) -> None:
    """Undo whatever this request half-wrote, log the refusal, raise."""
    await db.rollback()
    await audit(db, actor, action, slug, False, {**(detail or {}), "refused": code, "problems": problems})
    await db.commit()
    raise BlogError(code, problems, status=404 if code == "not_found" else 409 if code in ("human_post", "slug_locked") else 400)


async def update_post(db: AsyncSession, slug: str, changes: PostChanges, actor: str, *, by_admin: bool) -> BlogPost:
    action = "admin_update" if by_admin else "update_post"
    fields = changes.model_dump(exclude_unset=True, exclude_none=False)
    # `None` means "not given" for every field but the cover (null removes it).
    fields = {k: val for k, val in fields.items() if val is not None or k in ("cover_image_url", "cover_alt")}
    detail = {"changes": fields}
    post = await get_post_row(db, slug, lock=True)
    if post is None:
        await _refuse(db, actor, action, slug, "not_found", [f"No post with slug `{slug}`."], detail)
        raise AssertionError  # unreachable
    if not by_admin and post.source != "ai":
        await _refuse(
            db, actor, action, slug, "human_post",
            ["This post was written or edited by the owner (source = human); it can no longer be changed through MCP."],
            detail,
        )
    d = _apply(await _draft_of(db, post), fields)
    new_slug = (changes.new_slug or "").strip()
    if new_slug and new_slug != post.slug:
        if post.published_at is not None:
            await _refuse(db, actor, action, slug, "slug_locked", ["The slug is locked: this post has been published before."], detail)
        if await get_post_row(db, new_slug) is not None:
            await _refuse(db, actor, action, slug, "invalid_post", [f"slug `{new_slug}` is already used."], detail)
        d.slug = new_slug
    problems = _problems(d, strict=not by_admin)
    if problems:
        await _refuse(db, actor, action, slug, "invalid_post", problems, detail)
    was_live = post.status == "published"
    try:
        await _write(db, post, d)
    except BlogError as exc:
        await _refuse(db, actor, action, slug, exc.code, exc.problems, detail)
    if by_admin:
        post.source = "human"
    await audit(db, actor, action, post.slug, True, {**detail, "renamed_from": slug if post.slug != slug else None})
    if was_live:
        _after_commit_revalidate(db, [post.slug])
    return post


@dataclass(frozen=True)
class PublishResult:
    outcome: str  # published | already_published | awaiting_owner
    post: BlogPost
    message: str


def bangkok_day_bounds(now: datetime | None = None) -> tuple[datetime, datetime]:
    """[start, end) of the current Asia/Bangkok calendar day, in UTC."""
    local = (now or datetime.now(UTC)).astimezone(BANGKOK)
    start_local = datetime.combine(local.date(), time.min, tzinfo=BANGKOK)
    return start_local.astimezone(UTC), (start_local + timedelta(days=1)).astimezone(UTC)


async def publishes_today(db: AsyncSession, now: datetime | None = None) -> int:
    start, end = bangkok_day_bounds(now)
    return int(
        (
            await db.execute(
                select(func.count(BlogAuditLog.id)).where(
                    BlogAuditLog.action == "publish_post",
                    BlogAuditLog.ok.is_(True),
                    BlogAuditLog.detail["outcome"].astext == "published",
                    BlogAuditLog.at >= start,
                    BlogAuditLog.at < end,
                )
            )
        ).scalar()
        or 0
    )


def _clock() -> datetime:
    """Now — a seam the daily-cap tests move across Bangkok midnight."""
    return datetime.now(UTC)


async def publish(db: AsyncSession, slug: str, actor: str, *, by_admin: bool) -> PublishResult:
    action = "admin_publish" if by_admin else "publish_post"
    # One publisher at a time: the cap check and the write must not interleave.
    await db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": _PUBLISH_LOCK_KEY})
    post = await get_post_row(db, slug, lock=True)
    if post is None:
        await _refuse(db, actor, action, slug, "not_found", [f"No post with slug `{slug}`."], None)
        raise AssertionError
    if post.status == "published":
        await audit(db, actor, action, slug, True, {"outcome": "already_published"})
        return PublishResult("already_published", post, "The post is already published.")
    now = _clock()
    if not by_admin:
        if post.source != "ai":
            await _refuse(db, actor, action, slug, "human_post", ["This post is owner-managed (source = human); the owner publishes it from the admin."], None)
        cfg = await load_config(db)
        if not cfg.auto_publish:
            await audit(db, actor, action, slug, True, {"outcome": "awaiting_owner"})
            return PublishResult(
                "awaiting_owner", post,
                "Auto-publish is off: the post stays a draft until the owner approves it in the admin dashboard. "
                "Nothing else to do.",
            )
        used = await publishes_today(db, now)
        if used >= cfg.max_per_day:
            _, end = bangkok_day_bounds(now)
            await _refuse(
                db, actor, action, slug, "daily_cap",
                [
                    (
                        f"The daily publish limit ({cfg.max_per_day} per day, Asia/Bangkok) is reached. "
                        f"The post stays a draft; publish it again after {end.astimezone(BANGKOK).isoformat()} "
                        f"({end.isoformat().replace('+00:00', 'Z')})."
                    )
                ],
                {"used_today": used, "cap": cfg.max_per_day},
            )
        # Re-validate with the strict rules: an old draft must still pass them.
        problems = _problems(await _draft_of(db, post), strict=True)
        if problems:
            await _refuse(db, actor, action, slug, "invalid_post", problems, None)
    post.status = "published"
    if post.published_at is None:
        post.published_at = now
    post.updated_at = now
    await db.flush()
    await audit(db, actor, action, slug, True, {"outcome": "published"}, at=now)
    _after_commit_revalidate(db, [post.slug])
    return PublishResult("published", post, "Published.")


async def unpublish(db: AsyncSession, slug: str, actor: str, *, by_admin: bool) -> BlogPost:
    action = "admin_unpublish" if by_admin else "unpublish_post"
    post = await get_post_row(db, slug, lock=True)
    if post is None:
        await _refuse(db, actor, action, slug, "not_found", [f"No post with slug `{slug}`."], None)
        raise AssertionError
    was_live = post.status == "published"
    post.status = "unpublished"
    post.updated_at = datetime.now(UTC)
    await db.flush()
    await audit(db, actor, action, slug, True, {"was_published": was_live})
    if was_live:
        _after_commit_revalidate(db, [post.slug])
    return post


def _after_commit_revalidate(db: AsyncSession, slugs: list[str]) -> None:
    """Revalidate once the transaction COMMITS — the site must read the new state."""
    from sqlalchemy import event

    sync = db.sync_session

    def fire(_session: Any) -> None:
        revalidate.schedule(slugs)

    event.listen(sync, "after_commit", fire, once=True)


async def record_image(db: AsyncSession, stored: media.StoredImage, alt: str, actor: str) -> BlogImage:
    row = (await db.execute(select(BlogImage).where(BlogImage.key == stored.key))).scalar_one_or_none()
    if row is None:
        row = BlogImage(
            url=stored.url, key=stored.key, mime=stored.mime, bytes=stored.bytes,
            width=stored.width, height=stored.height, alt=alt, uploaded_by=actor,
        )
        db.add(row)
        await db.flush()
    await audit(db, actor, "upload_image", None, True, {"key": stored.key, "bytes": stored.bytes, "w": stored.width, "h": stored.height})
    return row


# ── read models ──────────────────────────────────────────────────────────────


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


_minutes_cache: dict[tuple[int, str], int] = {}


def post_minutes(post: BlogPost) -> int:
    key = (int(post.id), iso(post.updated_at) or "")
    if key not in _minutes_cache:
        if len(_minutes_cache) > 2000:
            _minutes_cache.clear()
        _minutes_cache[key] = v.reading_minutes(post.content_md)
    return _minutes_cache[key]


def _cat_out(cat: BlogCategory) -> dict[str, str]:
    return {"slug": cat.slug, "name": cat.name}


async def _cats_by_id(db: AsyncSession) -> dict[int, BlogCategory]:
    return {int(c.id): c for c in await categories(db)}


def post_summary(post: BlogPost, cats: dict[int, BlogCategory], tags: list[BlogTag]) -> dict[str, Any]:
    """Post WITHOUT content_md / faq / related (listing shape, BLOG_CONTRACT.md)."""
    return {
        "slug": post.slug,
        "title": post.title,
        "meta_title": post.meta_title,
        "meta_description": post.meta_description,
        "excerpt": post.excerpt,
        "cover_image_url": post.cover_image_url,
        "cover_alt": post.cover_alt,
        "cover_width": post.cover_width,
        "cover_height": post.cover_height,
        "category": _cat_out(cats[int(post.category_id)]),
        "tags": [{"slug": t.slug, "name": t.name} for t in tags],
        "author": post.author,
        "source": post.source,
        "reading_minutes": post_minutes(post),
        "published_at": iso(post.published_at),
        "updated_at": iso(post.updated_at),
    }


async def post_full(db: AsyncSession, post: BlogPost, *, internal: bool = False) -> dict[str, Any]:
    # A write in this transaction may have expired server-side columns
    # (updated_at's onupdate): load them now, not lazily in sync code below.
    await db.refresh(post)
    cats = await _cats_by_id(db)
    tags = (await _post_tags(db, [int(post.id)]))[int(post.id)]
    out = post_summary(post, cats, tags)
    out["content_md"] = post.content_md
    out["faq"] = list(post.faq or [])
    out["related"] = await related(db, post, cats, tags) if post.status == "published" else []
    if internal:
        out["status"] = post.status
        out["created_at"] = iso(post.created_at)
        out["created_by"] = post.created_by
        out["slug_locked"] = post.published_at is not None
    return out


async def related(db: AsyncSession, post: BlogPost, cats: dict[int, BlogCategory], tags: list[BlogTag]) -> list[dict[str, Any]]:
    """<= 3 published posts sharing tags (weighted) or the category, newest first on ties."""
    tag_ids = [int(t.id) for t in tags]
    shared = (
        select(BlogPostTag.post_id, func.count().label("n"))
        .where(BlogPostTag.tag_id.in_(tag_ids or [-1]))
        .group_by(BlogPostTag.post_id)
        .subquery()
    )
    rows = await db.execute(
        select(BlogPost, func.coalesce(shared.c.n, 0))
        .outerjoin(shared, shared.c.post_id == BlogPost.id)
        .where(
            BlogPost.status == "published",
            BlogPost.id != post.id,
            (shared.c.n > 0) | (BlogPost.category_id == post.category_id),
        )
        .order_by(BlogPost.published_at.desc())
        .limit(50)
    )
    scored = [
        (int(n) * 2 + (1 if p.category_id == post.category_id else 0), p.published_at or datetime.min.replace(tzinfo=UTC), p)
        for p, n in rows.all()
    ]
    scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
    return [
        {
            "slug": p.slug,
            "title": p.title,
            "excerpt": p.excerpt,
            "cover_image_url": p.cover_image_url,
            "cover_alt": p.cover_alt,
            "category": _cat_out(cats[int(p.category_id)]),
            "published_at": iso(p.published_at),
        }
        for _, _, p in scored[:RELATED_MAX]
    ]


async def list_published(
    db: AsyncSession, *, page: int, per_page: int, category: str | None, tag: str | None
) -> dict[str, Any]:
    q = select(BlogPost).where(BlogPost.status == "published")
    if category:
        q = q.join(BlogCategory, BlogCategory.id == BlogPost.category_id).where(BlogCategory.slug == category)
    if tag:
        q = q.where(
            BlogPost.id.in_(
                select(BlogPostTag.post_id).join(BlogTag, BlogTag.id == BlogPostTag.tag_id).where(BlogTag.slug == tag)
            )
        )
    total = int((await db.execute(select(func.count()).select_from(q.subquery()))).scalar() or 0)
    posts = list(
        (
            await db.execute(
                q.order_by(BlogPost.published_at.desc(), BlogPost.id.desc()).offset((page - 1) * per_page).limit(per_page)
            )
        ).scalars()
    )
    cats = await _cats_by_id(db)
    tags = await _post_tags(db, [int(p.id) for p in posts])
    return {
        "items": [post_summary(p, cats, tags[int(p.id)]) for p in posts],
        "page": page,
        "per_page": per_page,
        "total": total,
    }


async def published_slugs(db: AsyncSession) -> list[dict[str, Any]]:
    rows = await db.execute(
        select(BlogPost.slug, BlogPost.updated_at).where(BlogPost.status == "published").order_by(BlogPost.published_at.desc())
    )
    return [{"slug": s, "updated_at": iso(u)} for s, u in rows.all()]


async def categories_with_counts(db: AsyncSession) -> list[dict[str, Any]]:
    rows = await db.execute(
        select(BlogPost.category_id, func.count()).where(BlogPost.status == "published").group_by(BlogPost.category_id)
    )
    counts: dict[int, int] = {int(cid): int(n) for cid, n in rows.all()}
    return [
        {"slug": c.slug, "name": c.name, "description": c.description, "post_count": int(counts.get(c.id, 0))}
        for c in await categories(db)
    ]


async def tags_with_counts(db: AsyncSession, *, published_only: bool = True) -> list[dict[str, Any]]:
    q = (
        select(BlogTag.slug, BlogTag.name, func.count(BlogPost.id))
        .join(BlogPostTag, BlogPostTag.tag_id == BlogTag.id)
        .join(BlogPost, BlogPost.id == BlogPostTag.post_id)
    )
    if published_only:
        q = q.where(BlogPost.status == "published")
    rows = await db.execute(q.group_by(BlogTag.slug, BlogTag.name).order_by(func.count(BlogPost.id).desc(), BlogTag.slug))
    out = [{"slug": s, "name": n, "post_count": int(c)} for s, n, c in rows.all()]
    if not published_only:
        used = {r["slug"] for r in out}
        for t in (await db.execute(select(BlogTag).order_by(BlogTag.slug))).scalars():
            if t.slug not in used:
                out.append({"slug": t.slug, "name": t.name, "post_count": 0})
    return out


async def list_all(
    db: AsyncSession, *, status: str | None = None, source: str | None = None, limit: int = 50, offset: int = 0
) -> tuple[list[dict[str, Any]], int]:
    """Every status (MCP de-duplication and the admin table)."""
    q = select(BlogPost)
    if status:
        q = q.where(BlogPost.status == status)
    if source:
        q = q.where(BlogPost.source == source)
    total = int((await db.execute(select(func.count()).select_from(q.subquery()))).scalar() or 0)
    posts = list((await db.execute(q.order_by(BlogPost.created_at.desc(), BlogPost.id.desc()).offset(offset).limit(limit))).scalars())
    cats = await _cats_by_id(db)
    tags = await _post_tags(db, [int(p.id) for p in posts])
    return [
        {
            "slug": p.slug,
            "title": p.title,
            "status": p.status,
            "source": p.source,
            "category": _cat_out(cats[int(p.category_id)]),
            "tags": [{"slug": t.slug, "name": t.name} for t in tags[int(p.id)]],
            "published_at": iso(p.published_at),
            "created_at": iso(p.created_at),
            "updated_at": iso(p.updated_at),
            "created_by": p.created_by,
        }
        for p in posts
    ], total


def next_bangkok_midnight(now: datetime | None = None) -> datetime:
    return bangkok_day_bounds(now)[1]


def today_bangkok(now: datetime | None = None) -> date:
    return (now or datetime.now(UTC)).astimezone(BANGKOK).date()


def ceil_div(a: int, b: int) -> int:
    return math.ceil(a / b)
