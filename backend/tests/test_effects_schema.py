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


def test_placement_schema_shape() -> None:
    props = EFFECTS_PLACEMENT_SCHEMA["properties"]["instances"]["items"]
    # propsJson is required so Gemini reliably emits the param bag (it drops
    # optional fields); it is a JSON string parsed downstream.
    assert set(props["required"]) == {
        "kind", "componentId", "startSec", "durationSec", "propsJson", "focusX", "focusY",
    }
    assert props["properties"]["propsJson"]["type"] == "string"
    assert props["properties"]["kind"]["enum"] == ["overlay", "transform"]
