"""The owner's media library: real screenshots, demo clips, logos and PDFs,
uploaded in the admin (คลังสื่อ) and offered to the AI writer by `list_media`.

Every upload is checked by its CONTENT (magic bytes), never by its name, and
nothing is stored as sent:

- image (screenshot, logo): PNG/JPEG/WebP → re-encoded to a metadata-free WebP
  exactly like upload_image, but up to 2400 px on the long side;
- video (demo): MP4/MOV container with an H.264 video stream (other codecs are
  re-encoded to H.264), at most 2 minutes and 2160 px a side → re-muxed with
  ffmpeg: video only (no audio — it plays muted on the site anyway), all
  metadata dropped, `+faststart`; its first frame becomes a WebP poster;
- file: PDF only (`%PDF-` header) → stored as is and only ever served as a
  download (Content-Disposition: attachment, CSP sandbox) — never inline.

Files land in the same blog media store as everything else (`blog/<sha256>.<ext>`)
and a `blog_images` row with origin `library` carries alt, description, tags.
"""

from __future__ import annotations

import asyncio
import io
import json
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from packages.blog import media
from packages.blog import validation as v
from packages.db.models.blog import LIBRARY_CATEGORIES, BlogImage

MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_VIDEO_BYTES = 60 * 1024 * 1024
MAX_PDF_BYTES = 20 * 1024 * 1024
MAX_VIDEO_SECONDS = 120
MAX_VIDEO_SIDE = 2160
LIBRARY_IMAGE_SIDE = 2400
FFMPEG_TIMEOUT_SEC = 180
MAX_TAGS = 12
TAG_MAX = 40
DESCRIPTION_MAX = 1000

#: Which category holds which kind of file.
CATEGORY_KIND = {"screenshot": "image", "logo": "image", "demo": "video", "file": "file"}


class LibraryRejected(ValueError):
    """The upload is not acceptable; the message (Thai, for the owner) says why."""


@dataclass(frozen=True)
class Processed:
    kind: str
    body: bytes
    ext: str
    width: int = 0
    height: int = 0
    duration_ms: int | None = None
    poster: bytes | None = None


def sniff(data: bytes) -> str | None:
    """image | video | file (pdf) | None — by content."""
    if media.sniff(data):
        return "image"
    if len(data) >= 12 and data[4:8] == b"ftyp":
        return "video"
    if data[:5] == b"%PDF-":
        return "file"
    return None


def clean_tags(raw: list[str] | str | None) -> list[str]:
    items = raw.split(",") if isinstance(raw, str) else list(raw or [])
    out: list[str] = []
    for t in items:
        tag = " ".join(str(t).strip().lower().split())[:TAG_MAX]
        if tag and tag not in out:
            out.append(tag)
    return out[:MAX_TAGS]


def _run(cmd: list[str]) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(cmd, capture_output=True, timeout=FFMPEG_TIMEOUT_SEC, check=False)


def _process_video(data: bytes) -> Processed:
    from PIL import Image

    from packages.video.ffmpeg_bin import ffmpeg_cmd, ffprobe_cmd

    if len(data) > MAX_VIDEO_BYTES:
        raise LibraryRejected(f"คลิปใหญ่เกิน {MAX_VIDEO_BYTES // (1024 * 1024)} MB — ตัดให้สั้นลงหรือลดความละเอียดก่อน")
    with tempfile.TemporaryDirectory(prefix="noey-libvid-") as tmp:
        src, out, poster = Path(tmp) / "in.bin", Path(tmp) / "out.mp4", Path(tmp) / "poster.png"
        src.write_bytes(data)
        probe = _run([ffprobe_cmd(), "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(src)])
        if probe.returncode != 0:
            raise LibraryRejected("อ่านไฟล์วิดีโอไม่ได้ — ส่งออกใหม่เป็น MP4 (H.264)")
        meta = json.loads(probe.stdout or b"{}")
        streams = [s for s in meta.get("streams", []) if s.get("codec_type") == "video"]
        if not streams:
            raise LibraryRejected("ไฟล์นี้ไม่มีภาพวิดีโอ")
        vs = streams[0]
        width, height = int(vs.get("width") or 0), int(vs.get("height") or 0)
        duration = float(meta.get("format", {}).get("duration") or vs.get("duration") or 0)
        if not width or not height:
            raise LibraryRejected("อ่านขนาดวิดีโอไม่ได้ — ส่งออกใหม่เป็น MP4 (H.264)")
        if max(width, height) > MAX_VIDEO_SIDE:
            raise LibraryRejected(f"วิดีโอ {width}×{height} ใหญ่เกิน {MAX_VIDEO_SIDE} px ต่อด้าน")
        if duration <= 0 or duration > MAX_VIDEO_SECONDS:
            raise LibraryRejected(f"คลิปสาธิตยาวได้ไม่เกิน {MAX_VIDEO_SECONDS} วินาที")
        if vs.get("codec_name") == "h264" and vs.get("pix_fmt") in ("yuv420p", "yuvj420p"):
            video = ["-c:v", "copy"]
        else:
            video = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p",
                     "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2"]
        mux = _run([
            ffmpeg_cmd(), "-v", "error", "-y", "-i", str(src), "-map", "0:v:0", *video, "-an", "-sn", "-dn",
            "-map_metadata", "-1", "-map_chapters", "-1", "-movflags", "+faststart", str(out),
        ])
        if mux.returncode != 0 or not out.is_file():
            raise LibraryRejected("แปลงวิดีโอไม่สำเร็จ — ส่งออกใหม่เป็น MP4 (H.264) แล้วลองอีกครั้ง")
        grab = _run([ffmpeg_cmd(), "-v", "error", "-y", "-i", str(out), "-frames:v", "1", str(poster)])
        if grab.returncode != 0 or not poster.is_file():
            raise LibraryRejected("ดึงภาพแรกของวิดีโอไม่สำเร็จ")
        with Image.open(poster) as frame:
            frame.load()
            buf = io.BytesIO()
            frame.convert("RGB").save(buf, format="WEBP", quality=82, method=6)
        rotation = 0
        for side in vs.get("side_data_list", []) or []:
            rotation = int(side.get("rotation", 0) or 0)
        if abs(rotation) in (90, 270):
            width, height = height, width
        return Processed(
            kind="video", body=out.read_bytes(), ext="mp4", width=width, height=height,
            duration_ms=int(duration * 1000), poster=buf.getvalue(),
        )


def process(data: bytes, category: str) -> Processed:
    """Verify + transform one upload. Raises LibraryRejected (Thai message)."""
    if category not in LIBRARY_CATEGORIES:
        raise LibraryRejected("ประเภทสื่อไม่ถูกต้อง")
    kind = sniff(data)
    want = CATEGORY_KIND[category]
    if kind is None:
        raise LibraryRejected("รองรับเฉพาะ PNG / JPEG / WebP, วิดีโอ MP4 และ PDF (ตรวจจากเนื้อไฟล์ ไม่ใช่ชื่อไฟล์)")
    if kind != want:
        need = {"image": "รูปภาพ (PNG/JPEG/WebP)", "video": "วิดีโอ MP4", "file": "ไฟล์ PDF"}[want]
        raise LibraryRejected(f"ประเภท “{category}” ต้องเป็น{need}")
    if kind == "image":
        if len(data) > MAX_IMAGE_BYTES:
            raise LibraryRejected(f"รูปใหญ่เกิน {MAX_IMAGE_BYTES // (1024 * 1024)} MB")
        try:
            body, w, h = media.reencode(data, max_side=LIBRARY_IMAGE_SIDE)
        except media.ImageRejected as exc:
            raise LibraryRejected(f"ใช้รูปนี้ไม่ได้: {exc}") from None
        return Processed(kind="image", body=body, ext="webp", width=w, height=h)
    if kind == "video":
        return _process_video(data)
    if len(data) > MAX_PDF_BYTES:
        raise LibraryRejected(f"PDF ใหญ่เกิน {MAX_PDF_BYTES // (1024 * 1024)} MB")
    if b"%%EOF" not in data[-2048:]:
        raise LibraryRejected("ไฟล์ PDF ไม่สมบูรณ์ — ส่งออกใหม่แล้วลองอีกครั้ง")
    return Processed(kind="file", body=data, ext="pdf")


def problems_for_text(alt: str, description: str) -> list[str]:
    out = []
    if not 3 <= len(alt.strip()) <= v.ALT_MAX:
        out.append(f"คำอธิบายรูป (alt) ต้องยาว 3–{v.ALT_MAX} ตัวอักษร")
    if len(description) > DESCRIPTION_MAX:
        out.append(f"คำอธิบายยาวได้ไม่เกิน {DESCRIPTION_MAX} ตัวอักษร")
    if v.banned_terms([alt, description]):
        out.append("ห้ามเอ่ยชื่อผู้ให้บริการ AI ในคำอธิบาย")
    return out


async def save(
    db: AsyncSession, processed: Processed, *, category: str, alt: str, description: str, tags: list[str],
    filename: str, actor: str,
) -> BlogImage:
    stored = await media.store_bytes(processed.body, processed.ext, width=processed.width, height=processed.height)
    poster = await media.store_bytes(processed.poster, "webp") if processed.poster else None
    values: dict[str, Any] = {
        "url": stored.url, "key": stored.key, "mime": stored.mime, "bytes": stored.bytes,
        "width": processed.width, "height": processed.height, "alt": alt.strip()[: v.ALT_MAX],
        "uploaded_by": actor[:120], "kind": processed.kind, "origin": "library", "category": category,
        "description": description.strip()[:DESCRIPTION_MAX], "tags": tags,
        "poster_url": poster.url if poster else None, "poster_key": poster.key if poster else None,
        "duration_ms": processed.duration_ms, "filename": (filename or "")[:200] or None,
    }
    # The same bytes uploaded again: the existing row becomes a library item
    # with the new text (the file is the same object either way).
    stmt = pg_insert(BlogImage).values(**values)
    stmt = stmt.on_conflict_do_update(
        index_elements=[BlogImage.key],
        set_={k: stmt.excluded[k] for k in ("alt", "category", "description", "tags", "filename", "poster_url", "poster_key", "duration_ms")}
        | {"origin": "library", "archived_at": None},
    )
    await db.execute(stmt)
    row = (await db.execute(select(BlogImage).where(BlogImage.key == stored.key))).scalar_one()
    await db.refresh(row)
    return row


def item_out(row: BlogImage, *, internal: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {
        "url": row.url,
        "type": row.kind,
        "kind": row.category,
        "alt": row.alt,
        "description": row.description,
        "tags": list(row.tags or []),
        "width": row.width or None,
        "height": row.height or None,
    }
    if row.kind == "video":
        out["poster_url"] = row.poster_url
        out["duration_sec"] = round((row.duration_ms or 0) / 1000, 1)
        out["markdown"] = f"![{row.alt}]({row.url})"
    elif row.kind == "image":
        out["markdown"] = f"![{row.alt}]({row.url})"
    else:
        out["markdown"] = f"[{row.alt}]({row.url})"
    if internal:
        out.update({
            "id": int(row.id), "origin": row.origin, "bytes": row.bytes, "filename": row.filename,
            "archived": row.archived_at is not None,
            "created_at": row.created_at.astimezone(UTC).isoformat().replace("+00:00", "Z") if row.created_at else None,
        })
    return out


async def list_items(
    db: AsyncSession, *, category: str | None = None, tag: str | None = None, include_archived: bool = False,
    limit: int = 100, offset: int = 0,
) -> tuple[list[BlogImage], int]:
    q = select(BlogImage).where(BlogImage.origin.in_(("library", "brand")))
    if not include_archived:
        q = q.where(BlogImage.archived_at.is_(None))
    if category:
        q = q.where(BlogImage.category == category)
    if tag:
        q = q.where(BlogImage.tags.contains([tag.strip().lower()]))
    total = int((await db.execute(select(func.count()).select_from(q.subquery()))).scalar() or 0)
    rows = list((await db.execute(q.order_by(BlogImage.created_at.desc(), BlogImage.id.desc()).offset(offset).limit(limit))).scalars())
    return rows, total


async def update(
    db: AsyncSession, item_id: int, *, alt: str | None, description: str | None, tags: list[str] | None,
    archived: bool | None,
) -> BlogImage | None:
    row = (await db.execute(select(BlogImage).where(BlogImage.id == item_id, BlogImage.origin.in_(("library", "brand"))))).scalar_one_or_none()
    if row is None:
        return None
    if alt is not None:
        row.alt = alt.strip()[: v.ALT_MAX]
    if description is not None:
        row.description = description.strip()[:DESCRIPTION_MAX]
    if tags is not None:
        row.tags = clean_tags(tags)
    if archived is not None:
        row.archived_at = datetime.now(UTC) if archived else None
    await db.flush()
    return row


async def process_async(data: bytes, category: str) -> Processed:
    return await asyncio.to_thread(process, data, category)
