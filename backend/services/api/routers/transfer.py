"""Phone → web video hand-off, with the server as a RELAY and nothing more.

The desktop app receives phone footage over LAN — its Electron main process
runs a listener on the local network. A browser cannot listen on anything, so
the web build's version of รับจากมือถือ goes through here instead:

    web (logged in)  POST /videos/transfer            → ticket {token}
    phone (no auth)  POST /videos/transfer/{token}/upload   ← the QR's page
    web              GET  /videos/transfer/{token}          poll: what arrived
    web              GET  /videos/transfer/{token}/files/{i} download each
    web              DELETE /videos/transfer/{token}        the moment it has them

The token is the phone's whole credential: 128 bits of `uuid4().hex`, bound to
the creating user, and expired after TICKET_TTL. The server keeps the files
only between upload and the web's DELETE; anything left behind (an abandoned
ticket) is reclaimed by the same housekeeping sweep that clears the transcode
scratch. This mirrors the transcode contract exactly: the server is a courier,
not a store.

Scratch is keyed by TOKEN alone (see `s3.py` transfer helpers) because the
phone request knows no user_id — the ticket file inside the scratch carries the
owner for the authenticated endpoints to verify.
"""

from __future__ import annotations

import asyncio
import json
import re
import shutil
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from packages.core.logging import get_logger
from packages.video.s3 import delete_transfer, pull_transfer_file, push_transfer_file
from packages.video.storage import data_root

from ..deps import CurrentUser

log = get_logger(__name__)

router = APIRouter(prefix="/videos/transfer", tags=["transfer"])

# How long a ticket accepts uploads / can be read. Long enough to fish a phone
# out of a pocket and pick three clips; short enough that a leaked QR is stale
# before it travels.
TICKET_TTL_SEC = 30 * 60

# Caps: this is one person moving their own footage, not a file host.
MAX_FILES = 20
MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024  # a long 4K phone clip is real

# What a phone camera produces. The web client re-probes everything anyway;
# this only keeps the endpoint from being a generic upload box.
_VIDEO_SUFFIXES = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".3gp", ".avi"}


class TicketOut(BaseModel):
    token: str
    expires_in_sec: int


class TransferFile(BaseModel):
    index: int
    name: str
    bytes: int


class TransferStatus(BaseModel):
    files: list[TransferFile]
    expires_in_sec: int


def _transfer_dir(token: str) -> Path:
    return data_root() / "video_transfer" / token


def _safe_token(token: str) -> str:
    if not re.fullmatch(r"[a-f0-9]{32}", token):
        raise HTTPException(400, "token ไม่ถูกต้อง")
    return token


async def _read_ticket(token: str) -> dict:
    """The ticket file, pulled through S3 when this host did not create it."""
    path = _transfer_dir(token) / "ticket.json"
    if not await pull_transfer_file(token, path):
        raise HTTPException(404, "ไม่พบรอบรับไฟล์นี้ — สร้าง QR ใหม่จากหน้าเว็บ")
    try:
        ticket = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:  # unreadable = as good as absent
        raise HTTPException(404, "ไม่พบรอบรับไฟล์นี้ — สร้าง QR ใหม่จากหน้าเว็บ") from exc
    if time.time() - float(ticket.get("created", 0)) > TICKET_TTL_SEC:
        raise HTTPException(410, "QR นี้หมดอายุแล้ว — สร้างใหม่จากหน้าเว็บ")
    return ticket


async def _read_manifest(token: str) -> list[dict]:
    path = _transfer_dir(token) / "manifest.json"
    if not await pull_transfer_file(token, path):
        return []
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def _ttl_left(ticket: dict) -> int:
    return max(0, int(TICKET_TTL_SEC - (time.time() - float(ticket.get("created", 0)))))


@router.post("", response_model=TicketOut, status_code=201)
async def create_ticket(auth: CurrentUser) -> TicketOut:
    token = uuid.uuid4().hex
    base = _transfer_dir(token)
    base.mkdir(parents=True, exist_ok=True)
    ticket_path = base / "ticket.json"
    ticket_path.write_text(
        json.dumps({"user_id": auth.user_id, "created": time.time()}), encoding="utf-8"
    )
    # The phone's upload may land on another API host — the ticket has to be
    # readable wherever it lands.
    await push_transfer_file(token, ticket_path)
    log.info("transfer_ticket_created", user_id=auth.user_id, token=token)
    return TicketOut(token=token, expires_in_sec=TICKET_TTL_SEC)


@router.post("/{token}/upload")
async def upload_from_phone(token: str, file: UploadFile = File(...)) -> dict:
    """The phone side. NO auth — the single-use token is the credential."""
    token = _safe_token(token)
    await _read_ticket(token)  # 404/410 handles absent and expired

    name = Path(file.filename or "clip.mp4").name
    suffix = Path(name).suffix.lower()
    if suffix not in _VIDEO_SUFFIXES:
        raise HTTPException(422, f"ไฟล์ประเภทนี้ไม่รองรับ ({suffix or 'ไม่ทราบนามสกุล'})")

    manifest = await _read_manifest(token)
    if len(manifest) >= MAX_FILES:
        raise HTTPException(429, f"รับได้สูงสุด {MAX_FILES} ไฟล์ต่อรอบ")

    index = len(manifest)
    dest = _transfer_dir(token) / f"file_{index:03d}{suffix}"
    size = 0
    # Streamed: whole camera files, hundreds of MB — never buffered in memory.
    with dest.open("wb") as out:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_FILE_BYTES:
                out.close()
                dest.unlink(missing_ok=True)
                raise HTTPException(413, "ไฟล์ใหญ่เกินไป (สูงสุด 4GB ต่อไฟล์)")
            out.write(chunk)
    if size == 0:
        dest.unlink(missing_ok=True)
        raise HTTPException(422, "ไฟล์ว่างเปล่า")

    manifest.append({"file": dest.name, "name": name, "bytes": size})
    manifest_path = _transfer_dir(token) / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    await push_transfer_file(token, dest)
    await push_transfer_file(token, manifest_path)
    log.info("transfer_file_received", token=token, name=name, bytes=size, index=index)
    return {"ok": True, "index": index, "count": len(manifest)}


@router.get("/{token}", response_model=TransferStatus)
async def transfer_status(token: str, auth: CurrentUser) -> TransferStatus:
    token = _safe_token(token)
    ticket = await _read_ticket(token)
    if ticket.get("user_id") != auth.user_id:
        raise HTTPException(403, "ไม่ใช่รอบรับไฟล์ของบัญชีนี้")
    manifest = await _read_manifest(token)
    return TransferStatus(
        files=[
            TransferFile(index=i, name=row.get("name", row["file"]), bytes=int(row["bytes"]))
            for i, row in enumerate(manifest)
        ],
        expires_in_sec=_ttl_left(ticket),
    )


@router.get("/{token}/files/{index}")
async def download_transfer_file(token: str, index: int, auth: CurrentUser) -> FileResponse:
    token = _safe_token(token)
    ticket = await _read_ticket(token)
    if ticket.get("user_id") != auth.user_id:
        raise HTTPException(403, "ไม่ใช่รอบรับไฟล์ของบัญชีนี้")
    manifest = await _read_manifest(token)
    if index < 0 or index >= len(manifest):
        raise HTTPException(404, "ไม่มีไฟล์ลำดับนี้")
    row = manifest[index]
    path = _transfer_dir(token) / row["file"]
    if not await pull_transfer_file(token, path):
        raise HTTPException(404, "ไฟล์หายไปจากรอบรับ — ส่งจากมือถือใหม่อีกครั้ง")
    return FileResponse(str(path), media_type="video/mp4", filename=row.get("name", row["file"]))


@router.delete("/{token}", status_code=204)
async def close_ticket(token: str, auth: CurrentUser) -> Response:
    """Called the moment the web has the bytes. The server keeps no video."""
    token = _safe_token(token)
    ticket = await _read_ticket(token)
    if ticket.get("user_id") != auth.user_id:
        raise HTTPException(403, "ไม่ใช่รอบรับไฟล์ของบัญชีนี้")
    base = _transfer_dir(token)
    if base.is_dir():
        await asyncio.to_thread(shutil.rmtree, base, True)
    await delete_transfer(token)
    log.info("transfer_ticket_closed", token=token)
    return Response(status_code=204)
