"""Monthly reconciliation: what we recorded vs what each vendor invoiced.

Per vendor and UTC calendar month (vendors bill by calendar month):

- the vendor units recorded (tokens in/out/cached; billed audio seconds);
- Σ ``cost_thb`` of those rows — split into rows tied to a paid run
  (``run_id``) and rows that are not (legacy, sync routes, owner scripts);
- how many rows could not be priced (legacy rows before cost recording);
- the invoice the owner typed in, and the gap. A gap above ``WARN_PCT`` is
  flagged: either recording is missing requests, or the price table / FX in
  the admin is wrong (docs/token-billing-plan.md §3.6).

Dev scripts in backend/scripts/ run without a usage context, so they write no
rows — their spend shows up only in the gap.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from packages.db.models.fx import VendorInvoice
from packages.db.models.llm_usage import LlmUsageLog
from packages.db.models.stt_usage import SttUsageLog

VENDORS = ("gemini", "elevenlabs")
WARN_PCT = 5.0
MONTH_RE = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])$")


def month_bounds(month: str) -> tuple[datetime, datetime]:
    """``2026-09`` → [2026-09-01, 2026-10-01) in UTC. ValueError on a bad month."""
    found = MONTH_RE.match(month or "")
    if not found:
        raise ValueError("month must be YYYY-MM")
    year, mon = int(found.group(1)), int(found.group(2))
    start = datetime(year, mon, 1, tzinfo=UTC)
    end = datetime(year + (mon == 12), 1 if mon == 12 else mon + 1, 1, tzinfo=UTC)
    return start, end


def _gap(recorded: float, invoice: float | None) -> tuple[float | None, bool]:
    if invoice is None or invoice <= 0:
        return None, False
    pct = (invoice - recorded) / invoice * 100
    return round(pct, 2), abs(pct) > WARN_PCT


async def reconciliation(session: AsyncSession, month: str) -> dict[str, Any]:
    start, end = month_bounds(month)
    llm_in_month = (LlmUsageLog.created_at >= start, LlmUsageLog.created_at < end)
    stt_in_month = (SttUsageLog.created_at >= start, SttUsageLog.created_at < end)

    llm = (
        await session.execute(
            select(
                func.count(LlmUsageLog.id),
                func.coalesce(func.sum(LlmUsageLog.input_tokens), 0),
                func.coalesce(func.sum(LlmUsageLog.output_tokens), 0),
                func.coalesce(func.sum(LlmUsageLog.cached_tokens), 0),
                func.coalesce(func.sum(LlmUsageLog.cost_thb), 0),
                func.coalesce(func.sum(LlmUsageLog.cost_thb).filter(LlmUsageLog.run_id.is_not(None)), 0),
                func.count(LlmUsageLog.id).filter(
                    LlmUsageLog.cost_thb.is_(None),
                    (LlmUsageLog.input_tokens + LlmUsageLog.output_tokens) > 0,
                ),
                func.count(LlmUsageLog.id).filter(LlmUsageLog.status != "ok"),
            ).where(*llm_in_month)
        )
    ).one()
    stt = (
        await session.execute(
            select(
                func.count(SttUsageLog.id),
                func.coalesce(func.sum(SttUsageLog.audio_sec), 0.0),
                func.coalesce(func.sum(SttUsageLog.cost_thb), 0),
                func.coalesce(func.sum(SttUsageLog.cost_thb).filter(SttUsageLog.run_id.is_not(None)), 0),
                func.count(SttUsageLog.id).filter(SttUsageLog.cost_thb.is_(None), SttUsageLog.audio_sec > 0),
            ).where(*stt_in_month)
        )
    ).one()
    invoices = {
        inv.vendor: inv
        for inv in (
            await session.execute(select(VendorInvoice).where(VendorInvoice.month == month))
        ).scalars()
    }

    def vendor(name: str, recorded: Decimal, attributed: Decimal, units: dict[str, Any],
               rows: int, unpriced: int) -> dict[str, Any]:
        inv = invoices.get(name)
        invoice = float(inv.amount_thb) if inv else None
        rec = round(float(recorded), 2)
        gap_pct, warn = _gap(rec, invoice)
        return {
            "vendor": name,
            "rows": int(rows),
            "units": units,
            "recorded_thb": rec,
            "attributed_thb": round(float(attributed), 2),
            "unattributed_thb": round(float(recorded - attributed), 2),
            "unpriced_rows": int(unpriced),
            "invoice_thb": invoice,
            "invoice_note": inv.note if inv else None,
            "gap_pct": gap_pct,
            "warn": warn,
        }

    return {
        "month": month,
        "warn_pct": WARN_PCT,
        "vendors": [
            vendor(
                "gemini", llm[4], llm[5],
                {"input_tokens": int(llm[1]), "output_tokens": int(llm[2]),
                 "cached_tokens": int(llm[3]), "failed_calls": int(llm[7])},
                llm[0], llm[6],
            ),
            vendor(
                "elevenlabs", stt[2], stt[3],
                {"audio_hours": round(float(stt[1]) / 3600, 3)},
                stt[0], stt[4],
            ),
        ],
    }


async def save_invoice(
    session: AsyncSession, month: str, vendor: str, amount_thb: float, note: str | None, actor_id: int
) -> dict[str, Any] | None:
    """Upsert one invoice. Returns the previous value (for the audit), or None."""
    month_bounds(month)
    if vendor not in VENDORS:
        raise ValueError("unknown vendor")
    before = (
        await session.execute(
            select(VendorInvoice).where(VendorInvoice.month == month, VendorInvoice.vendor == vendor)
        )
    ).scalar_one_or_none()
    previous = (
        {"amount_thb": float(before.amount_thb), "note": before.note} if before is not None else None
    )
    amount = Decimal(str(round(amount_thb, 2)))
    stmt = pg_insert(VendorInvoice).values(
        month=month, vendor=vendor, amount_thb=amount, note=note, updated_by=actor_id
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["month", "vendor"],
        set_={"amount_thb": amount, "note": note, "updated_by": actor_id, "updated_at": func.now()},
    )
    await session.execute(stmt)
    return previous
