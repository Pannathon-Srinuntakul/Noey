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
    inst = EffectInstance(componentId="punch-zoom", startSec=1.0, durationSec=2.0)
    assert inst.kind == "transform"  # the only kind left after the overlay half went
    assert inst.id.startswith("eff_")
    assert inst.source == "ai"
    assert inst.zOrder == 0
    assert inst.props == {}
    assert inst.endSec == 3.0


def test_start_and_duration_are_clamped() -> None:
    inst = EffectInstance(kind="transform", componentId="punch-zoom", startSec=-5.0, durationSec=0.0)
    assert inst.startSec == 0.0
    assert inst.durationSec == 0.01  # positive floor, never zero/negative


def test_transforms_returns_every_instance() -> None:
    doc = EffectsDoc(
        instances=[
            EffectInstance(kind="transform", componentId="whip-pan", startSec=0.0, durationSec=1.0),
            EffectInstance(kind="transform", componentId="punch-zoom", startSec=1.0, durationSec=1.0),
        ]
    )
    assert [i.componentId for i in doc.transforms()] == ["whip-pan", "punch-zoom"]


def test_normalize_sorts_by_start_then_zorder() -> None:
    raw = {
        "version": 1,
        "instances": [
            {"kind": "transform", "componentId": "b", "startSec": 5.0, "durationSec": 1.0, "zOrder": 0},
            {"kind": "transform", "componentId": "a", "startSec": 1.0, "durationSec": 1.0, "zOrder": 2},
            {"kind": "transform", "componentId": "c", "startSec": 1.0, "durationSec": 1.0, "zOrder": 1},
        ],
    }
    doc = normalize_effects_doc(raw)
    assert [i.componentId for i in doc.instances] == ["c", "a", "b"]


def test_normalize_drops_bad_instances_keeps_good() -> None:
    raw = {
        "instances": [
            {"kind": "transform", "componentId": "ok", "startSec": 0.0, "durationSec": 1.0},
            {"kind": "not-a-kind", "componentId": "bad", "startSec": 0.0, "durationSec": 1.0},
            # A leftover overlay instance from a pre-2026-08-12 effects.json —
            # the kind no longer exists, so the doc loads without it instead
            # of failing to load at all.
            {"kind": "overlay", "componentId": "old-sticker", "startSec": 0.0, "durationSec": 1.0},
            "totally-not-an-object",
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
                kind="transform",
                componentId="punch-zoom",
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
    assert again.instances[0].componentId == "punch-zoom"
    assert again.instances[0].props == {"color": "#FFD400", "scale": 1.3}


def test_placement_schema_is_motion_only() -> None:
    # The overlay halves ("instances", then its replacements
    # "catalogPlacements"/"customEffects") are gone for good — a field the
    # model CAN fill eventually gets filled no matter what the prose says, so
    # the only reliable way to keep this pass motion-only is to make anything
    # else schema-impossible.
    props = EFFECTS_PLACEMENT_SCHEMA["properties"]
    for gone in ("instances", "catalogPlacements", "customEffects"):
        assert gone not in props
    assert set(EFFECTS_PLACEMENT_SCHEMA["required"]) == {
        "zoomPunches", "transitions", "sceneDrifts",
    }
    assert set(props) == {"zoomPunches", "transitions", "sceneDrifts"}


def test_placement_schema_motion_field_shapes() -> None:
    props = EFFECTS_PLACEMENT_SCHEMA["properties"]

    zoom = props["zoomPunches"]["items"]
    assert set(zoom["required"]) == {
        "startSec", "durationSec", "focusX", "focusY", "focusOn", "zoomFrom", "zoomTo",
        "style", "rampSec", "driftX", "driftY",
    }
    assert zoom["properties"]["style"]["enum"] == ["cut", "push"]

    transitions = props["transitions"]["items"]
    assert set(transitions["required"]) == {"cutSec", "durationSec", "direction", "intensity"}
    assert transitions["properties"]["direction"]["enum"] == ["horizontal", "vertical"]

    drifts = props["sceneDrifts"]["items"]
    assert set(drifts["required"]) == {
        "startSec", "durationSec", "zoomFrom", "zoomTo", "direction",
    }
    assert drifts["properties"]["direction"]["enum"] == ["in", "left", "right", "up", "down"]
