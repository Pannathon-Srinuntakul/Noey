import io
import zipfile
from datetime import date

from fastapi import APIRouter, Depends, File, Query, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.db.models.tiktok_csv import CsvImportRun
from services.api import csv_importer
from services.api.deps import db_session
from services.api.schemas import ImportRunOut

router = APIRouter(prefix="/import", tags=["import"])


def _expand_files(raw: bytes, filename: str) -> list[tuple[str, str]]:
    """Return (filename, text) pairs — expands zip, passes csv through."""
    if filename.lower().endswith(".zip"):
        pairs: list[tuple[str, str]] = []
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            for entry in zf.infolist():
                if entry.filename.lower().endswith(".csv") and not entry.is_dir():
                    csv_bytes = zf.read(entry.filename)
                    pairs.append((entry.filename, csv_bytes.decode("utf-8-sig")))
        return pairs
    return [(filename, raw.decode("utf-8-sig"))]


@router.post("", response_model=ImportRunOut, status_code=201)
async def upload_csvs(
    files: list[UploadFile] = File(...),
    export_date: date | None = Query(default=None),
    session: AsyncSession = Depends(db_session),
) -> ImportRunOut:
    if export_date is None:
        export_date = date.today()

    pairs: list[tuple[str, str]] = []
    for f in files:
        raw = await f.read()
        pairs.extend(_expand_files(raw, f.filename or "unknown"))

    result = await csv_importer.run_import(session, pairs, export_date)
    await session.commit()

    run = (
        await session.execute(select(CsvImportRun).where(CsvImportRun.id == result.run_id))
    ).scalar_one()
    return ImportRunOut.model_validate(run)


@router.get("/runs", response_model=list[ImportRunOut])
async def list_import_runs(
    limit: int = 50,
    session: AsyncSession = Depends(db_session),
) -> list[ImportRunOut]:
    rows = (
        await session.execute(
            select(CsvImportRun).order_by(CsvImportRun.created_at.desc()).limit(limit)
        )
    ).scalars().all()
    return [ImportRunOut.model_validate(r) for r in rows]
