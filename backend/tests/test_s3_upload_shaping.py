"""Object-storage uploads are bounded, because boto3's defaults are not.

Measured 2026-09-23 with the real footage (`docs/load-test-real-footage-2026-09-23.md`):
at 80 concurrent 527 MB uploads, 44% returned HTTP 500 and aggregate throughput
FELL from 116 MB/s to 64. boto3 gives every `upload_file` 10 threads, 8 MB parts
and a 100-deep queue of those parts, so eighty of them ask for up to 800 threads
and gigabytes of buffered chunks at once.
"""

from __future__ import annotations

import asyncio

import pytest

from packages.core.settings import get_settings
from packages.video import s3


@pytest.fixture(autouse=True)
def _fresh_caches():
    s3._transfer_config.cache_clear()
    s3._upload_gate.cache_clear()
    yield
    s3._transfer_config.cache_clear()
    s3._upload_gate.cache_clear()


def test_parts_are_fewer_and_larger_than_the_library_default():
    from boto3.s3.transfer import TransferConfig

    cfg = s3._transfer_config()
    default = TransferConfig()
    assert cfg.multipart_chunksize > default.multipart_chunksize
    assert cfg.max_concurrency < default.max_concurrency
    # The queue is what holds chunks in memory; 100 × 8 MB per upload is the
    # number that made eighty concurrent uploads impossible.
    assert cfg.max_io_queue <= 10


def test_the_chunk_never_drops_below_s3s_own_floor(monkeypatch):
    # S3 refuses a multipart part under 5 MB, so a small setting must not turn
    # into a bucket that rejects every upload.
    monkeypatch.setenv("S3_MULTIPART_CHUNK_MB", "1")
    get_settings.cache_clear()
    s3._transfer_config.cache_clear()
    assert s3._transfer_config().multipart_chunksize == 5 * 1024 * 1024
    get_settings.cache_clear()


def test_the_settings_drive_the_config(monkeypatch):
    monkeypatch.setenv("S3_MULTIPART_CHUNK_MB", "32")
    monkeypatch.setenv("S3_TRANSFER_CONCURRENCY", "2")
    get_settings.cache_clear()
    s3._transfer_config.cache_clear()
    cfg = s3._transfer_config()
    assert cfg.multipart_chunksize == 32 * 1024 * 1024
    assert cfg.max_concurrency == 2
    get_settings.cache_clear()


async def test_only_so_many_uploads_run_at_once(monkeypatch, tmp_path):
    monkeypatch.setenv("S3_MAX_CONCURRENT_UPLOADS", "3")
    get_settings.cache_clear()
    s3._upload_gate.cache_clear()

    f = tmp_path / "clip.mp4"
    f.write_bytes(b"x")
    monkeypatch.setattr(s3, "_s3_enabled", lambda: True)

    running = 0
    peak = 0

    def fake_upload(local_path, key):
        nonlocal running, peak
        running += 1
        peak = max(peak, running)
        import time

        time.sleep(0.02)
        running -= 1

    monkeypatch.setattr(s3, "_sync_upload_one", fake_upload)
    await asyncio.gather(*(s3.push_output_file("p", "normalized/clip.mp4", f) for _ in range(12)))
    assert peak == 3
    get_settings.cache_clear()
