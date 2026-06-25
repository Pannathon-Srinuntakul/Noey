"""CSV import pipeline: parse TikTok Studio exports and upsert into analytics tables."""

import csv
import io
import logging
import re
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path

import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from packages.db.models.tiktok_csv import CsvImportRun
from packages.db.upserts import (
    upsert_follower_activity,
    upsert_follower_gender,
    upsert_follower_history,
    upsert_follower_territory,
    upsert_overview_daily,
    upsert_video_content,
    upsert_viewers_daily,
)

log = structlog.get_logger(__name__)

# ── Thai month map ────────────────────────────────────────────────────────────

THAI_MONTHS: dict[str, int] = {
    "มกราคม": 1,
    "กุมภาพันธ์": 2,
    "มีนาคม": 3,
    "เมษายน": 4,
    "พฤษภาคม": 5,
    "มิถุนายน": 6,
    "กรกฎาคม": 7,
    "สิงหาคม": 8,
    "กันยายน": 9,
    "ตุลาคม": 10,
    "พฤศจิกายน": 11,
    "ธันวาคม": 12,
}

# ── CSV type detection ────────────────────────────────────────────────────────

CSV_TYPE_MAP: dict[str, str] = {
    "overview": "overview",
    "content": "content",
    "followeractivity": "follower_activity",
    "followergender": "follower_gender",
    "followerhistory": "follower_history",
    "followertopterritories": "follower_territory",
    "viewers": "viewers",
}


def detect_csv_type(filename: str) -> str | None:
    stem = Path(filename).stem.lower().replace(" ", "").replace("_", "")
    return CSV_TYPE_MAP.get(stem)


# ── Date helpers ──────────────────────────────────────────────────────────────


def parse_thai_date(raw: str, export_date: date) -> date | None:
    """Parse "DD MonthName" Thai date string into a date object.

    Year is inferred from export_date: the date is within the 12-month
    rolling window ending at export_date, so if month/day > export_date
    it must belong to the previous calendar year.
    """
    parts = raw.strip().split()
    if len(parts) < 2:
        return None
    try:
        day = int(parts[0])
        month = THAI_MONTHS.get(parts[1])
        if month is None:
            return None
        year = export_date.year
        try:
            candidate = date(year, month, day)
        except ValueError:
            return None
        if candidate > export_date:
            try:
                candidate = date(year - 1, month, day)
            except ValueError:
                return None
        return candidate
    except (ValueError, IndexError):
        return None


def _safe_int(val: str, default: int = 0) -> int:
    try:
        return int(val.strip().replace(",", ""))
    except (ValueError, AttributeError):
        return default


def _safe_float(val: str, default: float = 0.0) -> float:
    try:
        return float(val.strip())
    except (ValueError, AttributeError):
        return default


def _extract_video_id(url: str) -> str | None:
    m = re.search(r"/video/(\d+)", url)
    return m.group(1) if m else None


# ── Per-type parsers ──────────────────────────────────────────────────────────


def parse_overview(text: str, export_date: date) -> list[dict]:
    rows = []
    for row in csv.DictReader(io.StringIO(text)):
        raw_date = row.get("Date", "").strip()
        if not raw_date:
            continue
        d = parse_thai_date(raw_date, export_date)
        if d is None:
            log.warning("overview: skip unparseable date", raw=raw_date)
            continue
        rows.append(
            {
                "row_date": d,
                "video_views": _safe_int(row.get("Video Views", "0")),
                "profile_views": _safe_int(row.get("Profile Views", "0")),
                "likes": _safe_int(row.get("Likes", "0")),
                "comments": _safe_int(row.get("Comments", "0")),
                "shares": _safe_int(row.get("Shares", "0")),
            }
        )
    return rows


def parse_content(text: str, export_date: date) -> list[dict]:
    rows = []
    for row in csv.DictReader(io.StringIO(text)):
        url = row.get("Video link", "").strip()
        video_id = _extract_video_id(url)
        if not video_id:
            log.warning("content: skip row with no video id", url=url)
            continue
        raw_post = row.get("Post time", "").strip()
        post_date = parse_thai_date(raw_post, export_date) if raw_post else None
        rows.append(
            {
                "video_id": video_id,
                "video_url": url,
                "video_title": row.get("Video title", "").strip(),
                "post_date": post_date,
                "likes": _safe_int(row.get("Total likes", "0")),
                "comments": _safe_int(row.get("Total comments", "0")),
                "shares": _safe_int(row.get("Total shares", "0")),
                "views": _safe_int(row.get("Total views", "0")),
            }
        )
    return rows


def parse_follower_history(text: str, export_date: date) -> list[dict]:
    rows = []
    for row in csv.DictReader(io.StringIO(text)):
        raw_date = row.get("Date", "").strip()
        if not raw_date:
            continue
        d = parse_thai_date(raw_date, export_date)
        if d is None:
            log.warning("follower_history: skip unparseable date", raw=raw_date)
            continue
        rows.append(
            {
                "row_date": d,
                "followers": _safe_int(row.get("Followers", "0")),
                "net_change": _safe_int(
                    row.get("Difference in followers from previous day", "0")
                ),
            }
        )
    return rows


def parse_follower_activity(text: str, export_date: date) -> list[dict]:
    rows = []
    for row in csv.DictReader(io.StringIO(text)):
        raw_date = row.get("Date", "").strip()
        if not raw_date:
            continue
        d = parse_thai_date(raw_date, export_date)
        if d is None:
            log.warning("follower_activity: skip unparseable date", raw=raw_date)
            continue
        rows.append(
            {
                "row_date": d,
                "hour": _safe_int(row.get("Hour", "0")),
                "active_followers": _safe_int(row.get("Active followers", "0")),
            }
        )
    return rows


def parse_follower_gender(text: str, export_date: date) -> list[dict]:  # noqa: ARG001
    rows = []
    for row in csv.DictReader(io.StringIO(text)):
        gender = row.get("Gender", "").strip()
        if not gender:
            continue
        rows.append(
            {
                "gender": gender,
                "distribution": _safe_float(row.get("Distribution", "0")),
            }
        )
    return rows


def parse_follower_territory(text: str, export_date: date) -> list[dict]:  # noqa: ARG001
    rows = []
    for row in csv.DictReader(io.StringIO(text)):
        territory = row.get("Top territories", "").strip()
        if not territory:
            continue
        rows.append(
            {
                "territory": territory,
                "distribution": _safe_float(row.get("Distribution", "0")),
            }
        )
    return rows


def parse_viewers(text: str, export_date: date) -> list[dict]:
    rows = []
    for row in csv.DictReader(io.StringIO(text)):
        raw_date = row.get("Date", "").strip()
        if not raw_date:
            continue
        total_raw = row.get("Total Viewers", "").strip()
        if total_raw.lower() == "undefined":
            continue
        d = parse_thai_date(raw_date, export_date)
        if d is None:
            log.warning("viewers: skip unparseable date", raw=raw_date)
            continue
        rows.append(
            {
                "row_date": d,
                "total_viewers": _safe_int(total_raw) if total_raw else None,
                "new_viewers": _safe_int(row.get("New Viewers", "0")),
                "returning_viewers": _safe_int(row.get("Returning Viewers", "0")),
            }
        )
    return rows


# ── Dispatch tables ───────────────────────────────────────────────────────────

_PARSERS = {
    "overview": parse_overview,
    "content": parse_content,
    "follower_activity": parse_follower_activity,
    "follower_gender": parse_follower_gender,
    "follower_history": parse_follower_history,
    "follower_territory": parse_follower_territory,
    "viewers": parse_viewers,
}


async def _upsert_rows(
    session: AsyncSession,
    csv_type: str,
    rows: list[dict],
    export_date: date,
) -> int:
    count = 0
    if csv_type == "overview":
        for r in rows:
            await upsert_overview_daily(session, export_date, **r)
            count += 1
    elif csv_type == "content":
        for r in rows:
            await upsert_video_content(session, export_date, **r)
            count += 1
    elif csv_type == "follower_history":
        for r in rows:
            await upsert_follower_history(session, export_date, **r)
            count += 1
    elif csv_type == "follower_activity":
        for r in rows:
            await upsert_follower_activity(session, export_date, **r)
            count += 1
    elif csv_type == "follower_gender":
        for r in rows:
            await upsert_follower_gender(session, export_date, **r)
            count += 1
    elif csv_type == "follower_territory":
        for r in rows:
            await upsert_follower_territory(session, export_date, **r)
            count += 1
    elif csv_type == "viewers":
        for r in rows:
            await upsert_viewers_daily(session, export_date, **r)
            count += 1
    return count


# ── Public orchestrator ───────────────────────────────────────────────────────


@dataclass
class ImportResult:
    run_id: int
    export_date: date
    filenames: list[str]
    rows_imported: int
    status: str
    error: str | None


async def run_import(
    session: AsyncSession,
    files: list[tuple[str, str]],
    export_date: date,
) -> ImportResult:
    """Parse and upsert all CSV files in one transaction.

    Args:
        session: Async SQLAlchemy session (caller manages commit/rollback).
        files: List of (filename, text_content) tuples.
        export_date: The date this export was produced — used for year inference.

    Returns:
        ImportResult with run audit details.
    """
    filenames = [f[0] for f in files]
    run = CsvImportRun(
        export_date=export_date,
        filenames=filenames,
        status="running",
        rows_imported=0,
    )
    session.add(run)
    await session.flush()  # get run.id

    total_rows = 0
    try:
        for filename, text in files:
            csv_type = detect_csv_type(filename)
            if csv_type is None:
                log.warning("csv_importer: unknown file, skipping", filename=filename)
                continue
            parser = _PARSERS[csv_type]
            rows = parser(text, export_date)
            count = await _upsert_rows(session, csv_type, rows, export_date)
            total_rows += count
            log.info("csv_importer: imported", filename=filename, type=csv_type, rows=count)

        run.status = "ok"
        run.rows_imported = total_rows
        await session.flush()
    except Exception as exc:
        run.status = "error"
        run.error = str(exc)
        run.rows_imported = total_rows
        await session.flush()
        raise

    return ImportResult(
        run_id=run.id,
        export_date=export_date,
        filenames=filenames,
        rows_imported=total_rows,
        status=run.status,
        error=run.error,
    )
