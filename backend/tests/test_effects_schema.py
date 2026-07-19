"""Tests for the effects-layer data model (packages/video/effects.py)."""

from __future__ import annotations

from packages.video.effects import (
    EFFECTS_DOC_VERSION,
    EFFECTS_PLACEMENT_SCHEMA,
    EffectInstance,
    EffectsDoc,
    empty_effects_doc,
    normalize_effects_doc,
)


def test_empty_doc_is_versioned_and_effect_free() -> None:
    doc = empty_effects_doc()
    assert doc.version == EFFECTS_DOC_VERSION
    assert doc.instances == []


def test_instance_defaults_id_and_source() -> None:
    inst = EffectInstance(kind="overlay", componentId="sticker-badge", startSec=1.0, durationSec=2.0)
    assert inst.id.startswith("eff_")
    assert inst.source == "ai"
    assert inst.zOrder == 0
    assert inst.props == {}
    assert inst.endSec == 3.0


def test_start_and_duration_are_clamped() -> None:
    inst = EffectInstance(kind="transform", componentId="punch-zoom", startSec=-5.0, durationSec=0.0)
    assert inst.startSec == 0.0
    assert inst.durationSec == 0.01  # positive floor, never zero/negative


def test_overlays_and_transforms_partition_by_kind() -> None:
    doc = EffectsDoc(
        instances=[
            EffectInstance(kind="overlay", componentId="popup", startSec=0.0, durationSec=1.0),
            EffectInstance(kind="transform", componentId="punch-zoom", startSec=1.0, durationSec=1.0),
            EffectInstance(kind="overlay", componentId="sticker", startSec=2.0, durationSec=1.0),
        ]
    )
    assert [i.componentId for i in doc.overlays()] == ["popup", "sticker"]
    assert [i.componentId for i in doc.transforms()] == ["punch-zoom"]


def test_normalize_sorts_by_start_then_zorder() -> None:
    raw = {
        "version": 1,
        "instances": [
            {"kind": "overlay", "componentId": "b", "startSec": 5.0, "durationSec": 1.0, "zOrder": 0},
            {"kind": "overlay", "componentId": "a", "startSec": 1.0, "durationSec": 1.0, "zOrder": 2},
            {"kind": "overlay", "componentId": "c", "startSec": 1.0, "durationSec": 1.0, "zOrder": 1},
        ],
    }
    doc = normalize_effects_doc(raw)
    assert [i.componentId for i in doc.instances] == ["c", "a", "b"]


def test_normalize_drops_bad_instances_keeps_good() -> None:
    raw = {
        "instances": [
            {"kind": "overlay", "componentId": "ok", "startSec": 0.0, "durationSec": 1.0},
            {"kind": "not-a-kind", "componentId": "bad", "startSec": 0.0, "durationSec": 1.0},
            "totally-not-an-object",
            {"componentId": "missing-kind", "startSec": 0.0, "durationSec": 1.0},
        ]
    }
    doc = normalize_effects_doc(raw)
    assert [i.componentId for i in doc.instances] == ["ok"]


def test_normalize_none_returns_empty() -> None:
    assert normalize_effects_doc(None).instances == []
    assert normalize_effects_doc({}).instances == []


def test_roundtrip_json_preserves_camelcase() -> None:
    doc = EffectsDoc(
        instances=[
            EffectInstance(
                kind="overlay",
                componentId="sticker-badge",
                startSec=2.4,
                durationSec=1.2,
                zOrder=3,
                props={"color": "#FFD400", "scale": 1.3},
                source="manual",
            )
        ]
    )
    dumped = doc.model_dump()
    entry = dumped["instances"][0]
    assert set(entry) >= {"componentId", "startSec", "durationSec", "zOrder", "props", "source"}
    # Re-normalizing the dumped form yields an equivalent doc.
    again = normalize_effects_doc(dumped)
    assert again.instances[0].componentId == "sticker-badge"
    assert again.instances[0].props == {"color": "#FFD400", "scale": 1.3}


def test_placement_schema_has_no_fixed_catalog_field() -> None:
    # "instances" (the old fixed-catalog-matching field) was removed outright
    # on 2026-07-17 — a prose "leave it empty" rule was proven not to work
    # (Gemini kept filling it instead of customEffects/zoomPunches on live
    # calls). Making it schema-impossible is the only fix that actually holds.
    assert "instances" not in EFFECTS_PLACEMENT_SCHEMA["properties"]


def test_placement_schema_has_custom_and_zoom_arrays() -> None:
    props = EFFECTS_PLACEMENT_SCHEMA["properties"]
    assert set(EFFECTS_PLACEMENT_SCHEMA["required"]) == {
        "catalogPlacements", "customEffects", "zoomPunches", "transitions", "sceneDrifts",
    }

    catalog = props["catalogPlacements"]["items"]
    assert set(catalog["required"]) == {"componentId", "props", "startSec", "durationSec"}

    custom = props["customEffects"]["items"]
    assert set(custom["required"]) == {"brief", "startSec", "durationSec"}

    zoom = props["zoomPunches"]["items"]
    assert set(zoom["required"]) == {
        "startSec", "durationSec", "focusX", "focusY", "focusOn", "zoomTo", "style",
        "rampSec", "driftX", "driftY",
    }
    assert zoom["properties"]["style"]["enum"] == ["cut", "push"]
    assert "focusOn" in zoom["properties"]

    transitions = props["transitions"]["items"]
    assert set(transitions["required"]) == {"cutSec", "durationSec", "direction", "intensity"}
    assert transitions["properties"]["direction"]["enum"] == ["horizontal", "vertical"]

    drifts = props["sceneDrifts"]["items"]
    assert set(drifts["required"]) == {"startSec", "durationSec", "zoomTo", "direction"}
    assert drifts["properties"]["direction"]["enum"] == ["in", "left", "right", "up", "down"]
