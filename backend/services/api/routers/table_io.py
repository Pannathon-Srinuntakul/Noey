"""Table import/export endpoints.

Export includes the row `id` as first column for upsert round-trips.
Import detects `id` column: existing id → UPDATE, missing/new id → INSERT.
CSV output uses UTF-8 with BOM so Excel/Thai Windows reads correctly.
"""

import csv
import io
import re
from datetime import date, datetime
from decimal import Decimal
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from packages.db.models.custom_table import CustomTableMeta
from services.api.deps import db_session


def _content_disposition(display_name: str, suffix: str = "") -> str:
    """RFC 5987 Content-Disposition with UTF-8 encoded filename."""
    base = f"{display_name}{suffix}.csv"
    # ASCII-safe fallback (used by old browsers)
    safe_ascii = re.sub(r'[^\x20-\x7E]', '', base).strip() or "export"
    if not safe_ascii.endswith('.csv'):
        safe_ascii = "export.csv"
    encoded = quote(base.encode('utf-8'))
    return f"attachment; filename=\"{safe_ascii}\"; filename*=UTF-8''{encoded}"


def _csv_bytes(headers: list[str], rows: list[list[str]]) -> bytes:
    """Return UTF-8 with BOM CSV bytes so Excel/Thai Windows opens correctly."""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(headers)
    for row in rows:
        writer.writerow(row)
    return '﻿'.encode('utf-8') + buf.getvalue().encode('utf-8')


async def _get_meta(session: AsyncSession, table_uid: str) -> CustomTableMeta:
    from sqlalchemy import select
    meta = (
        await session.execute(select(CustomTableMeta).where(CustomTableMeta.uid == table_uid))
    ).scalar_one_or_none()
    if meta is None:
        raise HTTPException(404, "table not found")
    return meta


def _option_label(value: Any, col: dict) -> str:
    if value is None:
        return ""
    if col.get("ui_type") in ("select", "multi_select"):
        options = col.get("options", [])
        if options and isinstance(options[0], dict):
            label_map = {o["uid"]: o["label"] for o in options}
            if isinstance(value, list):
                return ", ".join(label_map.get(v, v) for v in value)
            return label_map.get(str(value), str(value))
    if isinstance(value, list):
        return ", ".join(str(v) for v in value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    return str(value)


router = APIRouter(prefix="/tables", tags=["table-io"])


# ── Export ────────────────────────────────────────────────────────────────────

@router.get("/{table_uid}/export.csv")
async def export_csv(
    table_uid: str,
    ids: str | None = Query(default=None, description="Comma-separated row ids. Empty = all rows."),
    session: AsyncSession = Depends(db_session),
) -> StreamingResponse:
    """Export table as CSV with UTF-8 BOM. First column is row `id` for upsert on re-import."""
    meta = await _get_meta(session, table_uid)
    pg = meta.pg_table_name

    if ids:
        id_list = [i.strip() for i in ids.split(",") if i.strip()]
        if not id_list:
            raise HTTPException(400, "ids must be comma-separated row uids")
        rows = (
            await session.execute(
                text(f'SELECT * FROM "{pg}" WHERE uid = ANY(:ids) ORDER BY seq'),
                {"ids": id_list},
            )
        ).mappings().all()
    else:
        rows = (
            await session.execute(text(f'SELECT * FROM "{pg}" ORDER BY seq'))
        ).mappings().all()

    columns = meta.columns
    # id column first so users can import back for upsert
    headers = ["uid"] + [c["label"] for c in columns]
    data_rows = [
        [str(row.get("uid", ""))] + [_option_label(row.get(c["key"]), c) for c in columns]
        for row in rows
    ]

    content = _csv_bytes(headers, data_rows)
    return StreamingResponse(
        iter([content]),
        media_type="text/csv; charset=utf-8-sig",
        headers={"Content-Disposition": _content_disposition(meta.display_name)},
    )


# ── Sample CSV ────────────────────────────────────────────────────────────────

@router.get("/{table_uid}/sample.csv")
async def sample_csv(
    table_uid: str,
    session: AsyncSession = Depends(db_session),
) -> StreamingResponse:
    """Download a CSV template with 2 example rows. id column included for upsert."""
    meta = await _get_meta(session, table_uid)
    non_formula = [c for c in meta.columns if c.get("ui_type") != "formula"]

    headers = ["uid"] + [c["label"] for c in non_formula]
    data_rows = []
    for row_n in range(2):
        row: list[str] = [""]  # empty uid for new rows
        for c in non_formula:
            ui = c.get("ui_type", "text")
            if ui in ("select", "multi_select"):
                opts = c.get("options", [])
                val = ""
                if opts:
                    o = opts[row_n % len(opts)]
                    val = (o["label"] if isinstance(o, dict) else o)
                row.append(val)
            elif ui == "number":
                row.append(str(100 * (row_n + 1)))
            elif ui == "date":
                row.append(f"2026-0{row_n + 1}-15")
            elif ui == "boolean":
                row.append("true" if row_n == 0 else "false")
            else:
                row.append(f"ตัวอย่าง {row_n + 1}")
        data_rows.append(row)

    content = _csv_bytes(headers, data_rows)
    return StreamingResponse(
        iter([content]),
        media_type="text/csv; charset=utf-8-sig",
        headers={"Content-Disposition": _content_disposition(meta.display_name, "_sample")},
    )


# ── Import ────────────────────────────────────────────────────────────────────

class ImportResult(BaseModel):
    rows_inserted: int
    rows_updated: int
    rows_skipped: int
    errors: list[str]


@router.post("/{table_uid}/import", response_model=ImportResult)
async def import_csv(
    table_uid: str,
    file: UploadFile = File(...),
    session: AsyncSession = Depends(db_session),
) -> ImportResult:
    """Import CSV rows with upsert: existing `id` → UPDATE, no/new id → INSERT.
    First row must have column labels matching the table's column names.
    """
    meta = await _get_meta(session, table_uid)
    pg = meta.pg_table_name

    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(400, "ไฟล์ต้องเป็น .csv เท่านั้น")

    raw = await file.read()
    try:
        text_data = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text_data = raw.decode("latin-1")

    reader = csv.DictReader(io.StringIO(text_data))
    if reader.fieldnames is None:
        raise HTTPException(400, "CSV ไม่มีหัวคอลัมน์ (header row)")

    label_to_col = {
        c["label"]: c
        for c in meta.columns
        if c.get("ui_type") != "formula"
    }
    header_map: dict[str, dict] = {h: label_to_col[h] for h in reader.fieldnames if h in label_to_col}
    has_id_col = "uid" in reader.fieldnames

    if not header_map:
        raise HTTPException(
            400,
            f"ไม่พบคอลัมน์ที่ตรงกัน — หัวคอลัมน์ใน CSV: {', '.join(reader.fieldnames[:5])} "
            f"แต่ตารางมี: {', '.join(list(label_to_col.keys())[:5])}"
        )

    rows_inserted = 0
    rows_updated = 0
    rows_skipped = 0
    errors: list[str] = []

    UI_TYPE_COERCE: dict[str, Any] = {
        "number": lambda v: Decimal(v) if v else None,
        "date": lambda v: date.fromisoformat(v) if v else None,
        "datetime": lambda v: datetime.fromisoformat(v) if v else None,
        "boolean": lambda v: v.lower() in ("true", "1", "yes", "ใช่") if v else None,
        "multi_select": lambda v: [x.strip() for x in v.split(",")] if v else [],
    }

    for row_num, csv_row in enumerate(reader, start=2):
        try:
            params: dict[str, Any] = {}
            for header, col in header_map.items():
                raw_val = (csv_row.get(header) or "").strip()
                coerce = UI_TYPE_COERCE.get(col["ui_type"])
                params[col["key"]] = coerce(raw_val) if (coerce and raw_val) else (raw_val or None)

            cols_with_data = [c for c in header_map.values() if params.get(c["key"]) is not None]
            if not cols_with_data:
                rows_skipped += 1
                continue

            # Upsert by id
            row_id_str = (csv_row.get("uid") or "").strip() if has_id_col else ""
            if row_id_str and len(row_id_str) > 0:
                row_id = row_id_str  # UUID string
                exists = (
                    await session.execute(
                        text(f'SELECT 1 FROM "{pg}" WHERE uid = :rid'),
                        {"rid": row_id},
                    )
                ).scalar_one_or_none()
                if exists:
                    assigns = ", ".join(f'"{c["key"]}" = :{c["key"]}' for c in cols_with_data)
                    params["rid"] = row_id
                    await session.execute(
                        text(f'UPDATE "{pg}" SET {assigns}, updated_at = now() WHERE uid = :rid'),
                        params,
                    )
                    rows_updated += 1
                    continue

            # INSERT new row
            collist = ", ".join(f'"{c["key"]}"' for c in cols_with_data)
            vallist = ", ".join(f":{c['key']}" for c in cols_with_data)
            await session.execute(
                text(f'INSERT INTO "{pg}" ({collist}) VALUES ({vallist})'),
                params,
            )
            rows_inserted += 1
        except Exception as exc:
            errors.append(f"แถว {row_num}: {exc}")
            rows_skipped += 1
            await session.rollback()

    await session.commit()
    return ImportResult(
        rows_inserted=rows_inserted,
        rows_updated=rows_updated,
        rows_skipped=rows_skipped,
        errors=errors[:20],
    )
