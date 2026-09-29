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
import contextlib
import json
import re
import shutil
import time
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from packages.core.logging import get_logger
from packages.core.settings import get_settings
from packages.video.s3 import delete_transfer, pull_transfer_file, push_transfer_file, s3_enabled
from packages.video.storage import data_root

from .. import ratelimit
from ..deps import CurrentUser

log = get_logger(__name__)

router = APIRouter(prefix="/videos/transfer", tags=["transfer"])

# How long a ticket accepts uploads / can be read. Long enough to fish a phone
# out of a pocket and pick three clips; short enough that a leaked QR is stale
# before it travels.
TICKET_TTL_SEC = 30 * 60

# Caps: this is one person moving their own footage, not a file host. The
# per-file cap is the same one every whole-clip upload gets
# (settings.max_upload_bytes, 4 GB — a long 4K phone clip is real).
MAX_FILES = 20

#: Hard ceiling on what one ticket may relay in total. The plan's storage
#: allowance lowers it further (a Free ticket relays at most its 1 GB) — the
#: bytes land on the API's shared volume and in the bucket, and without a
#: budget any account could loop tickets and fill both.
MAX_TICKET_BYTES = 16 * 1024**3

#: Uploads are refused while the data volume has less than this free: the
#: volume is shared with every tenant's projects and renders.
MIN_FREE_DISK_BYTES = 2 * 1024**3

#: Upload attempts (successful or not) per ticket: bounds the retries a leaked
#: token can spend. Every attempt burns its own file slot.
MAX_ATTEMPTS = MAX_FILES * 3

_UNAVAILABLE = "ระบบไม่พร้อมให้บริการชั่วคราว กรุณาลองใหม่อีกครั้งในอีกสักครู่"


class TransferStore:
    """Per-ticket coordination across API processes/hosts: a slot counter (the
    file index — two concurrent uploads never share a file name) and a lock
    around the manifest's read-modify-write (no lost rows, and the file/byte
    caps are checked where they cannot be raced). Redis in production."""

    def __init__(self, url: str) -> None:
        self._url = url
        self._client: Any = None

    def _redis(self) -> Any:
        if self._client is None:
            import redis.asyncio as aioredis

            self._client = aioredis.from_url(self._url, socket_timeout=2, socket_connect_timeout=1)
        return self._client

    async def next_slot(self, token: str) -> int:
        key = f"noey:transfer:slot:{token}"
        try:
            async with self._redis().pipeline(transaction=True) as pipe:
                pipe.incr(key)
                pipe.expire(key, TICKET_TTL_SEC + 60)
                count, _ = await pipe.execute()
        except Exception as exc:  # fail closed: no uncounted uploads
            log.warning("transfer_store_unavailable", error=type(exc).__name__)
            raise HTTPException(503, _UNAVAILABLE, headers={"Retry-After": "30"}) from exc
        return int(count) - 1

    @contextlib.asynccontextmanager
    async def locked(self, token: str) -> AsyncIterator[None]:
        lock = self._redis().lock(f"noey:transfer:lock:{token}", timeout=60, blocking_timeout=30)
        try:
            acquired = await lock.acquire()
        except Exception as exc:
            log.warning("transfer_store_unavailable", error=type(exc).__name__)
            raise HTTPException(503, _UNAVAILABLE, headers={"Retry-After": "30"}) from exc
        if not acquired:
            raise HTTPException(503, _UNAVAILABLE, headers={"Retry-After": "5"})
        try:
            yield
        finally:
            with contextlib.suppress(Exception):
                await lock.release()


class MemoryTransferStore:
    """In-process store — tests, and nothing else."""

    def __init__(self) -> None:
        self.slots: dict[str, int] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    async def next_slot(self, token: str) -> int:
        n = self.slots.get(token, 0)
        self.slots[token] = n + 1
        return n

    @contextlib.asynccontextmanager
    async def locked(self, token: str) -> AsyncIterator[None]:
        async with self._locks.setdefault(token, asyncio.Lock()):
            yield


_store: TransferStore | MemoryTransferStore | None = None


def get_store() -> TransferStore | MemoryTransferStore:
    global _store
    if _store is None:
        _store = TransferStore(get_settings().redis_url)
    return _store


def _ticket_budget(auth: Any) -> int:
    """Bytes one ticket may relay: the plan's storage allowance, capped."""
    user = getattr(auth, "user", None)
    if user is not None and bool(getattr(user, "is_admin", False)):
        return MAX_TICKET_BYTES
    plan = str(getattr(user, "plan", None) or "free")
    quota = get_settings().plan_storage_limit(plan)
    return min(MAX_TICKET_BYTES, quota) if quota else MAX_TICKET_BYTES

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


def _log_token(token: str) -> str:
    """The token is the phone's whole credential, so the log gets a prefix
    that is enough to correlate lines and not enough to upload with."""
    return token[:8]


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
    # Every ticket opens a public upload door: bounded per account.
    await ratelimit.enforce([(ratelimit.TRANSFER_TICKET_ACCOUNT, str(auth.user_id))])
    token = uuid.uuid4().hex
    base = _transfer_dir(token)
    base.mkdir(parents=True, exist_ok=True)
    ticket_path = base / "ticket.json"
    ticket_path.write_text(
        json.dumps({"user_id": auth.user_id, "created": time.time(), "budget_bytes": _ticket_budget(auth)}),
        encoding="utf-8",
    )
    # The phone's upload may land on another API host — the ticket has to be
    # readable wherever it lands.
    await push_transfer_file(token, ticket_path)
    log.info("transfer_ticket_created", user_id=auth.user_id, token=_log_token(token))
    return TicketOut(token=token, expires_in_sec=TICKET_TTL_SEC)


@router.post("/{token}/upload")
async def upload_from_phone(token: str, request: Request, file: UploadFile = File(...)) -> dict:
    """The phone side. NO auth — the token is the credential.

    Bounded three ways because the caller is anonymous: per IP (rate limit),
    per ticket (MAX_FILES files, MAX_ATTEMPTS tries, the ticket's byte budget —
    the plan's storage allowance, capped) and by the free space on the shared
    data volume. The file/byte caps are re-checked under the ticket's lock, so
    parallel uploads cannot race past them or drop each other's manifest rows.
    """
    token = _safe_token(token)
    await ratelimit.enforce([(ratelimit.TRANSFER_UPLOAD_IP, ratelimit.client_ip(request))])
    ticket = await _read_ticket(token)  # 404/410 handles absent and expired
    budget = int(ticket.get("budget_bytes") or MAX_TICKET_BYTES)

    name = Path(file.filename or "clip.mp4").name
    suffix = Path(name).suffix.lower()
    if suffix not in _VIDEO_SUFFIXES:
        raise HTTPException(422, f"ไฟล์ประเภทนี้ไม่รองรับ ({suffix or 'ไม่ทราบนามสกุล'})")

    # Early, unlocked checks: refuse before streaming a byte when already full.
    manifest = await _read_manifest(token)
    if len(manifest) >= MAX_FILES:
        raise HTTPException(429, f"รับได้สูงสุด {MAX_FILES} ไฟล์ต่อรอบ")
    used = sum(int(row.get("bytes", 0)) for row in manifest)
    room = budget - used
    if room <= 0:
        raise HTTPException(413, "ไฟล์รอบนี้เต็มพื้นที่ที่แพลนรับได้แล้ว — ปิดรอบนี้แล้วสร้าง QR ใหม่")
    base = _transfer_dir(token)
    base.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(base).free < MIN_FREE_DISK_BYTES:
        log.warning("transfer_disk_low", token=_log_token(token))
        raise HTTPException(507, "พื้นที่ของระบบเต็มชั่วคราว — ลองใหม่อีกครั้งภายหลัง")

    store = get_store()
    index = await store.next_slot(token)
    if index >= MAX_ATTEMPTS:
        raise HTTPException(429, f"รับได้สูงสุด {MAX_FILES} ไฟล์ต่อรอบ")
    dest = base / f"file_{index:03d}{suffix}"
    # Streamed: whole camera files, hundreds of MB — never buffered in memory.
    # `receive_upload` is the loop this route pioneered, shared now with
    # every other upload route (and it deletes the partial file on a 413).
    from services.api.routers.videos import receive_upload

    limit = min(get_settings().max_upload_bytes, room)
    size = await receive_upload(file, dest, limit=limit, label="")
    if size == 0:
        dest.unlink(missing_ok=True)
        raise HTTPException(422, "ไฟล์ว่างเปล่า")

    async with store.locked(token):
        manifest = await _read_manifest(token)
        used = sum(int(row.get("bytes", 0)) for row in manifest)
        if len(manifest) >= MAX_FILES:
            dest.unlink(missing_ok=True)
            raise HTTPException(429, f"รับได้สูงสุด {MAX_FILES} ไฟล์ต่อรอบ")
        if used + size > budget:
            dest.unlink(missing_ok=True)
            raise HTTPException(413, "ไฟล์รอบนี้เต็มพื้นที่ที่แพลนรับได้แล้ว — ปิดรอบนี้แล้วสร้าง QR ใหม่")
        await push_transfer_file(token, dest)
        manifest.append({"file": dest.name, "name": name, "bytes": size})
        manifest_path = base / "manifest.json"
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        await push_transfer_file(token, manifest_path)
    if s3_enabled():
        # The bucket has it; the download route pulls it back on demand. The
        # shared volume keeps nothing it does not need.
        dest.unlink(missing_ok=True)
    log.info("transfer_file_received", token=_log_token(token), name=name, bytes=size, index=index)
    return {"ok": True, "index": len(manifest) - 1, "count": len(manifest)}


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
    log.info("transfer_ticket_closed", token=_log_token(token))
    return Response(status_code=204)
