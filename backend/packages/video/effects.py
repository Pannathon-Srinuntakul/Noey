"""AI-Assisted Effects Layer — data model for `effects.json`.

This is the per-project effect-placement document that sits ALONGSIDE the cut
files (`edit_script.json` / `timeline.json`) in a project's output dir. It never
overloads those formats: the cut files decide "which footage plays when", this
file decides "how the footage is transformed".

Every instance is ``kind="transform"``: a pure-ffmpeg operation on the REAL
footage pixels — punch-zoom, whip-pan, scene-drift (packages/video/
transforms.py). ``componentId`` names the transform and ``props`` carries its
ffmpeg params.

The overlay half (Remotion components rendering transparent clips that ffmpeg
composited on top — stickers, captions-as-graphics, particles, generated
components) was REMOVED 2026-08-12. ``kind`` is kept as a one-value Literal
rather than dropped so existing effects.json files still parse and so the
render/AI code keeps reading as "transforms only" instead of "everything".
Parked source: desktop/_removed/.

``props`` is an open, per-transform parameter bag validated by
packages/video/transforms.py, not this schema. ``source`` records provenance so
the editor/AI can tell apart AI-generated, template-applied and hand-placed
instances (e.g. a re-run AI pass should not stomp manual edits).
"""

from __future__ import annotations

import uuid
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

EFFECTS_DOC_VERSION = 1

EffectKind = Literal["transform"]
EffectSource = Literal["ai", "template", "manual"]


class EffectInstance(BaseModel):
    """One placed effect: a component + a time window + its params.

    Field names are camelCase to match the on-disk JSON shared with the
    TypeScript desktop/web clients (same convention as the dub edit script /
    edit timeline models in services/api/routers/videos.py).
    """

    id: str = Field(default_factory=lambda: f"eff_{uuid.uuid4().hex[:8]}")
    kind: EffectKind = "transform"
    componentId: str
    startSec: float
    durationSec: float
    zOrder: int = 0
    props: dict[str, Any] = Field(default_factory=dict)
    source: EffectSource = "ai"

    model_config = {"populate_by_name": True}

    @field_validator("startSec")
    @classmethod
    def _start_non_negative(cls, v: float) -> float:
        return max(0.0, float(v))

    @field_validator("durationSec")
    @classmethod
    def _duration_positive(cls, v: float) -> float:
        # A zero/negative window is a no-op ffmpeg enable range; clamp to a
        # tiny positive floor so downstream render code never special-cases it.
        return max(0.01, float(v))

    @property
    def endSec(self) -> float:
        return self.startSec + self.durationSec


class EffectsDoc(BaseModel):
    """Top-level `effects.json` document for one project."""

    version: int = EFFECTS_DOC_VERSION
    instances: list[EffectInstance] = Field(default_factory=list)

    model_config = {"populate_by_name": True}

    def transforms(self) -> list[EffectInstance]:
        """Instances applied directly to footage by ffmpeg (kind=transform)."""
        return [i for i in self.instances if i.kind == "transform"]


def empty_effects_doc() -> EffectsDoc:
    """A fresh, effect-free document (first open / project with no effects yet)."""
    return EffectsDoc()


def normalize_effects_doc(raw: dict[str, Any] | None) -> EffectsDoc:
    """Coerce arbitrary JSON (from disk OR an AI response) into a valid EffectsDoc.

    Tolerant on the way in — drops instances that fail validation rather than
    failing the whole document, so one bad AI-produced entry can't wipe a user's
    saved effects. Deterministic on the way out (stable sort by start time then
    z-order) so renders and diffs are reproducible.
    """
    if not raw:
        return empty_effects_doc()

    instances_raw = raw.get("instances") or []
    instances: list[EffectInstance] = []
    for entry in instances_raw:
        if not isinstance(entry, dict):
            continue
        try:
            instances.append(EffectInstance.model_validate(entry))
        except Exception:  # noqa: BLE001 — skip the bad instance, keep the rest
            continue

    instances.sort(key=lambda i: (i.startSec, i.zOrder))
    return EffectsDoc(version=int(raw.get("version", EFFECTS_DOC_VERSION)), instances=instances)


# ── AI structured-output schema (Gemini) ────────────────────────────────────
# Mirrors DUB_EDIT_SCHEMA_VIDEO in dub_ai.py: a strict response_schema so the
# model returns exactly this shape instead of inventing its own keys. Used by
# the effects placement pass (effects_ai.py).
#
# All three fields are pure NUMBERS handed to an ffmpeg transform — there is no
# per-item model call, so the model may ask for as many as the clip's pacing
# genuinely wants. Every field is REQUIRED (not optional): Gemini structured
# output reliably drops optional fields, and an empty array is a valid answer
# for a clip that wants none of that motion.
EFFECTS_PLACEMENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        # Focus zoom-holds on a specific detail (transforms.py "punch-zoom").
        "zoomPunches": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "startSec": {"type": "number"},
                    "durationSec": {"type": "number"},
                    "focusX": {"type": "number"},
                    "focusY": {"type": "number"},
                    # Short English label of WHAT is being focused (forces the
                    # model to pick a real product detail before coordinates —
                    # live report 2026-07-18: zooms clustered on 0.5/0.5).
                    # Not stored on the EffectInstance; placement-only.
                    "focusOn": {"type": "string"},
                    # Start framing. 1.0 (the common case) = the shot opens at
                    # normal size and pushes IN. >1.0 = the shot opens already
                    # tight and OPENS OUT to zoomTo — a reveal. Added 2026-08-12
                    # (R8 "ซูมออกช้า"): the filter always supported it
                    # (transforms.py ramps zoomFrom→zoomTo either direction) but
                    # the model had no way to ask for it.
                    "zoomFrom": {"type": "number"},
                    "zoomTo": {"type": "number"},
                    # "cut" = instant jump, no camera-move feel. "push" = an
                    # eased zoom-in with a real ramp. Required, not optional,
                    # so the model actively picks rather than defaulting to a
                    # transition every time.
                    "style": {"type": "string", "enum": ["cut", "push"]},
                    # How long the transition INTO the zoomed framing takes
                    # (seconds). Previously hardcoded (0.05 for cut, 0.4 cap
                    # for push) — the model had zero control, which produced
                    # pushes far snappier than real slow-push reference
                    # footage (observed 2026-07-18: reference clips show
                    # multi-second continuous pushes). Now model-controlled,
                    # clamped server-side in _zoom_ramp_sec.
                    "rampSec": {"type": "number"},
                    # OPTIONAL hold-drift target — the framing pans from
                    # focusX/focusY toward driftX/driftY across the hold
                    # (2026-07-18, see transforms.py punch_zoom_filter
                    # docstring). Required by Gemini's structured output
                    # (optional fields get dropped in practice), but the model
                    # is told explicitly it may set both equal to focusX/focusY
                    # for a plain static hold, which is the common case.
                    "driftX": {"type": "number"},
                    "driftY": {"type": "number"},
                },
                "required": [
                    "startSec", "durationSec", "focusX", "focusY", "focusOn",
                    "zoomFrom", "zoomTo", "style", "rampSec", "driftX", "driftY",
                ],
            },
        },
        # Scene-cut TRANSITIONS (2026-07-18) — a whip-pan sweep straddling one
        # real cut instant (transforms.py "whip-pan"). Only ever placed AT a
        # real cut boundary (see <cuts> in the prompt) — rare, never one per cut.
        "transitions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "cutSec": {"type": "number"},
                    "durationSec": {"type": "number"},
                    "direction": {"type": "string", "enum": ["horizontal", "vertical"]},
                    "intensity": {"type": "number"},
                },
                "required": ["cutSec", "durationSec", "direction", "intensity"],
            },
        },
        # AMBIENT scene drift (2026-07-18) — a continuous, gentle zoom/pan
        # across an ENTIRE scene span (one real cut to the next, via <cuts>),
        # for footage that is just handheld-drifting the whole shot rather than
        # highlighting one detail (transforms.py "scene-drift"). Distinct from
        # zoomPunches: no target detail, no hold plateau, spans the WHOLE scene.
        # Only meaningful (and only requested) when <cuts> is given.
        "sceneDrifts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "startSec": {"type": "number"},
                    "durationSec": {"type": "number"},
                    # Same both-directions freedom as zoomPunches (2026-08-12):
                    # zoomFrom > zoomTo is a slow OPEN-OUT across the scene.
                    "zoomFrom": {"type": "number"},
                    "zoomTo": {"type": "number"},
                    "direction": {"type": "string", "enum": ["in", "left", "right", "up", "down"]},
                },
                "required": ["startSec", "durationSec", "zoomFrom", "zoomTo", "direction"],
            },
        },
    },
    "required": ["zoomPunches", "transitions", "sceneDrifts"],
}
