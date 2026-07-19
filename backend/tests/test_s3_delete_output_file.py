"""Regression: clearing effects/style.txt must be able to drop the S3 orphan.

push_outputs only uploads existing files — without an explicit delete, a later
pull_outputs resurrects the previous run's style.txt (2026-07-18).
"""

from __future__ import annotations

import pytest

from packages.video import s3 as s3_mod


@pytest.mark.asyncio
async def test_delete_output_file_noop_when_s3_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(s3_mod, "_s3_enabled", lambda: False)
    # Must not raise / touch the network.
    await s3_mod.delete_output_file("proj", "effects/style.txt")


@pytest.mark.asyncio
async def test_delete_output_file_uses_outputs_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(s3_mod, "_s3_enabled", lambda: True)
    seen: list[str] = []

    def fake_delete(key: str) -> bool:
        seen.append(key)
        return True

    monkeypatch.setattr(s3_mod, "_sync_delete_object", fake_delete)
    await s3_mod.delete_output_file("abc", "effects/style.txt")
    assert seen == ["videos/abc/outputs/effects/style.txt"]
