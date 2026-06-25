"""Default workspace provisioning for TikTok Affiliate creators.

Creates 5 ready-to-use tables when a tenant is first set up (only if no tables exist).
Column definitions mirror the frontend tablePresets.ts "ติดตามสินค้า" preset for the
product-tracking table, with 4 additional affiliate-specific tables.
"""

from __future__ import annotations

import uuid

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from packages.db.models.custom_table import CustomTableMeta
from packages.tables.formula import compile_formula

UI_TYPE_TO_PG = {
    "text": "TEXT", "number": "NUMERIC", "date": "DATE",
    "datetime": "TIMESTAMPTZ", "select": "TEXT",
    "multi_select": "TEXT[]", "boolean": "BOOLEAN",
}

_OPTION_COLORS = [
    "#f97316", "#eab308", "#22c55e", "#06b6d4",
    "#3b82f6", "#8b5cf6", "#ec4899", "#ef4444",
    "#14b8a6", "#64748b",
]


def _opt(labels: list[str]) -> list[dict]:
    return [
        {"uid": uuid.uuid4().hex[:8], "label": lbl, "color": _OPTION_COLORS[i % len(_OPTION_COLORS)], "order": i}
        for i, lbl in enumerate(labels)
    ]


# ── Table definitions ─────────────────────────────────────────────────────────

WORKSPACE_TABLES: list[dict] = [
    {
        "name": "ค้นหาสินค้า",
        "columns": [
            {"label": "ชื่อสินค้า", "ui_type": "text"},
            {"label": "หมวดหมู่", "ui_type": "select", "options": _opt(["A - นางฟ้า", "B - มาใหม่", "C - ประหยัด", "D - คอมสูง"])},
            {"label": "ราคา (บาท)", "ui_type": "number"},
            {"label": "เปอร์เซ็นต์คอมมิชชัน", "ui_type": "number"},
            {"label": "จำนวนคู่แข่ง", "ui_type": "number"},
            {"label": "ความน่าสนใจ", "ui_type": "select", "options": _opt(["สูง", "กลาง", "ต่ำ"])},
            {"label": "สถานะ", "ui_type": "select", "options": _opt(["กำลังดู", "ผ่าน", "ไม่ผ่าน"])},
            {"label": "หมายเหตุ", "ui_type": "text"},
        ],
    },
    {
        "name": "ปฏิทินคอนเทนต์",
        "columns": [
            {"label": "วันที่โพสต์", "ui_type": "date"},
            {"label": "ชื่อคอนเทนต์", "ui_type": "text"},
            {"label": "สินค้าที่โปรโมต", "ui_type": "text"},
            {"label": "ประเภท", "ui_type": "select", "options": _opt(["วิดีโอ", "ไลฟ์", "Reels"])},
            {"label": "สถานะ", "ui_type": "select", "options": _opt(["ร่าง", "กำลังผลิต", "เผยแพร่แล้ว"])},
            {"label": "ยอดวิว", "ui_type": "number"},
            {"label": "ยอดขาย (บาท)", "ui_type": "number"},
        ],
    },
    {
        "name": "ผลลัพธ์วิดีโอ",
        "columns": [
            {"label": "ลิงก์วิดีโอ", "ui_type": "text"},
            {"label": "วันที่โพสต์", "ui_type": "date"},
            {"label": "ยอดวิว", "ui_type": "number"},
            {"label": "ยอดไลก์", "ui_type": "number"},
            {"label": "CTR (%)", "ui_type": "number"},
            {"label": "จำนวนออเดอร์", "ui_type": "number"},
            {"label": "รายได้ (บาท)", "ui_type": "number"},
        ],
    },
    {
        # ติดตามสินค้า — mirrors the existing "ติดตามสินค้า (TikTok Affiliate)" preset
        "name": "ติดตามสินค้า",
        "columns": [
            {"label": "ชื่อสินค้า", "ui_type": "text"},
            {"label": "หมวดหมู่", "ui_type": "select", "options": _opt(["A", "B", "C", "D"])},
            {"label": "แบรนด์", "ui_type": "text"},
            {"label": "ประเภทสินค้า", "ui_type": "text"},
            {"label": "ค่าคอมมิชชั่น/ชิ้น (บาท)", "ui_type": "number"},
            {"label": "คอมมิชชั่นหลังยิงแอด/ชิ้น (บาท)", "ui_type": "number"},
            {"label": "วันที่ได้รับสินค้า", "ui_type": "date"},     # col_7
            {"label": "ระยะเวลาการทำงาน (วัน)", "ui_type": "number"},  # col_8
            {  # col_9 — formula: col_7 + col_8 → DATE
                "label": "วันที่ต้องลงคลิป",
                "ui_type": "formula",
                "formula": {"type": "date_add", "col_a": "col_7", "col_b": "col_8"},
            },
            {"label": "สินค้าตัวอย่าง", "ui_type": "text"},
            {"label": "สถานะ", "ui_type": "select", "options": _opt(["ทำแล้ว", "ยังไม่ได้ทำ"])},
            {"label": "หมายเหตุ", "ui_type": "text"},
        ],
    },
    {
        "name": "ติดต่อแบรนด์",
        "columns": [
            {"label": "ชื่อแบรนด์", "ui_type": "text"},
            {"label": "ผู้ติดต่อ", "ui_type": "text"},
            {"label": "วันที่ติดต่อ", "ui_type": "date"},
            {"label": "สถานะ", "ui_type": "select", "options": _opt(["รอตอบ", "กำลังเจรจา", "ปิดดีล", "ไม่สนใจ"])},
            {"label": "หมายเหตุ", "ui_type": "text"},
        ],
    },
]


async def provision_workspace(session: AsyncSession, tenant_slug: str) -> None:
    """Create the 5 default TikTok Affiliate tables if the tenant has no tables yet."""
    existing = (
        await session.execute(select(func.count()).select_from(CustomTableMeta))
    ).scalar_one()
    if existing > 0:
        return  # already provisioned

    for pos, tbl_def in enumerate(WORKSPACE_TABLES):
        pg = "udt_" + uuid.uuid4().hex[:8]
        # Create pg table
        await session.execute(
            text(
                f'CREATE TABLE "{pg}" ('
                f"  uid UUID PRIMARY KEY DEFAULT gen_random_uuid(),"
                f"  seq BIGSERIAL,"
                f"  created_at TIMESTAMPTZ DEFAULT now(),"
                f"  updated_at TIMESTAMPTZ DEFAULT now()"
                f")"
            )
        )
        col_metas: list[dict] = []
        for seq, col_def in enumerate(tbl_def["columns"], start=1):
            key = f"col_{seq}"
            ui = col_def["ui_type"]
            formula_def = col_def.get("formula")

            if ui == "formula" and formula_def:
                expr, pg_type = compile_formula(formula_def, col_metas)
                ddl = (
                    f'ALTER TABLE "{pg}" ADD COLUMN "{key}" {pg_type} '
                    f"GENERATED ALWAYS AS ({expr}) STORED"
                )
            else:
                pg_type = UI_TYPE_TO_PG.get(ui, "TEXT")
                ddl = f'ALTER TABLE "{pg}" ADD COLUMN "{key}" {pg_type}'

            await session.execute(text(ddl))

            col_metas.append({
                "key": key,
                "label": col_def["label"],
                "ui_type": ui,
                "pg_type": pg_type,
                "options": col_def.get("options", []),
                "formula": formula_def,
                "width": 160,
                "seq": seq,
            })

        meta = CustomTableMeta(
            display_name=tbl_def["name"],
            pg_table_name=pg,
            columns=col_metas,
            position=pos,
        )
        session.add(meta)

    await session.commit()
