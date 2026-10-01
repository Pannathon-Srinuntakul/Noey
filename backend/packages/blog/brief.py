"""The owner's writing brief and content plan (admin → บทความ), and what the
AI writer sees of them through `get_site_info` and `mark_topic_done`.

- Brief: one row of free-text guidance (tone, topics to push / avoid, length,
  how many visuals, a note for this month) plus when it last changed.
- Content plan: an ordered list of topics, each planned → writing → done (or
  skipped). The writer takes the first unwritten topic; `mark_topic_done`
  links it to the post it wrote.

Every change is a `blog_audit_log` row (services: packages/blog/service.audit).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.blog import service
from packages.blog import validation as v
from packages.db.models.blog import PLAN_STATUSES, BlogBrief, BlogPlanItem, BlogPost

BRIEF_FIELDS: dict[str, int] = {
    "tone": 1000,
    "focus_topics": 2000,
    "avoid_topics": 2000,
    "length": 500,
    "media": 500,
    "monthly_note": 2000,
}
TOPIC_MAX = 200
NOTES_MAX = 1000
MAX_PLAN_ITEMS = 200


async def get_brief(db: AsyncSession) -> dict[str, Any]:
    row = (await db.execute(select(BlogBrief).where(BlogBrief.id == 1))).scalar_one_or_none()
    out: dict[str, Any] = {k: (getattr(row, k) if row else "") for k in BRIEF_FIELDS}
    out["updated_at"] = service.iso(row.updated_at) if row else None
    return out


async def save_brief(db: AsyncSession, fields: dict[str, str], admin_user_id: int) -> dict[str, Any]:
    problems = [f"{k} ยาวเกิน {n} ตัวอักษร" for k, n in BRIEF_FIELDS.items() if len(fields.get(k, "") or "") > n]
    if v.banned_terms(fields.values()):
        problems.append("ห้ามเอ่ยชื่อผู้ให้บริการ AI ใน brief")
    if problems:
        raise service.BlogError("invalid_brief", problems)
    row = (await db.execute(select(BlogBrief).where(BlogBrief.id == 1).with_for_update())).scalar_one_or_none()
    if row is None:
        row = BlogBrief(id=1)
        db.add(row)
    for k in BRIEF_FIELDS:
        setattr(row, k, (fields.get(k) or "").strip())
    row.updated_at = datetime.now(UTC)
    row.updated_by = admin_user_id
    await db.flush()
    await service.audit(db, f"admin:{admin_user_id}", "admin_brief", None, True, {k: fields.get(k, "") for k in BRIEF_FIELDS})
    return await get_brief(db)


def item_out(row: BlogPlanItem) -> dict[str, Any]:
    return {
        "id": int(row.id),
        "position": row.position,
        "topic": row.topic,
        "notes": row.notes,
        "status": row.status,
        "post_slug": row.post_slug,
        "done_at": service.iso(row.done_at),
        "updated_at": service.iso(row.updated_at),
    }


async def plan(db: AsyncSession, *, unwritten_only: bool = False) -> list[dict[str, Any]]:
    q = select(BlogPlanItem)
    if unwritten_only:
        q = q.where(BlogPlanItem.status.in_(("planned", "writing")))
    rows = (await db.execute(q.order_by(BlogPlanItem.position, BlogPlanItem.id))).scalars()
    return [item_out(r) for r in rows]


def _topic_problems(topic: str | None, notes: str | None, status: str | None) -> list[str]:
    out = []
    if topic is not None and not 3 <= len(topic.strip()) <= TOPIC_MAX:
        out.append(f"หัวข้อต้องยาว 3–{TOPIC_MAX} ตัวอักษร")
    if notes is not None and len(notes) > NOTES_MAX:
        out.append(f"หมายเหตุยาวได้ไม่เกิน {NOTES_MAX} ตัวอักษร")
    if status is not None and status not in PLAN_STATUSES:
        out.append("สถานะไม่ถูกต้อง")
    if v.banned_terms([topic, notes]):
        out.append("ห้ามเอ่ยชื่อผู้ให้บริการ AI")
    return out


async def add_item(db: AsyncSession, topic: str, notes: str, admin_user_id: int) -> dict[str, Any]:
    if p := _topic_problems(topic, notes, None):
        raise service.BlogError("invalid_topic", p)
    count = int((await db.execute(select(func.count(BlogPlanItem.id)))).scalar() or 0)
    if count >= MAX_PLAN_ITEMS:
        raise service.BlogError("invalid_topic", f"แผนมีได้ไม่เกิน {MAX_PLAN_ITEMS} หัวข้อ")
    last = (await db.execute(select(func.max(BlogPlanItem.position)))).scalar()
    row = BlogPlanItem(topic=topic.strip(), notes=(notes or "").strip(), position=int(last or 0) + 1, status="planned")
    db.add(row)
    await db.flush()
    await db.refresh(row)
    await service.audit(db, f"admin:{admin_user_id}", "admin_plan", None, True, {"added": item_out(row)})
    return item_out(row)


async def update_item(
    db: AsyncSession, item_id: int, *, topic: str | None, notes: str | None, status: str | None,
    post_slug: str | None, clear_post: bool, admin_user_id: int,
) -> dict[str, Any] | None:
    row = (await db.execute(select(BlogPlanItem).where(BlogPlanItem.id == item_id).with_for_update())).scalar_one_or_none()
    if row is None:
        return None
    problems = _topic_problems(topic, notes, status)
    if post_slug and (
        v.slug_problem(post_slug) or (await db.execute(select(BlogPost.id).where(BlogPost.slug == post_slug))).scalar() is None
    ):
        problems.append(f"ไม่พบบทความ /blog/{post_slug}")
    if problems:
        raise service.BlogError("invalid_topic", problems)
    before = item_out(row)
    if topic is not None:
        row.topic = topic.strip()
    if notes is not None:
        row.notes = notes.strip()
    if status is not None:
        row.status = status
        row.done_at = datetime.now(UTC) if status == "done" else None
    if post_slug:
        row.post_slug = post_slug
    elif clear_post:
        row.post_slug = None
    row.updated_at = datetime.now(UTC)
    await db.flush()
    await service.audit(db, f"admin:{admin_user_id}", "admin_plan", post_slug, True, {"before": before, "after": item_out(row)})
    return item_out(row)


async def delete_item(db: AsyncSession, item_id: int, admin_user_id: int) -> bool:
    row = (await db.execute(select(BlogPlanItem).where(BlogPlanItem.id == item_id))).scalar_one_or_none()
    if row is None:
        return False
    before = item_out(row)
    await db.delete(row)
    await db.flush()
    await service.audit(db, f"admin:{admin_user_id}", "admin_plan", None, True, {"deleted": before})
    return True


async def reorder(db: AsyncSession, ids: list[int], admin_user_id: int) -> list[dict[str, Any]]:
    rows = {int(r.id): r for r in (await db.execute(select(BlogPlanItem).with_for_update())).scalars()}
    if sorted(ids) != sorted(rows):
        raise service.BlogError("invalid_order", "ส่งลำดับของทุกหัวข้อในแผน (ครบทุก id ไม่ซ้ำ)")
    for position, item_id in enumerate(ids, start=1):
        rows[item_id].position = position
    await db.flush()
    await service.audit(db, f"admin:{admin_user_id}", "admin_plan", None, True, {"order": ids})
    return await plan(db)


async def mark_done(db: AsyncSession, topic_id: int, slug: str, actor: str) -> dict[str, Any]:
    """MCP: the topic is covered by post `slug` (which must exist)."""
    detail = {"topic_id": topic_id, "slug": slug}
    row = (await db.execute(select(BlogPlanItem).where(BlogPlanItem.id == topic_id).with_for_update())).scalar_one_or_none()
    problems: list[str] = []
    if row is None:
        problems.append(f"No content-plan topic with id {topic_id}. get_site_info lists the open topics (content_plan[].id).")
    post = await service.get_post_row(db, slug)
    if post is None:
        problems.append(f"No post with slug `{slug}` — create the post first, then mark the topic done.")
    if row is not None and row.status == "skipped":
        problems.append("The owner skipped this topic; leave it.")
    if row is not None and row.status == "done" and row.post_slug not in (None, slug):
        problems.append(f"This topic is already done by /blog/{row.post_slug}.")
    if problems:
        await service.audit(db, actor, "mark_topic_done", slug, False, {**detail, "problems": problems})
        await db.commit()
        raise service.BlogError("invalid_topic", problems, status=404 if row is None or post is None else 409)
    assert row is not None
    row.status = "done"
    row.post_slug = slug
    row.done_at = row.done_at or datetime.now(UTC)
    row.updated_at = datetime.now(UTC)
    await db.flush()
    await service.audit(db, actor, "mark_topic_done", slug, True, detail)
    return item_out(row)
