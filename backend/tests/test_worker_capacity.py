"""Worker capacity comes from settings, and ffmpeg transcodes are capped apart
from the (mostly waiting) AI jobs (2026-09-22)."""

from __future__ import annotations

import asyncio

from packages.core.settings import Settings


def test_defaults_raise_ai_concurrency_but_keep_transcodes_small():
    s = Settings()
    assert s.worker_max_jobs == 30
    assert s.worker_transcode_concurrency == 2


def test_worker_reads_max_jobs_from_settings():
    from services.worker.tasks import WorkerSettings
    from packages.core.settings import get_settings

    assert WorkerSettings.max_jobs == get_settings().worker_max_jobs


async def test_transcode_gate_caps_parallel_ffmpeg(monkeypatch):
    from services.worker import tasks

    monkeypatch.setattr(tasks, "_TRANSCODE_GATE", asyncio.Semaphore(2))
    running = 0
    peak = 0

    async def fake_transcode() -> None:
        nonlocal running, peak
        async with tasks._transcode_gate():
            running += 1
            peak = max(peak, running)
            await asyncio.sleep(0.02)
            running -= 1

    await asyncio.gather(*(fake_transcode() for _ in range(6)))
    assert peak == 2
