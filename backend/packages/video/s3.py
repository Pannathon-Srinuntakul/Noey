"""S3-compatible video storage.

When S3_BUCKET is set, video files are synced to/from S3 so worker
and API services on separate hosts can share them. When unset, all
methods are no-ops and local filesystem is the only storage.

Supports AWS S3 and Cloudflare R2 (set S3_ENDPOINT_URL).
"""

from __future__ import annotations

import asyncio
import pathlib
from functools import lru_cache
from typing import TYPE_CHECKING

from packages.core.logging import get_logger

if TYPE_CHECKING:
    import boto3 as _boto3_type

log = get_logger(__name__)


def _prefix(project_uid: str, folder: str) -> str:
    return f"videos/{project_uid}/{folder}/"


@lru_cache(maxsize=1)
def _client():
    import boto3
    from botocore.config import Config
    from packages.core.settings import get_settings
    s = get_settings()
    # Railway Buckets require virtual-hosted-style URLs (not path-style).
    return boto3.client(
        "s3",
        endpoint_url=s.s3_endpoint_url,
        aws_access_key_id=s.s3_access_key_id,
        aws_secret_access_key=s.s3_secret_access_key,
        region_name=s.s3_region,
        config=Config(
            s3={"addressing_style": "virtual"},
            connect_timeout=10,
            read_timeout=300,
            retries={"max_attempts": 3, "mode": "standard"},
        ),
    )


def _s3_enabled() -> bool:
    from packages.core.settings import get_settings
    s = get_settings()
    return bool(s.s3_bucket and s.s3_access_key_id and s.s3_secret_access_key and s.s3_endpoint_url)


def s3_enabled() -> bool:
    """Public check — S3 only when fully configured (avoids partial-env hangs)."""
    return _s3_enabled()


def _bucket() -> str:
    from packages.core.settings import get_settings
    return get_settings().s3_bucket  # type: ignore[return-value]


# ── sync helpers (run in executor) ───────────────────────────────────────────

def _sync_upload_dir(local_dir: pathlib.Path, prefix: str) -> int:
    """Upload all files in local_dir to S3 prefix. Returns file count."""
    client = _client()
    bucket = _bucket()
    count = 0
    for f in local_dir.rglob("*"):
        if not f.is_file():
            continue
        key = prefix + str(f.relative_to(local_dir)).replace("\\", "/")
        client.upload_file(str(f), bucket, key)
        count += 1
    return count


def _sync_download_prefix(prefix: str, local_dir: pathlib.Path) -> int:
    """Download all S3 objects under prefix to local_dir. Returns file count."""
    client = _client()
    bucket = _bucket()
    paginator = client.get_paginator("list_objects_v2")
    count = 0
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            key: str = obj["Key"]
            rel = key[len(prefix):]
            if not rel:
                continue
            dest = local_dir / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            client.download_file(bucket, key, str(dest))
            count += 1
    return count


def _sync_delete_prefix(prefix: str) -> None:
    client = _client()
    bucket = _bucket()
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        objects = [{"Key": o["Key"]} for o in page.get("Contents", [])]
        if objects:
            client.delete_objects(Bucket=bucket, Delete={"Objects": objects})


def _sync_presigned_url(key: str, expires: int = 3600) -> str:
    return _client().generate_presigned_url(
        "get_object",
        Params={"Bucket": _bucket(), "Key": key},
        ExpiresIn=expires,
    )


# ── async API ─────────────────────────────────────────────────────────────────

async def push_uploads(project_uid: str, local_dir: pathlib.Path) -> None:
    """Upload local upload dir to S3. No-op when S3 disabled."""
    if not _s3_enabled():
        return
    prefix = _prefix(project_uid, "uploads")
    try:
        count = await asyncio.to_thread(_sync_upload_dir, local_dir, prefix)
    except Exception as exc:
        log.error("s3_push_uploads_failed", project_uid=project_uid, error=str(exc))
        raise
    log.info("s3_push_uploads", project_uid=project_uid, files=count)


async def pull_uploads(project_uid: str, local_dir: pathlib.Path) -> None:
    """Download S3 uploads to local dir. No-op when S3 disabled."""
    if not _s3_enabled():
        return
    local_dir.mkdir(parents=True, exist_ok=True)
    prefix = _prefix(project_uid, "uploads")
    count = await asyncio.to_thread(_sync_download_prefix, prefix, local_dir)
    log.info("s3_pull_uploads", project_uid=project_uid, files=count)


async def push_outputs(project_uid: str, local_dir: pathlib.Path) -> None:
    """Upload local output dir to S3. No-op when S3 disabled."""
    if not _s3_enabled():
        return
    prefix = _prefix(project_uid, "outputs")
    count = await asyncio.to_thread(_sync_upload_dir, local_dir, prefix)
    log.info("s3_push_outputs", project_uid=project_uid, files=count)


async def pull_outputs(project_uid: str, local_dir: pathlib.Path) -> None:
    """Download S3 outputs to local dir. No-op when S3 disabled."""
    if not _s3_enabled():
        return
    local_dir.mkdir(parents=True, exist_ok=True)
    prefix = _prefix(project_uid, "outputs")
    count = await asyncio.to_thread(_sync_download_prefix, prefix, local_dir)
    log.info("s3_pull_outputs", project_uid=project_uid, files=count)


async def delete_project(project_uid: str) -> None:
    """Delete all S3 objects for a project. No-op when S3 disabled."""
    if not _s3_enabled():
        return
    await asyncio.to_thread(_sync_delete_prefix, f"videos/{project_uid}/")
    log.info("s3_delete_project", project_uid=project_uid)


def _output_key(project_uid: str, filename: str) -> str:
    return f"videos/{project_uid}/outputs/{filename}"


async def output_presigned_url(project_uid: str, filename: str, expires: int = 3600) -> str | None:
    """Return a presigned URL for an output file, or None when S3 disabled."""
    if not _s3_enabled():
        return None
    key = _output_key(project_uid, filename)
    return await asyncio.to_thread(_sync_presigned_url, key, expires)


async def pull_project_files(project_uid: str) -> None:
    """Download uploads + outputs for a project. No-op when S3 disabled."""
    from packages.video.storage import output_dir, upload_dir

    await pull_uploads(project_uid, upload_dir(project_uid))
    await pull_outputs(project_uid, output_dir(project_uid))


async def push_project_files(project_uid: str) -> None:
    """Upload uploads + outputs for a project. No-op when S3 disabled."""
    from packages.video.storage import output_dir, upload_dir

    up = upload_dir(project_uid)
    if up.is_dir():
        await push_uploads(project_uid, up)
    out = output_dir(project_uid)
    if out.is_dir():
        await push_outputs(project_uid, out)
