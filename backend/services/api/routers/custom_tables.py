"""User-defined dynamic tables.

Each table the user creates becomes a real PostgreSQL table (``udt_<hex>``); each column
is a real column added via ``ALTER TABLE``. Only ``custom_table_meta`` is Alembic-managed
(holds display labels / ui types / options / formulas). The dynamic tables are created,
altered and dropped here at request time.

SQL-injection safety: table names (``udt_<hex>``) and column keys (``col_<n>``) are never
user-supplied — they are generated and regex-validated before being interpolated as quoted
identifiers. All *values* (cell data, select options) are passed as bound parameters.
"""

import json
import re
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any, cast

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import CursorResult, func as sqlfunc, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from packages.db.models.custom_table import CustomTableMeta
from packages.tables.formula import compile_formula
from services.api.deps import db_session
from services.api.schemas import (
    PAGE_SIZES,
    SORT_DIRS,
    SUMMARY_AGGS,
    UI_TYPES,
    ColumnMetaIn,
    ColumnMetaOut,
    ColumnPatch,
    CustomRowIn,
    CustomRowOut,
    CustomTableIn,
    CustomTablePatch,
    CustomTableOut,
    RowsPage,
    SummaryConfigIn,
    SummaryOut,
    SummaryRow,
    TableReorderIn,
)

router = APIRouter(prefix="/tables", tags=["tables"])

UI_TYPE_TO_PG = {
    "text": "TEXT",
    "number": "NUMERIC",
    "date": "DATE",
    "datetime": "TIMESTAMPTZ",
    "select": "TEXT",
    "multi_select": "TEXT[]",
    "boolean": "BOOLEAN",
}
_TBL_RE = re.compile(r"^udt_[0-9a-f]{8}$")
_KEY_RE = re.compile(r"^col_\d+$")


def _safe_table(name: str) -> str:
    if not _TBL_RE.match(name):
        raise HTTPException(500, f"unsafe table identifier: {name}")
    return name


def _safe_key(key: str) -> str:
    if not _KEY_RE.match(key):
        raise HTTPException(400, f"unsafe column key: {key}")
    return key


OPTION_COLORS = [
    "#f97316", "#eab308", "#22c55e", "#06b6d4",
    "#3b82f6", "#8b5cf6", "#ec4899", "#ef4444",
    "#14b8a6", "#64748b",
]


def _normalize_options(raw: list) -> list[dict]:
    """Coerce string[] or OptionDef[] to OptionDef dicts with stable ids."""
    import uuid as _uuid
    result = []
    for i, opt in enumerate(raw):
        if isinstance(opt, str):
            result.append({
                "uid": _uuid.uuid4().hex[:8],
                "label": opt,
                "color": OPTION_COLORS[i % len(OPTION_COLORS)],
                "order": i,
            })
        elif isinstance(opt, dict):
            result.append({
                "uid": opt.get("uid", _uuid.uuid4().hex[:8]),
                "label": opt.get("label", ""),
                "color": opt.get("color", "#6b7280"),
                "order": opt.get("order", i),
            })
        else:  # Pydantic model
            d = opt.model_dump() if hasattr(opt, "model_dump") else dict(opt)
            result.append({
                "uid": d.get("uid", _uuid.uuid4().hex[:8]),
                "label": d.get("label", ""),
                "color": d.get("color", "#6b7280"),
                "order": d.get("order", i),
            })
    return result


# ── meta helpers ──────────────────────────────────────────────────────────────


async def _get_meta(session: AsyncSession, table_uid: str) -> CustomTableMeta:
    """Look up table by external uid (UUID string)."""
    meta = (
        await session.execute(
            select(CustomTableMeta).where(CustomTableMeta.uid == table_uid)
        )
    ).scalar_one_or_none()
    if meta is None:
        raise HTTPException(404, "table not found")
    return meta


def _col(meta: CustomTableMeta, key: str) -> dict:
    for c in meta.columns:
        if c["key"] == key:
            return c
    raise HTTPException(404, f"column not found: {key}")


async def _row_count(session: AsyncSession, meta: CustomTableMeta) -> int:
    pg = _safe_table(meta.pg_table_name)
    return (await session.execute(text(f'SELECT count(*) FROM "{pg}"'))).scalar_one()


async def _to_out(session: AsyncSession, meta: CustomTableMeta) -> CustomTableOut:
    return CustomTableOut(
        uid=meta.uid,
        id=meta.id,
        display_name=meta.display_name,
        pg_table_name=meta.pg_table_name,
        columns=[ColumnMetaOut.model_validate(c) for c in meta.columns],
        row_count=await _row_count(session, meta),
        position=meta.position,
        summary_config=meta.summary_config or [],
        created_at=meta.created_at,
    )


# ── value coercion (frontend JSON → pg types) ─────────────────────────────────


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
    return str(value)  # text, select


# ── table CRUD ────────────────────────────────────────────────────────────────


@router.get("", response_model=list[CustomTableOut])
async def list_tables(
    q: str | None = Query(default=None),
    session: AsyncSession = Depends(db_session),
) -> list[CustomTableOut]:
    stmt = select(CustomTableMeta).order_by(CustomTableMeta.position, CustomTableMeta.created_at)
    if q:
        stmt = stmt.where(CustomTableMeta.display_name.ilike(f"%{q}%"))
    metas = (await session.execute(stmt)).scalars().all()
    return [await _to_out(session, m) for m in metas]


@router.post("", response_model=CustomTableOut, status_code=201)
async def create_table(
    body: CustomTableIn, session: AsyncSession = Depends(db_session)
) -> CustomTableOut:
    pg = "udt_" + uuid.uuid4().hex[:8]
    _safe_table(pg)
    await session.execute(
        text(
            f'CREATE TABLE "{pg}" ('
            f"  uid UUID PRIMARY KEY DEFAULT gen_random_uuid(),"
            f"  created_at TIMESTAMPTZ DEFAULT now(),"
            f"  updated_at TIMESTAMPTZ DEFAULT now(),"
            f"  seq BIGSERIAL"
            f")"
        )
    )
    max_pos = (
        await session.execute(select(sqlfunc.max(CustomTableMeta.position)))
    ).scalar_one_or_none() or 0
    meta = CustomTableMeta(
        display_name=body.display_name, pg_table_name=pg, columns=[], position=max_pos + 1
    )
    session.add(meta)
    await session.commit()
    await session.refresh(meta)
    return await _to_out(session, meta)


@router.get("/{table_uid}", response_model=CustomTableOut)
async def get_table(
    table_uid: str, session: AsyncSession = Depends(db_session)
) -> CustomTableOut:
    meta = await _get_meta(session, table_uid)
    return await _to_out(session, meta)


@router.patch("/{table_uid}", response_model=CustomTableOut)
async def rename_table(
    table_uid: str, body: CustomTablePatch, session: AsyncSession = Depends(db_session)
) -> CustomTableOut:
    meta = await _get_meta(session, table_uid)
    meta.display_name = body.display_name
    await session.commit()
    return await _to_out(session, meta)


@router.delete("/{table_uid}", status_code=204)
async def delete_table(
    table_uid: str, session: AsyncSession = Depends(db_session)
) -> None:
    meta = await _get_meta(session, table_uid)
    pg = _safe_table(meta.pg_table_name)
    await session.execute(text(f'DROP TABLE IF EXISTS "{pg}"'))
    await session.delete(meta)
    await session.commit()


@router.patch("", response_model=list[CustomTableOut])
async def reorder_tables(
    body: TableReorderIn, session: AsyncSession = Depends(db_session)
) -> list[CustomTableOut]:
    """Set display order of tables. Sends ordered list of UIDs; backend sets position=index."""
    for idx, tuid in enumerate(body.ids):
        await session.execute(
            text("UPDATE custom_table_meta SET position = :pos WHERE uid = :tuid"),
            {"pos": idx, "tuid": tuid},
        )
    await session.commit()
    metas = (
        await session.execute(
            select(CustomTableMeta).where(CustomTableMeta.uid.in_(body.ids))
            .order_by(CustomTableMeta.position)
        )
    ).scalars().all()
    return [await _to_out(session, m) for m in metas]


# ── column CRUD ───────────────────────────────────────────────────────────────


@router.post("/{table_uid}/columns", response_model=ColumnMetaOut, status_code=201)
async def add_column(
    table_uid: str, body: ColumnMetaIn, session: AsyncSession = Depends(db_session)
) -> ColumnMetaOut:
    meta = await _get_meta(session, table_uid)
    pg = _safe_table(meta.pg_table_name)

    if body.ui_type not in UI_TYPES:
        raise HTTPException(400, f"unknown column type: {body.ui_type}")

    seq = max((c["seq"] for c in meta.columns), default=0) + 1
    key = f"col_{seq}"

    if body.ui_type == "formula":
        if body.formula is None:
            raise HTTPException(400, "formula columns need a formula definition")
        try:
            expr, pg_type = compile_formula(body.formula.model_dump(), meta.columns)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        ddl = (
            f'ALTER TABLE "{pg}" ADD COLUMN "{key}" {pg_type} '
            f"GENERATED ALWAYS AS ({expr}) STORED"
        )
    else:
        pg_type = UI_TYPE_TO_PG[body.ui_type]
        ddl = f'ALTER TABLE "{pg}" ADD COLUMN "{key}" {pg_type}'

    await session.execute(text(ddl))

    col_meta = {
        "key": key,
        "label": body.label,
        "ui_type": body.ui_type,
        "pg_type": pg_type,
        "options": _normalize_options(body.options) if body.options else [],
        "formula": body.formula.model_dump() if body.formula else None,
        "width": body.width,
        "seq": seq,
    }
    meta.columns = [*meta.columns, col_meta]  # reassign so JSONB change is detected
    await session.commit()
    return ColumnMetaOut.model_validate(col_meta)


@router.patch("/{table_uid}/columns/{col_key}", response_model=ColumnMetaOut)
async def update_column(
    table_uid: str,
    col_key: str,
    body: ColumnPatch,
    session: AsyncSession = Depends(db_session),
) -> ColumnMetaOut:
    meta = await _get_meta(session, table_uid)
    _safe_key(col_key)
    updated: dict | None = None
    new_cols = []
    for c in meta.columns:
        if c["key"] == col_key:
            c = {**c}
            if body.label is not None:
                c["label"] = body.label
            if body.options is not None:
                c["options"] = _normalize_options(body.options)
            if body.width is not None:
                c["width"] = body.width
            updated = c
        new_cols.append(c)
    if updated is None:
        raise HTTPException(404, f"column not found: {col_key}")
    meta.columns = new_cols
    await session.commit()
    return ColumnMetaOut.model_validate(updated)


@router.delete("/{table_uid}/columns/{col_key}", status_code=204)
async def delete_column(
    table_uid: str, col_key: str, session: AsyncSession = Depends(db_session)
) -> None:
    meta = await _get_meta(session, table_uid)
    pg = _safe_table(meta.pg_table_name)
    _safe_key(col_key)
    _col(meta, col_key)  # 404 if missing

    # Block if a formula column depends on this one.
    for c in meta.columns:
        if c["ui_type"] == "formula" and c.get("formula"):
            f = c["formula"]
            if col_key in (f.get("col_a"), f.get("col_b")):
                raise HTTPException(
                    400,
                    f'ลบไม่ได้: คอลัมน์ "{c["label"]}" ใช้สูตรที่อ้างถึงคอลัมน์นี้ '
                    "กรุณาลบคอลัมน์สูตรก่อน",
                )

    await session.execute(text(f'ALTER TABLE "{pg}" DROP COLUMN "{col_key}"'))
    meta.columns = [c for c in meta.columns if c["key"] != col_key]
    await session.commit()


class ColumnReorderIn(BaseModel):
    keys: list[str]  # ordered col keys — backend reorders the columns JSONB to match


@router.post("/{table_uid}/columns/reorder", response_model=CustomTableOut)
async def reorder_columns(
    table_uid: str,
    body: ColumnReorderIn,
    session: AsyncSession = Depends(db_session),
) -> CustomTableOut:
    """Reorder columns by providing new key order. Columns not in list are appended last."""
    meta = await _get_meta(session, table_uid)
    col_map = {c["key"]: c for c in meta.columns}
    ordered = [col_map[k] for k in body.keys if k in col_map]
    remaining = [c for c in meta.columns if c["key"] not in set(body.keys)]
    meta.columns = ordered + remaining
    await session.commit()
    return await _to_out(session, meta)


# ── row CRUD ──────────────────────────────────────────────────────────────────


def _row_to_out(meta: CustomTableMeta, row: dict) -> CustomRowOut:
    data = {c["key"]: row.get(c["key"]) for c in meta.columns}
    return CustomRowOut(uid=str(row["uid"]), data=data, created_at=row.get("created_at"))


_FILTER_OPS = {"contains", "equals", "empty", "eq", "gt", "lt", "between", "range"}


def _build_filter_clause(
    filters_json: str | None,
    col_map: dict[str, dict],
    params: dict[str, Any],
) -> str:
    """Parse filters JSON → safe SQL WHERE conditions.

    filters = {"col_1": {"op": "contains", "val": "foo"},
               "col_3": {"op": "range", "from": "2026-01-01", "to": "2026-01-31"}}
    """
    if not filters_json:
        return ""
    try:
        filters = json.loads(filters_json)
    except json.JSONDecodeError:
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


@router.get("/{table_uid}/rows", response_model=RowsPage)
async def list_rows(
    table_uid: str,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20),
    sort_by: str | None = Query(default=None),
    sort_dir: str = Query(default="asc"),
    q: str | None = Query(default=None),
    filters: str | None = Query(default=None, description='JSON column filter spec'),
    session: AsyncSession = Depends(db_session),
) -> RowsPage:
    if page_size not in PAGE_SIZES:
        raise HTTPException(400, f"page_size must be one of {sorted(PAGE_SIZES)}")
    if sort_dir not in SORT_DIRS:
        raise HTTPException(400, "sort_dir must be 'asc' or 'desc'")

    meta = await _get_meta(session, table_uid)
    pg = _safe_table(meta.pg_table_name)
    col_map = {c["key"]: c for c in meta.columns}

    if sort_by is not None:
        _safe_key(sort_by)
        if sort_by not in col_map:
            raise HTTPException(400, f"unknown column: {sort_by}")
        order_clause = f'"{sort_by}" {sort_dir.upper()}'
    else:
        order_clause = "seq ASC"

    params: dict[str, Any] = {}
    conditions: list[str] = []

    # Global search (ILIKE on text/select columns)
    if q:
        text_cols = [c["key"] for c in meta.columns if c["ui_type"] in ("text", "select")]
        if text_cols:
            q_cond = " OR ".join(f'"{k}"::text ILIKE :q' for k in text_cols)
            conditions.append(f"({q_cond})")
            params["q"] = f"%{q}%"

    # Per-column filters
    filter_cond = _build_filter_clause(filters, col_map, params)
    if filter_cond:
        conditions.append(filter_cond)

    where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    offset = (page - 1) * page_size
    total = (
        await session.execute(text(f'SELECT count(*) FROM "{pg}" {where_clause}'), params)
    ).scalar_one()
    rows = (
        await session.execute(
            text(
                f'SELECT * FROM "{pg}" {where_clause} '
                f"ORDER BY {order_clause} "
                f"LIMIT {page_size} OFFSET {offset}"
            ),
            params,
        )
    ).mappings().all()
    return RowsPage(
        rows=[_row_to_out(meta, dict(r)) for r in rows],
        total=int(total),
        page=page,
        page_size=page_size,
    )


@router.post("/{table_uid}/rows", response_model=CustomRowOut, status_code=201)
async def add_row(
    table_uid: str, body: CustomRowIn, session: AsyncSession = Depends(db_session)
) -> CustomRowOut:
    meta = await _get_meta(session, table_uid)
    pg = _safe_table(meta.pg_table_name)

    cols = [
        c
        for c in meta.columns
        if c["ui_type"] != "formula" and c["key"] in body.data
    ]
    params = {c["key"]: _coerce(c["ui_type"], body.data[c["key"]]) for c in cols}

    if cols:
        collist = ", ".join(f'"{c["key"]}"' for c in cols)
        vallist = ", ".join(f":{c['key']}" for c in cols)
        sql = f'INSERT INTO "{pg}" ({collist}) VALUES ({vallist}) RETURNING uid'
    else:
        sql = f'INSERT INTO "{pg}" DEFAULT VALUES RETURNING uid'
    row_uid_val = (await session.execute(text(sql), params)).scalar_one()
    await session.commit()

    row = (
        await session.execute(text(f'SELECT * FROM "{pg}" WHERE uid = :rid'), {"rid": str(row_uid_val)})
    ).mappings().one()
    return _row_to_out(meta, dict(row))


@router.put("/{table_uid}/rows/{row_uid}", response_model=CustomRowOut)
async def update_row(
    table_uid: str,
    row_uid: str,
    body: CustomRowIn,
    session: AsyncSession = Depends(db_session),
) -> CustomRowOut:
    meta = await _get_meta(session, table_uid)
    pg = _safe_table(meta.pg_table_name)

    cols = [
        c
        for c in meta.columns
        if c["ui_type"] != "formula" and c["key"] in body.data
    ]
    if cols:
        params = {c["key"]: _coerce(c["ui_type"], body.data[c["key"]]) for c in cols}
        params["rid"] = row_uid
        assigns = ", ".join(f'"{c["key"]}" = :{c["key"]}' for c in cols)
        sql = f'UPDATE "{pg}" SET {assigns}, updated_at = now() WHERE uid = :rid'
        res = cast(CursorResult, await session.execute(text(sql), params))
        if res.rowcount == 0:
            raise HTTPException(404, "row not found")
        await session.commit()

    row = (
        await session.execute(
            text(f'SELECT * FROM "{pg}" WHERE uid = :rid'), {"rid": row_uid}
        )
    ).mappings().one_or_none()
    if row is None:
        raise HTTPException(404, "row not found")
    return _row_to_out(meta, dict(row))


@router.delete("/{table_uid}/rows/{row_uid}", status_code=204)
async def delete_row(
    table_uid: str, row_uid: str, session: AsyncSession = Depends(db_session)
) -> None:
    meta = await _get_meta(session, table_uid)
    pg = _safe_table(meta.pg_table_name)
    res = cast(
        CursorResult,
        await session.execute(text(f'DELETE FROM "{pg}" WHERE uid = :rid'), {"rid": row_uid}),
    )
    if res.rowcount == 0:
        raise HTTPException(404, "row not found")
    await session.commit()


class BulkDeleteIn(BaseModel):
    ids: list[str]  # list of row uids (UUID strings)


@router.post("/{table_uid}/rows/bulk-delete", status_code=204)
async def bulk_delete_rows(
    table_uid: str, body: BulkDeleteIn, session: AsyncSession = Depends(db_session)
) -> None:
    """Delete multiple rows in a single DELETE WHERE uid = ANY(:ids). No per-row loop."""
    if not body.ids:
        return
    meta = await _get_meta(session, table_uid)
    pg = _safe_table(meta.pg_table_name)
    await session.execute(
        text(f'DELETE FROM "{pg}" WHERE uid = ANY(:ids)'),
        {"ids": body.ids},
    )
    await session.commit()


# ── summary (group-by aggregation, like the Excel category sheet) ─────────────


@router.get("/{table_uid}/summary", response_model=SummaryOut)
async def summary(
    table_uid: str,
    group_by: str | None = Query(default=None),
    session: AsyncSession = Depends(db_session),
) -> SummaryOut:
    meta = await _get_meta(session, table_uid)
    pg = _safe_table(meta.pg_table_name)

    # group_by is optional — if absent, return a single "ทั้งหมด" aggregate row
    if group_by is not None:
        _safe_key(group_by)
        gcol = _col(meta, group_by)
        if gcol["ui_type"] != "select":
            raise HTTPException(400, "summary group_by must be a single-select column")
    else:
        gcol = None

    # Build config: use stored summary_config if set, else auto-derive from columns
    col_map = {c["key"]: c for c in meta.columns}
    cfg = meta.summary_config or []

    selects = ["count(*) AS cnt"]
    params: dict[str, Any] = {}

    # Build CASE expression for group-by label translation (option id → display label).
    # Uses bound params (:oid0/:olbl0 …) to safely embed option values.
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
            # pct = count(non-null) / total_count * 100
            selects.append(f'round(count("{key}")::numeric / NULLIF(count(*),0) * 100, 1) AS {alias}')
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
        # Auto-mode: avg all numeric, count+pct for boolean, option-counts for select
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
                # count per option (select options may be objects now)
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

    out_rows: list[SummaryRow] = []
    if group_by is None:
        r = dict(db_rows[0]) if db_rows else {}
        metrics: dict[str, Any] = {}
        for alias, label, kind in specs:
            v = r.get(alias)
            metrics[label] = (round(float(v), 2) if kind == "num" else int(v)) if v is not None else None
        out_rows.append(SummaryRow(group="ทั้งหมด", count=int(r.get("cnt", 0)), metrics=metrics))
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
                SummaryRow(
                    group=str(r["grp"]) if r["grp"] is not None else "(ว่าง)",
                    count=int(r["cnt"]),
                    metrics=metrics,
                )
            )

    return SummaryOut(
        group_by=group_by or "",
        group_by_label=gcol["label"] if gcol else "ทั้งหมด",
        rows=out_rows,
        metric_labels=metric_labels,
    )


@router.put("/{table_uid}/summary-config", response_model=CustomTableOut)
async def set_summary_config(
    table_uid: str,
    body: SummaryConfigIn,
    session: AsyncSession = Depends(db_session),
) -> CustomTableOut:
    """Save which columns + aggregates to show in the summary tab."""
    meta = await _get_meta(session, table_uid)
    col_keys = {c["key"] for c in meta.columns}
    for entry in body.config:
        _safe_key(entry.col_key)
        if entry.col_key not in col_keys:
            raise HTTPException(400, f"column not found: {entry.col_key}")
        invalid = set(entry.aggs) - SUMMARY_AGGS
        if invalid:
            raise HTTPException(400, f"invalid aggregates: {invalid}")
    meta.summary_config = [e.model_dump() for e in body.config]
    await session.commit()
    return await _to_out(session, meta)
