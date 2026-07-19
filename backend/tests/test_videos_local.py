"""Local-render (desktop) endpoints — schema validation + wiring coverage.

Endpoint DB flows are exercised by the desktop-app e2e smoke; here we lock the
request/response contracts and the worker task registration.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from services.api.routers.videos_local import (
    LOCAL_STATUSES,
    FrameManifestEntry,
    LocalClipMeta,
    LocalProjectIn,
    PlanDubIn,
)


def test_local_project_in_defaults() -> None:
    body = LocalProjectIn(clips=[{"id": "clip0", "durationSec": 12.5}])
    assert body.mode == "dub_first"
    assert body.target_duration_sec is None
    assert body.clips[0].fps == 30


def test_local_project_in_requires_clips() -> None:
    with pytest.raises(ValidationError):
        LocalProjectIn(clips=[])


def test_local_clip_meta_rejects_zero_duration() -> None:
    with pytest.raises(ValidationError):
        LocalClipMeta(id="clip0", durationSec=0)


def test_target_duration_bounds() -> None:
    with pytest.raises(ValidationError):
        LocalProjectIn(clips=[{"id": "c", "durationSec": 1}], target_duration_sec=10)
    with pytest.raises(ValidationError):
        LocalProjectIn(clips=[{"id": "c", "durationSec": 1}], target_duration_sec=601)
    ok = LocalProjectIn(clips=[{"id": "c", "durationSec": 1}], target_duration_sec=60)
    assert ok.target_duration_sec == 60


def test_frame_manifest_entry_scene_and_edge() -> None:
    scene = FrameManifestEntry(
        name="clip0_5.20.jpg", clip_id="clip0", time=5.2,
        scene_idx=3, scene_start=4.8, scene_end=7.1,
    )
    assert scene.edge is None
    edge = FrameManifestEntry(name="e.jpg", clip_id="clip1", time=0.0, edge="opening")
    assert edge.scene_idx == 0


def test_plan_dub_in_validation() -> None:
    with pytest.raises(ValidationError):
        PlanDubIn(voDurationSec=0, clipDurations=[10.0])
    with pytest.raises(ValidationError):
        PlanDubIn(voDurationSec=30.0, clipDurations=[])
    ok = PlanDubIn(voDurationSec=30.0, clipDurations=[10.0, 20.0])
    assert ok.voDurationSec == 30.0


def test_local_statuses_exclude_pending_and_cancelled() -> None:
    # pending is server-assigned at create; cancelled goes through /cancel.
    assert set(LOCAL_STATUSES) == {"processing", "waiting_vo", "done", "error"}


def test_analyze_dub_local_registered_in_worker() -> None:
    from services.worker.tasks import WorkerSettings, analyze_dub_local

    assert analyze_dub_local in WorkerSettings.functions


def test_router_registered_in_app_factory() -> None:
    # Import-level wiring: the router module must expose `router` with the /videos prefix.
    from services.api.routers import videos_local

    assert videos_local.router.prefix == "/videos"
    paths = {route.path for route in videos_local.router.routes}
    assert {"/videos/local", "/videos/{uid}/analyze-frames", "/videos/{uid}/plan-dub",
            "/videos/{uid}/local-status", "/videos/{uid}/local-edit-script",
            "/videos/{uid}/transcribe-audio", "/videos/{uid}/local-timeline"} <= paths


def test_local_project_in_accepts_talking_head() -> None:
    body = LocalProjectIn(mode="talking_head", clips=[{"id": "clip0", "durationSec": 30}])
    assert body.mode == "talking_head"


def test_global_codegen_route_registered() -> None:
    # Effects Studio (global library) codegen — no project uid; must not be
    # swallowed by the /{uid}/... parameterized routes.
    from services.api.routers import videos_local

    paths = {route.path for route in videos_local.router.routes}
    assert "/videos/effects/generate-component" in paths
    assert "/videos/{uid}/generate-effect-component" in paths
