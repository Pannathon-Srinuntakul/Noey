"""User-defined dynamic tables.

This is the ONLY Alembic-managed table for the custom-table feature. It stores metadata
about tables the user creates at runtime. Each user table becomes a real PostgreSQL table
(``udt_<hex>``) created/altered/dropped via DDL at request time — see
``services/api/routers/custom_tables.py``. The column metadata (display label, ui type,
select options, formula definition) lives in the ``columns`` JSONB list here; the actual
columns (``col_1``..``col_N``) live on the dynamic table.
"""

import uuid as _uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Integer, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from packages.db.base import Base


class CustomTableMeta(Base):
    __tablename__ = "custom_table_meta"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    display_name: Mapped[str] = mapped_column(String(128))
    # Real Postgres table name, e.g. "udt_a3f2b1c4". Never derived from user input.
    pg_table_name: Mapped[str] = mapped_column(String(64), unique=True)
    # list[dict]: {key, label, ui_type, pg_type, options, formula, width, seq}
    columns: Mapped[list] = mapped_column(JSONB, default=list)
    # Sidebar display order (lower = first). Set to max+1 on create; user can reorder.
    position: Mapped[int] = mapped_column(Integer, default=0, index=True)
    # External-facing UUID — used in all API routes and frontend URLs.
    uid: Mapped[str] = mapped_column(
        String(36), unique=True, default=lambda: str(_uuid.uuid4())
    )
    # Summary tab config: which columns + which aggregates to show.
    # [{col_key, aggs: ["count"|"sum"|"avg"|"min"|"max"|"pct"]}]
    summary_config: Mapped[list] = mapped_column(JSONB, default=list)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
