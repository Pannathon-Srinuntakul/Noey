"""Blog images: verify, re-encode, store.

An upload is never stored as sent. It must be PNG, JPEG or WebP by its magic
bytes (the filename and any claimed type are ignored), at most 8 MB before
decoding and 4096 px on either side; Pillow then decodes it and writes a NEW
WebP — longest side <= 1600 px, no EXIF/ICC/XMP or any other metadata — whose
name is the SHA-256 of the encoded bytes. So a polyglot or a payload hidden in
metadata cannot survive, and the same picture uploaded twice is one object.

Storage: the bucket of packages/video/s3.py under `blog/` (served publicly via
BLOG_MEDIA_PUBLIC_URL), or — when no bucket is configured — DATA_DIR/blog/,
served by this API at /blog/media/<name> (local development).
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import io
import pathlib
import re
from dataclasses import dataclass

from packages.core.settings import get_settings
from packages.video import s3
from packages.video.storage import data_root

MAX_UPLOAD_BYTES = 8 * 1024 * 1024
MAX_SOURCE_SIDE = 4096
MAX_OUTPUT_SIDE = 1600
WEBP_QUALITY = 82
KEY_PREFIX = "blog/"
LOCAL_ROUTE = "/blog/media"
NAME_RE = re.compile(r"^[0-9a-f]{64}\.webp$")


class ImageRejected(ValueError):
    """The upload is not acceptable; the message says what to send instead."""


@dataclass(frozen=True)
class StoredImage:
    key: str
    url: str
    width: int
    height: int
    bytes: int
    mime: str = "image/webp"


def sniff(data: bytes) -> str | None:
    """The real format by magic bytes: png | jpeg | webp | None."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def decode_base64(raw: str) -> bytes:
    """Strict base64 (a `data:image/...;base64,` prefix is tolerated), size-capped
    BEFORE decoding so a huge string is refused without allocating it twice."""
    text = raw.strip()
    if text.startswith("data:"):
        _, _, text = text.partition(",")
    text = re.sub(r"\s+", "", text)
    # 4 base64 chars carry 3 bytes.
    if len(text) * 3 // 4 > MAX_UPLOAD_BYTES:
        raise ImageRejected(f"The image is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB — send a smaller file.")
    try:
        data = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        raise ImageRejected("image_base64 is not valid base64 — send the raw file bytes base64-encoded.") from None
    if len(data) > MAX_UPLOAD_BYTES:
        raise ImageRejected(f"The image is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB — send a smaller file.")
    if not data:
        raise ImageRejected("image_base64 decoded to an empty file.")
    return data


def reencode(data: bytes) -> tuple[bytes, int, int]:
    """Decode with Pillow and write a fresh, metadata-free WebP."""
    from PIL import Image, ImageOps

    kind = sniff(data)
    if kind is None:
        raise ImageRejected("Only PNG, JPEG or WebP images are accepted (checked by file content, not by name).")
    # Refuse oversized images before decoding pixels: `open` reads only the
    # header, so the size check below runs before any pixel is decompressed.
    # (Pillow's own MAX_IMAGE_PIXELS is process-wide and left alone.)
    try:
        with Image.open(io.BytesIO(data)) as probe:
            fmt = (probe.format or "").lower()
            width, height = probe.size
        if {"jpeg": "jpeg", "png": "png", "webp": "webp"}.get(fmt) != kind:
            raise ImageRejected("The file's content does not match an image format we accept.")
        if width > MAX_SOURCE_SIDE or height > MAX_SOURCE_SIDE:
            raise ImageRejected(
                f"The image is {width}×{height} px; the maximum is {MAX_SOURCE_SIDE} px on each side. Resize it first."
            )
        with Image.open(io.BytesIO(data)) as opened:
            opened.load()
            upright = ImageOps.exif_transpose(opened)  # bake the orientation, then the EXIF goes
            has_alpha = upright.mode in ("RGBA", "LA") or (upright.mode == "P" and "transparency" in upright.info)
            img = upright.convert("RGBA" if has_alpha else "RGB")
            img.thumbnail((MAX_OUTPUT_SIDE, MAX_OUTPUT_SIDE), Image.Resampling.LANCZOS)
            out = io.BytesIO()
            # A new image object carries no info dict: no exif=, icc_profile= or xmp= is written.
            clean = Image.new(img.mode, img.size)
            clean.paste(img)
            clean.save(out, format="WEBP", quality=WEBP_QUALITY, method=6)
            return out.getvalue(), clean.width, clean.height
    except ImageRejected:
        raise
    except Image.DecompressionBombError:
        raise ImageRejected(f"The image is too large to process; keep it under {MAX_SOURCE_SIDE} px per side.") from None
    except Exception:  # noqa: BLE001 — any decoder failure is a bad upload
        raise ImageRejected("The image could not be decoded — it may be corrupt. Export it again as PNG or JPEG.") from None


def media_base() -> str:
    """The public URL prefix every blog image URL starts with (no trailing slash)."""
    s = get_settings()
    if s3.s3_enabled():
        return s.blog_media_public_url.rstrip("/")
    return f"{s.api_public_url.rstrip('/')}{LOCAL_ROUTE}"


def url_for(key: str) -> str:
    name = key.removeprefix(KEY_PREFIX)
    if s3.s3_enabled():
        return f"{get_settings().blog_media_public_url.rstrip('/')}/{KEY_PREFIX}{name}"
    return f"{media_base()}/{name}"


def local_dir() -> pathlib.Path:
    return data_root() / "blog"


def _put_s3(key: str, body: bytes) -> None:
    s3._client().put_object(
        Bucket=s3._bucket(),
        Key=key,
        Body=body,
        ContentType="image/webp",
        # Content-addressed: the bytes behind a name never change.
        CacheControl="public, max-age=31536000, immutable",
    )


async def store(encoded: bytes, width: int, height: int) -> StoredImage:
    digest = hashlib.sha256(encoded).hexdigest()
    key = f"{KEY_PREFIX}{digest}.webp"
    if s3.s3_enabled():
        if not get_settings().blog_media_public_url.strip():
            raise ImageRejected("Image storage is not configured on the server (BLOG_MEDIA_PUBLIC_URL). Ask the owner.")
        await asyncio.to_thread(_put_s3, key, encoded)
    else:
        folder = local_dir()
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / f"{digest}.webp"
        if not target.exists():
            tmp = target.with_suffix(".part")
            tmp.write_bytes(encoded)
            tmp.replace(target)
    return StoredImage(key=key, url=url_for(key), width=width, height=height, bytes=len(encoded))


def local_path(name: str) -> pathlib.Path | None:
    """The local file for /blog/media/<name>, only for a well-formed name."""
    if not NAME_RE.match(name):
        return None
    path = local_dir() / name
    return path if path.is_file() else None
