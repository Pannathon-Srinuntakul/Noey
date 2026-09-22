"""The usage facts the admin dashboard computes money from.

Only FACTS leave here — tokens per model and feature, speech-to-text seconds
per model, finished/failed projects, quality tiers chosen, subscription state.
Prices are the owner's editable assumptions (cost_config.py), and the dashboard
recomputes every baht from these facts while the owner edits a draft, so the
arithmetic lives in ONE place: the admin app's money module.

Days are Asia/Bangkok calendar days (the owner's clock). The daily quota is a
UTC day on purpose (packages/llm/usage.py:_period_start) and is reported as
the percentage the web app shows.

Project rows live in the shared tenant data schema (packages/db/tenancy.py) —
one table for every tenant — and are attributed by ``user_id``.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from packages.admin.cost_config import model_key
from packages.billing import catalog
from packages.core.settings import get_settings
from packages.db.models.billing import BillingAccount
from packages.db.models.core_auth import User
from packages.db.models.llm_usage import LlmUsageLog
from packages.db.models.stt_usage import SttUsageLog
from packages.db.tenancy import SHARED_DATA_SCHEMA
from packages.llm.usage import _period_start

TZ = ZoneInfo("Asia/Bangkok")
MAX_PERIOD_DAYS = 366
CHART_DAYS = 30
MONTHS = 4

#: A project counts as a finished clip once the cut exists; `error` is a failure.
DONE_STATUSES = ("done", "waiting_vo")
FAILED_STATUSES = ("error",)

_PROJECTS = f'"{SHARED_DATA_SCHEMA}".video_projects'


@dataclass(frozen=True)
class Period:
    start: date  # inclusive, Bangkok
    end: date  # inclusive, Bangkok

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1

    @property
    def start_utc(self) -> datetime:
        return _day_start_utc(self.start)

    @property
    def end_utc(self) -> datetime:
        """Exclusive."""
        return _day_start_utc(self.end + timedelta(days=1))


def _day_start_utc(day: date) -> datetime:
    return datetime.combine(day, time.min, tzinfo=TZ).astimezone(UTC)


def today_bangkok() -> date:
    return datetime.now(TZ).date()


def make_period(start: date, end: date) -> Period:
    if end < start:
        raise ValueError("the period ends before it starts")
    if (end - start).days + 1 > MAX_PERIOD_DAYS:
        raise ValueError(f"a period is at most {MAX_PERIOD_DAYS} days")
    return Period(start, end)


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


# ── per-user facts for a period ───────────────────────────────────────────────

async def _users(session: AsyncSession) -> list[dict[str, Any]]:
    rows = (
        await session.execute(
            select(User, BillingAccount.status, BillingAccount.current_period_end, BillingAccount.cancel_at_period_end)
            .outerjoin(BillingAccount, BillingAccount.user_id == User.id)
            .order_by(User.id)
        )
    ).all()
    settings = get_settings()
    out = []
    for user, status, period_end, cancelling in rows:
        plan = str(user.plan or catalog.FREE_TIER)
        out.append(
            {
                "id": int(user.id),
                "email": str(user.email),
                "display_name": user.display_name,
                "plan": plan,
                "internal": bool(user.is_admin),
                "active": bool(user.is_active),
                "email_verified": user.email_verified_at is not None,
                "created_at": _iso(user.created_at),
                "subscription": {
                    "status": status,
                    "live": catalog.is_live(status),
                    "current_period_end": _iso(period_end),
                    "cancel_at_period_end": bool(cancelling),
                },
                "quota_limit_tokens": settings.plan_token_limit(plan),
                "usage_reset_at": _iso(user.usage_reset_at),
            }
        )
    return out


async def _tokens_by_user(session: AsyncSession, period: Period) -> dict[int, list[dict[str, Any]]]:
    rows = (
        await session.execute(
            select(
                LlmUsageLog.user_id,
                LlmUsageLog.model,
                LlmUsageLog.feature,
                func.coalesce(func.sum(LlmUsageLog.input_tokens), 0),
                func.coalesce(func.sum(LlmUsageLog.output_tokens), 0),
                func.count(LlmUsageLog.id),
            )
            .where(LlmUsageLog.created_at >= period.start_utc, LlmUsageLog.created_at < period.end_utc)
            .group_by(LlmUsageLog.user_id, LlmUsageLog.model, LlmUsageLog.feature)
        )
    ).all()
    out: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for user_id, model, feature, inp, outp, calls in rows:
        out[int(user_id)].append(
            {"model": model_key(model), "feature": feature, "input": int(inp), "output": int(outp), "calls": int(calls)}
        )
    return out


async def _stt_by_user(session: AsyncSession, period: Period) -> dict[int, list[dict[str, Any]]]:
    rows = (
        await session.execute(
            select(SttUsageLog.user_id, SttUsageLog.model, func.coalesce(func.sum(SttUsageLog.audio_sec), 0.0))
            .where(SttUsageLog.created_at >= period.start_utc, SttUsageLog.created_at < period.end_utc)
            .group_by(SttUsageLog.user_id, SttUsageLog.model)
        )
    ).all()
    out: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for user_id, model, secs in rows:
        out[int(user_id)].append({"model": model or "", "seconds": round(float(secs), 2)})
    return out


async def _projects_by_user(session: AsyncSession, period: Period) -> dict[int, dict[str, Any]]:
    rows = (
        await session.execute(
            text(
                f"SELECT user_id, "
                f"count(*) FILTER (WHERE status = ANY(:done)) AS clips, "
                f"count(*) FILTER (WHERE status = ANY(:failed)) AS failed, "
                f"count(*) AS total, "
                f"count(engine) AS with_engine, "
                f"count(*) FILTER (WHERE engine = 'pro') AS engine_pro, "
                f"count(precision) AS with_precision, "
                f"count(*) FILTER (WHERE precision = 'high') AS precision_high "
                f"FROM {_PROJECTS} WHERE created_at >= :a AND created_at < :b GROUP BY user_id"
            ),
            {"done": list(DONE_STATUSES), "failed": list(FAILED_STATUSES), "a": period.start_utc, "b": period.end_utc},
        )
    ).all()
    out: dict[int, dict[str, Any]] = {}
    for r in rows:
        out[int(r.user_id)] = {
            "clips": int(r.clips),
            "failed": int(r.failed),
            "projects": int(r.total),
            "engine_pro_pct": round(r.engine_pro / r.with_engine * 100, 1) if r.with_engine else None,
            "precision_high_pct": round(r.precision_high / r.with_precision * 100, 1) if r.with_precision else None,
        }
    return out


async def _last_active(session: AsyncSession) -> dict[int, datetime]:
    rows = (
        await session.execute(
            text(
                "SELECT user_id, max(at) AS last FROM ("
                " SELECT user_id, max(created_at) AS at FROM core.llm_usage_logs GROUP BY user_id"
                " UNION ALL SELECT user_id, max(created_at) FROM core.stt_usage_logs GROUP BY user_id"
                f" UNION ALL SELECT user_id, max(updated_at) FROM {_PROJECTS} GROUP BY user_id"
                ") t GROUP BY user_id"
            )
        )
    ).all()
    return {int(r.user_id): r.last for r in rows if r.last is not None}


async def _quota_tokens(session: AsyncSession) -> dict[int, int]:
    """Tokens each user spent in their current quota window (see _period_start)."""
    day_start = _period_start(None)
    rows = (
        await session.execute(
            text(
                "SELECT l.user_id, coalesce(sum(l.input_tokens + l.output_tokens), 0) AS used "
                "FROM core.llm_usage_logs l JOIN core.users u ON u.id = l.user_id "
                "WHERE l.created_at >= :day AND l.created_at >= GREATEST(:day, coalesce(u.usage_reset_at, :day)) "
                "GROUP BY l.user_id"
            ),
            {"day": day_start},
        )
    ).all()
    return {int(r.user_id): int(r.used) for r in rows}


# ── series (whole product, split internal / customers) ───────────────────────

async def _series(session: AsyncSession, start_utc: datetime, end_utc: datetime, bucket: str) -> list[dict[str, Any]]:
    """Per bucket ("day" = Bangkok date, "month" = YYYY-MM) and internal flag."""
    fmt = "YYYY-MM-DD" if bucket == "day" else "YYYY-MM"
    key = lambda col: f"to_char(timezone('Asia/Bangkok', {col}), '{fmt}')"
    params = {"a": start_utc, "b": end_utc, "done": list(DONE_STATUSES)}
    tok = (
        await session.execute(
            text(
                f"SELECT {key('l.created_at')} AS k, u.is_admin AS internal, l.model, "
                "sum(l.input_tokens) AS inp, sum(l.output_tokens) AS outp "
                "FROM core.llm_usage_logs l JOIN core.users u ON u.id = l.user_id "
                "WHERE l.created_at >= :a AND l.created_at < :b GROUP BY 1, 2, 3"
            ),
            params,
        )
    ).all()
    stt = (
        await session.execute(
            text(
                f"SELECT {key('s.created_at')} AS k, u.is_admin AS internal, s.model, sum(s.audio_sec) AS secs "
                "FROM core.stt_usage_logs s JOIN core.users u ON u.id = s.user_id "
                "WHERE s.created_at >= :a AND s.created_at < :b GROUP BY 1, 2, 3"
            ),
            params,
        )
    ).all()
    clips = (
        await session.execute(
            text(
                f"SELECT {key('p.created_at')} AS k, u.is_admin AS internal, count(*) AS n "
                f"FROM {_PROJECTS} p JOIN core.users u ON u.id = p.user_id "
                "WHERE p.created_at >= :a AND p.created_at < :b AND p.status = ANY(:done) GROUP BY 1, 2"
            ),
            params,
        )
    ).all()
    buckets: dict[tuple[str, bool], dict[str, Any]] = {}

    def slot(k: str, internal: bool) -> dict[str, Any]:
        return buckets.setdefault((k, bool(internal)), {"key": k, "internal": bool(internal), "tokens": [], "stt": [], "clips": 0})

    for r in tok:
        slot(r.k, r.internal)["tokens"].append({"model": model_key(r.model), "input": int(r.inp), "output": int(r.outp)})
    for r in stt:
        slot(r.k, r.internal)["stt"].append({"model": r.model or "", "seconds": round(float(r.secs), 2)})
    for r in clips:
        slot(r.k, r.internal)["clips"] = int(r.n)
    return sorted(buckets.values(), key=lambda b: (b["key"], b["internal"]))


def _month_start(day: date) -> date:
    return day.replace(day=1)


def _months_back(day: date, n: int) -> date:
    y, m = day.year, day.month - n
    while m <= 0:
        m += 12
        y -= 1
    return date(y, m, 1)


# ── the dashboard payload ────────────────────────────────────────────────────

async def dashboard(session: AsyncSession, period: Period) -> dict[str, Any]:
    users = await _users(session)
    tokens = await _tokens_by_user(session, period)
    stt = await _stt_by_user(session, period)
    projects = await _projects_by_user(session, period)
    last = await _last_active(session)
    quota = await _quota_tokens(session)

    today = today_bangkok()
    empty_projects = {"clips": 0, "failed": 0, "projects": 0, "engine_pro_pct": None, "precision_high_pct": None}
    for u in users:
        uid = u["id"]
        u["tokens"] = tokens.get(uid, [])
        u["stt"] = stt.get(uid, [])
        u.update(projects.get(uid, empty_projects))
        seen = last.get(uid)
        u["last_active_at"] = _iso(seen)
        u["last_active_days"] = (today - seen.astimezone(TZ).date()).days if seen else None
        limit = int(u["quota_limit_tokens"] or 0)
        used = quota.get(uid, 0)
        u["quota_used_tokens"] = used
        u["quota_used_pct"] = round(min(used / limit * 100, 999.0), 1) if limit > 0 else None

    chart_end = period.end
    chart_start = chart_end - timedelta(days=CHART_DAYS - 1)
    daily = await _series(session, _day_start_utc(chart_start), _day_start_utc(chart_end + timedelta(days=1)), "day")

    first_month = _months_back(_month_start(today), MONTHS - 1)
    monthly = await _series(session, _day_start_utc(first_month), _day_start_utc(today + timedelta(days=1)), "month")

    models: dict[str, set[str]] = defaultdict(set)
    for rows in tokens.values():
        for row in rows:
            models[row["model"]].add(row["feature"])

    return {
        "period": {"from": period.start.isoformat(), "to": period.end.isoformat(), "days": period.days},
        "today": today.isoformat(),
        "chart": {"from": chart_start.isoformat(), "to": chart_end.isoformat(), "days": CHART_DAYS},
        "months": [_months_back(_month_start(today), i).strftime("%Y-%m") for i in range(MONTHS - 1, -1, -1)],
        "month_to_date_days": today.day,
        "users": users,
        "daily": daily,
        "monthly": monthly,
        "models_seen": [{"model": m, "features": sorted(f)} for m, f in sorted(models.items())],
    }


# ── one user's recent work ───────────────────────────────────────────────────

async def user_detail(session: AsyncSession, user_id: int, limit: int = 8) -> dict[str, Any]:
    projects = (
        await session.execute(
            text(
                "SELECT uid, mode, status, engine, precision, brief, local_meta, created_at "
                f"FROM {_PROJECTS} WHERE user_id = :u ORDER BY created_at DESC LIMIT :n"
            ),
            {"u": user_id, "n": limit},
        )
    ).all()
    uids = [p.uid for p in projects]
    tok: dict[str, list[dict[str, Any]]] = defaultdict(list)
    stt: dict[str, list[dict[str, Any]]] = defaultdict(list)
    if uids:
        for r in (
            await session.execute(
                select(
                    LlmUsageLog.reference_id,
                    LlmUsageLog.model,
                    LlmUsageLog.feature,
                    func.sum(LlmUsageLog.input_tokens),
                    func.sum(LlmUsageLog.output_tokens),
                    func.count(LlmUsageLog.id),
                )
                .where(LlmUsageLog.user_id == user_id, LlmUsageLog.reference_id.in_(uids))
                .group_by(LlmUsageLog.reference_id, LlmUsageLog.model, LlmUsageLog.feature)
            )
        ).all():
            tok[r[0]].append(
                {"model": model_key(r[1]), "feature": r[2], "input": int(r[3] or 0), "output": int(r[4] or 0), "calls": int(r[5])}
            )
        for s_row in (
            await session.execute(
                select(SttUsageLog.reference_id, SttUsageLog.model, func.sum(SttUsageLog.audio_sec))
                .where(SttUsageLog.user_id == user_id, SttUsageLog.reference_id.in_(uids))
                .group_by(SttUsageLog.reference_id, SttUsageLog.model)
            )
        ).all():
            stt[s_row[0]].append({"model": s_row[1] or "", "seconds": round(float(s_row[2] or 0), 2)})

    jobs = []
    for p in projects:
        clips = (p.local_meta or {}).get("clips") if isinstance(p.local_meta, dict) else None
        footage = None
        if isinstance(clips, list):
            footage = round(sum(float(c.get("durationSec") or 0) for c in clips if isinstance(c, dict)), 1)
        brief = (p.brief or "").strip().splitlines()[0][:60] if (p.brief or "").strip() else None
        jobs.append(
            {
                "uid": p.uid,
                "name": brief,
                "mode": p.mode,
                "status": p.status,
                "engine": p.engine,
                "precision": p.precision,
                "footage_sec": footage,
                "created_at": _iso(p.created_at),
                "tokens": tok.get(p.uid, []),
                "stt": stt.get(p.uid, []),
            }
        )
    return {"user_id": user_id, "jobs": jobs}
