"""Parameterized read queries shared by REST routers and the chatbot DB-tools.

All filters are bound parameters — never string-interpolated. The chatbot's tools call
these same functions, so the model can never run arbitrary SQL.
"""

import re
from datetime import date, datetime
from decimal import Decimal
from typing import Any, cast

from sqlalchemy import CursorResult, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from packages.db.models import Creator, MarketTrend, Product, SalesDaily
from packages.db.models.ai_prompt import AiPrompt
from packages.db.models.ai_run import AiRun
from packages.db.models.custom_table import CustomTableMeta
from packages.db.models.tiktok_csv import (
    FollowerGender,
    FollowerHistory,
    FollowerTerritory,
    OverviewDaily,
    VideoContent,
    ViewersDaily,
)
from services.api.schemas import SUMMARY_AGGS

_TBL_RE = re.compile(r"^udt_[0-9a-f]{8}$")
_KEY_RE = re.compile(r"^col_\d+$")
_FILTER_OPS = {"contains", "equals", "empty", "eq", "gt", "lt", "between", "range"}


def _date_filter(stmt, start: date | None, end: date | None):
    if start is not None:
        stmt = stmt.where(SalesDaily.snapshot_date >= start)
    if end is not None:
        stmt = stmt.where(SalesDaily.snapshot_date <= end)
    return stmt


async def overview(session: AsyncSession, start: date | None = None, end: date | None = None) -> dict:
    stmt = select(
        func.coalesce(func.sum(SalesDaily.gmv), 0),
        func.coalesce(func.sum(SalesDaily.commission), 0),
        func.coalesce(func.sum(SalesDaily.units), 0),
    )
    stmt = _date_filter(stmt, start, end)
    gmv, commission, units = (await session.execute(stmt)).one()
    return {"gmv": Decimal(gmv), "commission": Decimal(commission), "units": int(units)}


async def products(
    session: AsyncSession,
    start: date | None = None,
    end: date | None = None,
    limit: int = 100,
) -> list[dict]:
    stmt = (
        select(
            Product.id,
            Product.title,
            Product.commission_rate,
            func.coalesce(func.sum(SalesDaily.units), 0),
            func.coalesce(func.sum(SalesDaily.gmv), 0),
            func.coalesce(func.sum(SalesDaily.commission), 0),
        )
        .join(SalesDaily, SalesDaily.product_id == Product.id)
        .group_by(Product.id, Product.title, Product.commission_rate)
        .order_by(func.sum(SalesDaily.gmv).desc())
        .limit(limit)
    )
    stmt = _date_filter(stmt, start, end)
    rows = (await session.execute(stmt)).all()
    return [
        {
            "product_id": r[0],
            "title": r[1],
            "commission_rate": r[2],
            "units": int(r[3]),
            "gmv": Decimal(r[4]),
            "commission": Decimal(r[5]),
        }
        for r in rows
    ]


async def creators(
    session: AsyncSession,
    start: date | None = None,
    end: date | None = None,
    limit: int = 100,
) -> list[dict]:
    stmt = (
        select(
            Creator.id,
            Creator.handle,
            Creator.name,
            func.coalesce(func.sum(SalesDaily.units), 0),
            func.coalesce(func.sum(SalesDaily.gmv), 0),
            func.coalesce(func.sum(SalesDaily.commission), 0),
        )
        .join(SalesDaily, SalesDaily.creator_id == Creator.id)
        .group_by(Creator.id, Creator.handle, Creator.name)
        .order_by(func.sum(SalesDaily.gmv).desc())
        .limit(limit)
    )
    stmt = _date_filter(stmt, start, end)
    rows = (await session.execute(stmt)).all()
    return [
        {
            "creator_id": r[0],
            "handle": r[1],
            "name": r[2],
            "units": int(r[3]),
            "gmv": Decimal(r[4]),
            "commission": Decimal(r[5]),
        }
        for r in rows
    ]


async def market_trends(session: AsyncSession, limit: int = 100) -> list[dict]:
    stmt = select(MarketTrend).order_by(MarketTrend.captured_at.desc()).limit(limit)
    rows = (await session.execute(stmt)).scalars().all()
    return [
        {
            "id": m.id,
            "captured_at": m.captured_at,
            "entity_type": m.entity_type,
            "external_id": m.external_id,
            "title": m.title,
            "rank": m.rank,
            "metric": m.metric,
        }
        for m in rows
    ]


# ── TikTok analytics queries ─────────────────────────────────────────────────


def _overview_date_filter(stmt, start: date | None, end: date | None):
    if start is not None:
        stmt = stmt.where(OverviewDaily.date >= start)
    if end is not None:
        stmt = stmt.where(OverviewDaily.date <= end)
    return stmt


async def analytics_overview(
    session: AsyncSession,
    start: date | None = None,
    end: date | None = None,
) -> dict:
    stmt = select(
        func.coalesce(func.sum(OverviewDaily.video_views), 0),
        func.coalesce(func.sum(OverviewDaily.profile_views), 0),
        func.coalesce(func.sum(OverviewDaily.likes), 0),
        func.coalesce(func.sum(OverviewDaily.comments), 0),
        func.coalesce(func.sum(OverviewDaily.shares), 0),
    )
    stmt = _overview_date_filter(stmt, start, end)
    video_views, profile_views, likes, comments, shares = (await session.execute(stmt)).one()

    follower_stmt = (
        select(FollowerHistory.followers)
        .order_by(FollowerHistory.date.desc())
        .limit(1)
    )
    current_followers_row = (await session.execute(follower_stmt)).scalar_one_or_none()

    total_engagement = int(likes) + int(comments) + int(shares)
    avg_engagement_rate = total_engagement / int(video_views) if int(video_views) > 0 else 0.0

    return {
        "total_video_views": int(video_views),
        "total_profile_views": int(profile_views),
        "total_likes": int(likes),
        "total_comments": int(comments),
        "total_shares": int(shares),
        "current_followers": current_followers_row,
        "avg_engagement_rate": avg_engagement_rate,
    }


async def analytics_overview_timeseries(
    session: AsyncSession,
    start: date | None = None,
    end: date | None = None,
) -> list[dict]:
    stmt = select(OverviewDaily).order_by(OverviewDaily.date.asc())
    stmt = _overview_date_filter(stmt, start, end)
    rows = (await session.execute(stmt)).scalars().all()
    return [
        {
            "date": r.date,
            "video_views": r.video_views,
            "profile_views": r.profile_views,
            "likes": r.likes,
            "comments": r.comments,
            "shares": r.shares,
        }
        for r in rows
    ]


async def analytics_followers(
    session: AsyncSession,
    start: date | None = None,
    end: date | None = None,
) -> list[dict]:
    stmt = select(FollowerHistory).order_by(FollowerHistory.date.asc())
    if start is not None:
        stmt = stmt.where(FollowerHistory.date >= start)
    if end is not None:
        stmt = stmt.where(FollowerHistory.date <= end)
    rows = (await session.execute(stmt)).scalars().all()
    return [{"date": r.date, "followers": r.followers, "net_change": r.net_change} for r in rows]


async def analytics_viewers(
    session: AsyncSession,
    start: date | None = None,
    end: date | None = None,
) -> list[dict]:
    stmt = select(ViewersDaily).order_by(ViewersDaily.date.asc())
    if start is not None:
        stmt = stmt.where(ViewersDaily.date >= start)
    if end is not None:
        stmt = stmt.where(ViewersDaily.date <= end)
    rows = (await session.execute(stmt)).scalars().all()
    return [
        {
            "date": r.date,
            "total_viewers": r.total_viewers,
            "new_viewers": r.new_viewers,
            "returning_viewers": r.returning_viewers,
        }
        for r in rows
    ]


async def analytics_content(
    session: AsyncSession,
    start: date | None = None,
    end: date | None = None,
    limit: int = 100,
) -> list[dict]:
    stmt = select(VideoContent).order_by(VideoContent.views.desc()).limit(limit)
    if start is not None:
        stmt = stmt.where(VideoContent.post_date >= start)
    if end is not None:
        stmt = stmt.where(VideoContent.post_date <= end)
    rows = (await session.execute(stmt)).scalars().all()
    result = []
    for r in rows:
        engagement = r.likes + r.comments + r.shares
        rate = engagement / r.views if r.views > 0 else 0.0
        result.append(
            {
                "video_id": r.video_id,
                "video_url": r.video_url,
                "video_title": r.video_title,
                "post_date": r.post_date,
                "likes": r.likes,
                "comments": r.comments,
                "shares": r.shares,
                "views": r.views,
                "engagement_rate": rate,
            }
        )
    return result


async def analytics_demographics(session: AsyncSession) -> dict:
    latest_export = (
        await session.execute(
            select(FollowerGender.export_date).order_by(FollowerGender.export_date.desc()).limit(1)
        )
    ).scalar_one_or_none()

    gender_rows: list[dict] = []
    territory_rows: list[dict] = []

    if latest_export is not None:
        g_rows = (
            await session.execute(
                select(FollowerGender).where(FollowerGender.export_date == latest_export)
            )
        ).scalars().all()
        gender_rows = [{"gender": g.gender, "distribution": float(g.distribution)} for g in g_rows]

        t_rows = (
            await session.execute(
                select(FollowerTerritory).where(FollowerTerritory.export_date == latest_export)
            )
        ).scalars().all()
        territory_rows = [
            {"territory": t.territory, "distribution": float(t.distribution)} for t in t_rows
        ]

    return {
        "export_date": latest_export,
        "gender": gender_rows,
        "territory": territory_rows,
    }


# ── AI prompt-cron run history ────────────────────────────────────────────────


async def ai_runs(session: AsyncSession, limit: int = 50) -> list[dict]:
    stmt = (
        select(AiRun, AiPrompt.name)
        .outerjoin(AiPrompt, AiRun.prompt_id == AiPrompt.id)
        .order_by(AiRun.created_at.desc())
        .limit(limit)
    )
    rows = (await session.execute(stmt)).all()
    return [
        {
            "id": run.id,
            "prompt_id": run.prompt_id,
            "prompt_name": prompt_name,
            "status": run.status,
            "output": run.output,
            "error": run.error,
            "created_at": run.created_at,
        }
        for run, prompt_name in rows
    ]


# ── Custom tables (shared with chatbot write tools) ─────────────────────────────


def _safe_table(name: str) -> str:
    if not _TBL_RE.match(name):
        raise ValueError(f"unsafe table identifier: {name}")
    return name


def _safe_key(key: str) -> str:
    if not _KEY_RE.match(key):
        raise ValueError(f"unsafe column key: {key}")
    return key


def _coerce(ui_type: str, value: Any) -> Any:
    if value is None or value == "":
        return None
    if ui_type == "date":
        return date.fromisoformat(value) if isinstance(value, str) else value
    if ui_type == "datetime":
        return datetime.fromisoformat(value) if isinstance(value, str) else value
    if ui_type == "number":
        return Decimal(str(value))
    if ui_type == "boolean":
        return bool(value)
    if ui_type == "multi_select":
        return list(value) if value else []
    return str(value)


async def _resolve_custom_table(session: AsyncSession, table_name_or_uid: str) -> CustomTableMeta:
    meta = (
        await session.execute(
            select(CustomTableMeta).where(CustomTableMeta.uid == table_name_or_uid)
        )
    ).scalar_one_or_none()
    if meta is not None:
        return meta

    meta = (
        await session.execute(
            select(CustomTableMeta).where(
                CustomTableMeta.display_name.ilike(table_name_or_uid)
            )
        )
    ).scalar_one_or_none()
    if meta is not None:
        return meta

    metas = (
        await session.execute(
            select(CustomTableMeta)
            .where(CustomTableMeta.display_name.ilike(f"%{table_name_or_uid}%"))
            .order_by(CustomTableMeta.position, CustomTableMeta.created_at)
        )
    ).scalars().all()
    if len(metas) == 1:
        return metas[0]
    if len(metas) > 1:
        names = [m.display_name for m in metas]
        raise ValueError(
            f"multiple tables match '{table_name_or_uid}': {names}. "
            "Use table uid or exact display_name."
        )
    raise ValueError(f"table not found: {table_name_or_uid}")


def _row_for_chat(meta: CustomTableMeta, row: dict) -> dict:
    data = {c["label"]: row.get(c["key"]) for c in meta.columns}
    return {"uid": str(row["uid"]), "data": data}


def _build_filter_clause(
    filters: dict[str, dict] | None,
    col_map: dict[str, dict],
    params: dict[str, Any],
) -> str:
    if not filters:
        return ""

    conditions: list[str] = []
    i = 0
    for col_key, spec in filters.items():
        if not _KEY_RE.match(col_key) or col_key not in col_map:
            continue
        op = spec.get("op")
        if op not in _FILTER_OPS:
            continue
        p = f"fp{i}"
        ui_type = col_map[col_key]["ui_type"]

        if op == "empty":
            conditions.append(f'("{col_key}" IS NULL OR "{col_key}"::text = \'\')')
        elif op in ("contains",) and ui_type in ("text", "select"):
            params[p] = f"%{spec.get('val', '')}%"
            conditions.append(f'"{col_key}"::text ILIKE :{p}')
        elif op in ("equals", "eq"):
            params[p] = spec.get("val")
            conditions.append(f'"{col_key}"::text = :{p}')
        elif op == "gt" and ui_type == "number":
            params[p] = spec.get("val")
            conditions.append(f'"{col_key}" > :{p}')
        elif op == "lt" and ui_type == "number":
            params[p] = spec.get("val")
            conditions.append(f'"{col_key}" < :{p}')
        elif op == "between" and ui_type == "number":
            pa, pb = f"fp{i}a", f"fp{i}b"
            params[pa] = spec.get("from")
            params[pb] = spec.get("to")
            conditions.append(f'"{col_key}" BETWEEN :{pa} AND :{pb}')
        elif op == "range" and ui_type in ("date", "datetime"):
            pa, pb = f"fp{i}a", f"fp{i}b"
            params[pa] = spec.get("from")
            params[pb] = spec.get("to")
            conditions.append(f'"{col_key}" BETWEEN :{pa} AND :{pb}')
        i += 1

    return f"({' AND '.join(conditions)})" if conditions else ""


async def custom_tables_list(session: AsyncSession) -> list[dict]:
    metas = (
        await session.execute(
            select(CustomTableMeta).order_by(
                CustomTableMeta.position, CustomTableMeta.created_at
            )
        )
    ).scalars().all()
    out: list[dict] = []
    for meta in metas:
        pg = _safe_table(meta.pg_table_name)
        row_count = (await session.execute(text(f'SELECT count(*) FROM "{pg}"'))).scalar_one()
        out.append(
            {
                "uid": meta.uid,
                "display_name": meta.display_name,
                "row_count": int(row_count),
                "columns": [c["label"] for c in meta.columns],
            }
        )
    return out


async def custom_table_rows(
    session: AsyncSession,
    table_name_or_uid: str,
    limit: int = 20,
    q: str | None = None,
    filters: dict[str, dict] | None = None,
    sort_by: str | None = None,
    sort_dir: str = "asc",
) -> dict:
    meta = await _resolve_custom_table(session, table_name_or_uid)
    pg = _safe_table(meta.pg_table_name)
    col_map = {c["key"]: c for c in meta.columns}
    limit = max(1, min(int(limit), 100))

    if sort_by is not None:
        _safe_key(sort_by)
        if sort_by not in col_map:
            raise ValueError(f"unknown column: {sort_by}")
        order_clause = f'"{sort_by}" {sort_dir.upper()}'
    else:
        order_clause = "seq ASC"

    params: dict[str, Any] = {}
    conditions: list[str] = []

    if q:
        text_cols = [c["key"] for c in meta.columns if c["ui_type"] in ("text", "select")]
        if text_cols:
            q_cond = " OR ".join(f'"{k}"::text ILIKE :q' for k in text_cols)
            conditions.append(f"({q_cond})")
            params["q"] = f"%{q}%"

    filter_cond = _build_filter_clause(filters, col_map, params)
    if filter_cond:
        conditions.append(filter_cond)

    where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    total = (
        await session.execute(text(f'SELECT count(*) FROM "{pg}" {where_clause}'), params)
    ).scalar_one()
    rows = (
        await session.execute(
            text(
                f'SELECT * FROM "{pg}" {where_clause} '
                f"ORDER BY {order_clause} LIMIT {limit}"
            ),
            params,
        )
    ).mappings().all()

    return {
        "table_uid": meta.uid,
        "table_name": meta.display_name,
        "total": int(total),
        "rows": [_row_for_chat(meta, dict(r)) for r in rows],
    }


async def custom_table_summary(
    session: AsyncSession,
    table_name_or_uid: str,
    group_by: str | None = None,
) -> dict:
    meta = await _resolve_custom_table(session, table_name_or_uid)
    pg = _safe_table(meta.pg_table_name)
    col_map = {c["key"]: c for c in meta.columns}

    gcol: dict | None = None
    if group_by is not None:
        _safe_key(group_by)
        gcol = next((c for c in meta.columns if c["key"] == group_by), None)
        if gcol is None:
            raise ValueError(f"column not found: {group_by}")
        if gcol["ui_type"] != "select":
            raise ValueError("summary group_by must be a single-select column")

    cfg = meta.summary_config or []
    selects = ["count(*) AS cnt"]
    params: dict[str, Any] = {}

    grp_expr = f'"{group_by}"' if group_by else "'ทั้งหมด'"
    if gcol:
        opts = gcol.get("options", [])
        if opts and isinstance(opts[0], dict):
            for k, opt in enumerate(opts):
                params[f"oid{k}"] = opt["uid"]
                params[f"olbl{k}"] = opt["label"]
            cases = " ".join(f"WHEN :oid{k} THEN :olbl{k}" for k in range(len(opts)))
            grp_expr = f'CASE "{group_by}" {cases} ELSE "{group_by}" END'

    specs: list[tuple[str, str, str]] = []
    metric_labels: list[str] = []
    i = 0

    def _add_agg(key: str, agg: str, col: dict) -> None:
        nonlocal i
        alias = f"m{i}"
        label = f"{col['label']} ({agg.upper()})"
        if agg == "count":
            selects.append(f'count("{key}") AS {alias}')
            specs.append((alias, label, "int"))
        elif agg == "sum":
            selects.append(f'sum("{key}") AS {alias}')
            specs.append((alias, label, "num"))
        elif agg == "avg":
            selects.append(f'avg("{key}") AS {alias}')
            specs.append((alias, label, "num"))
        elif agg == "min":
            selects.append(f'min("{key}") AS {alias}')
            specs.append((alias, label, "num"))
        elif agg == "max":
            selects.append(f'max("{key}") AS {alias}')
            specs.append((alias, label, "num"))
        elif agg == "pct":
            selects.append(
                f'round(count("{key}")::numeric / NULLIF(count(*),0) * 100, 1) AS {alias}'
            )
            specs.append((alias, label, "num"))
        metric_labels.append(label)
        i += 1

    if cfg:
        for entry in cfg:
            key = entry.get("col_key")
            if not key or key not in col_map:
                continue
            _safe_key(key)
            col = col_map[key]
            for agg in entry.get("aggs", []):
                if agg in SUMMARY_AGGS:
                    _add_agg(key, agg, col)
    else:
        for c in meta.columns:
            if c["ui_type"] == "number":
                _add_agg(c["key"], "avg", c)
            elif c["ui_type"] == "boolean":
                alias = f"m{i}"
                selects.append(f'count(*) FILTER (WHERE "{c["key"]}" = true) AS {alias}')
                specs.append((alias, c["label"], "int"))
                metric_labels.append(c["label"])
                i += 1
            elif c["ui_type"] == "select" and c["key"] != group_by:
                for opt in c.get("options", []):
                    opt_val = opt["uid"] if isinstance(opt, dict) else opt
                    opt_label = opt["label"] if isinstance(opt, dict) else opt
                    alias = f"m{i}"
                    pname = f"p{i}"
                    selects.append(
                        f'count(*) FILTER (WHERE "{c["key"]}" = :{pname}) AS {alias}'
                    )
                    params[pname] = opt_val
                    specs.append((alias, opt_label, "int"))
                    metric_labels.append(opt_label)
                    i += 1

    if group_by is not None:
        sql = (
            f'SELECT {grp_expr} AS grp, {", ".join(selects)} '
            f'FROM "{pg}" GROUP BY "{group_by}" ORDER BY "{group_by}"'
        )
    else:
        sql = f'SELECT {", ".join(selects)} FROM "{pg}"'

    db_rows = (await session.execute(text(sql), params)).mappings().all()

    out_rows: list[dict] = []
    if group_by is None:
        r = dict(db_rows[0]) if db_rows else {}
        metrics: dict[str, Any] = {}
        for alias, label, kind in specs:
            v = r.get(alias)
            metrics[label] = (round(float(v), 2) if kind == "num" else int(v)) if v is not None else None
        out_rows.append({"group": "ทั้งหมด", "count": int(r.get("cnt", 0)), "metrics": metrics})
    else:
        for r in db_rows:
            metrics = {}
            for alias, label, kind in specs:
                v = r[alias]
                if v is None:
                    metrics[label] = None
                elif kind == "num":
                    metrics[label] = round(float(v), 2)
                else:
                    metrics[label] = int(v)
            out_rows.append(
                {
                    "group": str(r["grp"]) if r["grp"] is not None else "(ว่าง)",
                    "count": int(r["cnt"]),
                    "metrics": metrics,
                }
            )

    return {
        "table_uid": meta.uid,
        "table_name": meta.display_name,
        "group_by": group_by or "",
        "group_by_label": gcol["label"] if gcol else "ทั้งหมด",
        "rows": out_rows,
        "metric_labels": metric_labels,
    }


def _data_by_col_key(meta: CustomTableMeta, data: dict[str, Any]) -> dict[str, Any]:
    """Map user-facing column labels (or col keys) to col_* keys."""
    label_to_key = {c["label"]: c["key"] for c in meta.columns}
    key_to_key = {c["key"]: c["key"] for c in meta.columns}
    out: dict[str, Any] = {}
    for k, v in data.items():
        col_key = key_to_key.get(k) or label_to_key.get(k)
        if col_key is None:
            raise ValueError(f"unknown column: {k}")
        out[col_key] = v
    return out


async def custom_table_add_row(
    session: AsyncSession,
    table_name_or_uid: str,
    data: dict[str, Any],
) -> dict:
    meta = await _resolve_custom_table(session, table_name_or_uid)
    pg = _safe_table(meta.pg_table_name)
    keyed = _data_by_col_key(meta, data)

    cols = [
        c for c in meta.columns if c["ui_type"] != "formula" and c["key"] in keyed
    ]
    params = {c["key"]: _coerce(c["ui_type"], keyed[c["key"]]) for c in cols}

    if cols:
        collist = ", ".join(f'"{c["key"]}"' for c in cols)
        vallist = ", ".join(f":{c['key']}" for c in cols)
        sql = f'INSERT INTO "{pg}" ({collist}) VALUES ({vallist}) RETURNING uid'
    else:
        sql = f'INSERT INTO "{pg}" DEFAULT VALUES RETURNING uid'

    row_uid_val = (await session.execute(text(sql), params)).scalar_one()
    await session.commit()

    row = (
        await session.execute(
            text(f'SELECT * FROM "{pg}" WHERE uid = :rid'), {"rid": str(row_uid_val)}
        )
    ).mappings().one()
    return {
        "table_uid": meta.uid,
        "table_name": meta.display_name,
        "row": _row_for_chat(meta, dict(row)),
    }


async def custom_table_update_row(
    session: AsyncSession,
    table_name_or_uid: str,
    row_uid: str,
    data: dict[str, Any],
) -> dict:
    meta = await _resolve_custom_table(session, table_name_or_uid)
    pg = _safe_table(meta.pg_table_name)
    keyed = _data_by_col_key(meta, data)

    cols = [
        c for c in meta.columns if c["ui_type"] != "formula" and c["key"] in keyed
    ]
    if cols:
        params = {c["key"]: _coerce(c["ui_type"], keyed[c["key"]]) for c in cols}
        params["rid"] = row_uid
        assigns = ", ".join(f'"{c["key"]}" = :{c["key"]}' for c in cols)
        sql = f'UPDATE "{pg}" SET {assigns}, updated_at = now() WHERE uid = :rid'
        res = cast(CursorResult, await session.execute(text(sql), params))
        if res.rowcount == 0:
            raise ValueError("row not found")
        await session.commit()

    row = (
        await session.execute(
            text(f'SELECT * FROM "{pg}" WHERE uid = :rid'), {"rid": row_uid}
        )
    ).mappings().one_or_none()
    if row is None:
        raise ValueError("row not found")
    return {
        "table_uid": meta.uid,
        "table_name": meta.display_name,
        "row": _row_for_chat(meta, dict(row)),
    }


async def custom_table_delete_row(
    session: AsyncSession,
    table_name_or_uid: str,
    row_uid: str,
) -> dict:
    meta = await _resolve_custom_table(session, table_name_or_uid)
    pg = _safe_table(meta.pg_table_name)
    res = cast(
        CursorResult,
        await session.execute(text(f'DELETE FROM "{pg}" WHERE uid = :rid'), {"rid": row_uid}),
    )
    if res.rowcount == 0:
        raise ValueError("row not found")
    await session.commit()
    return {
        "table_uid": meta.uid,
        "table_name": meta.display_name,
        "deleted_row_uid": row_uid,
    }
