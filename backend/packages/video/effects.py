"""AI-Assisted Effects Layer — data model for `effects.json`.

This is the per-project effect-placement document that sits ALONGSIDE the cut
files (`edit_script.json` / `timeline.json`) in a project's output dir. It never
overloads those formats: the cut files decide "which footage plays when", this
file decides "what effects sit on top / how the footage is transformed".

Two execution paths, split by `kind` (architecture decision, REMOTION_EFFECTS_
REQUIREMENTS.md §8 + follow-up):

- ``kind="overlay"``  — a Remotion component renders a transparent-background
  clip that ffmpeg later composites ON TOP of the cut video. The base footage is
  untouched. Stickers, popups, callouts, text-reveals, badges, shapes. The
  ``componentId`` maps to a Remotion registry entry (desktop node-sidecar); the
  spike proved this path end-to-end (transparent ProRes 4444 → ffmpeg overlay).

- ``kind="transform"`` — a pure-ffmpeg operation on the REAL footage pixels;
  there is no Remotion component and nothing to composite. Punch-zoom, pan,
  crop-reframe. These cannot be done via a transparent overlay because there is
  no source footage in an overlay to zoom into — the transform must act on the
  base clip itself. ``componentId`` maps to an ffmpeg transform (e.g.
  ``"punch-zoom"``) and ``props`` carries its ffmpeg params.

``props`` is an open, per-component parameter bag (color/scale/position/easing/…)
validated by the component registry, not this schema — mirrors how the dub edit
script keeps ``cutStyle``-specific detail loose. ``source`` records provenance
so the editor/AI can tell apart AI-generated, template-applied, and hand-placed
instances (e.g. a re-run AI pass should not stomp manual edits).
"""

from __future__ import annotations

import uuid
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

EFFECTS_DOC_VERSION = 1

EffectKind = Literal["overlay", "transform"]
EffectSource = Literal["ai", "template", "manual"]


class EffectInstance(BaseModel):
    """One placed effect: a component + a time window + its params.

    Field names are camelCase to match the on-disk JSON shared with the
    TypeScript desktop/web clients (same convention as the dub edit script /
    edit timeline models in services/api/routers/videos.py).
    """

    id: str = Field(default_factory=lambda: f"eff_{uuid.uuid4().hex[:8]}")
    kind: EffectKind
    componentId: str
    startSec: float
    durationSec: float
    zOrder: int = 0
    props: dict[str, Any] = Field(default_factory=dict)
    source: EffectSource = "ai"
    # Present only when componentId == "generated" (custom AI-authored
    # component, REMOTION_EFFECTS_REQUIREMENTS.md §6 extension). Untrusted
    # source text — the desktop's codegenValidate.mjs re-validates it before
    # ever bundling/executing, this field is just storage/transport.
    componentSource: str | None = None

    model_config = {"populate_by_name": True}

    @field_validator("startSec")
    @classmethod
    def _start_non_negative(cls, v: float) -> float:
        return max(0.0, float(v))

    @field_validator("durationSec")
    @classmethod
    def _duration_positive(cls, v: float) -> float:
        # A zero/negative window would render nothing (overlay) or be a no-op
        # ffmpeg enable range (transform); clamp to a tiny positive floor so
        # downstream render code never has to special-case it.
        return max(0.01, float(v))

    @property
    def endSec(self) -> float:
        return self.startSec + self.durationSec


class EffectsDoc(BaseModel):
    """Top-level `effects.json` document for one project."""

    version: int = EFFECTS_DOC_VERSION
    instances: list[EffectInstance] = Field(default_factory=list)

    model_config = {"populate_by_name": True}

    def overlays(self) -> list[EffectInstance]:
        """Instances rendered by Remotion + composited by ffmpeg (kind=overlay)."""
        return [i for i in self.instances if i.kind == "overlay"]

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
# the effects placement pass (phase: AI). `props` is deliberately an untyped
# object here — per-component validation happens in the registry, and Gemini's
# schema enforcement does not need to police component-specific params.
EFFECTS_PLACEMENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        # Re-added 2026-07-17 as a NEW, DELIBERATELY NAMED field (never
        # "instances" — that name is retired for good, see the note it used
        # to carry: a field the model CAN fill eventually gets filled no
        # matter the prose, so the OLD ambiguous "instances vs customEffects"
        # split is never coming back). `catalogPlacements` is unambiguous:
        # it is the ONLY field for picking a component off the fixed shelf
        # (packages/video/effects_catalog.py — mirrors registry.ts). Preferred
        # over `customEffects` whenever the catalog covers the need — it is
        # instant (no codegen call) and uses pre-tested, trusted components.
        "catalogPlacements": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "componentId": {"type": "string"},
                    # additionalProperties=true is REQUIRED, not decorative: an
                    # "object" with no "properties" and no additionalProperties
                    # flag renders as a closed/empty object under Gemini's
                    # strict response_schema enforcement — confirmed live
                    # (2026-07-18): every catalogPlacements item came back as
                    # literal "props": {} even with a fully-reasoned plan in
                    # the thinking trace. This flag is what actually lets the
                    # model attach arbitrary per-component keys.
                    "props": {"type": "object", "additionalProperties": True},
                    "startSec": {"type": "number"},
                    "durationSec": {"type": "number"},
                },
                "required": ["componentId", "props", "startSec", "durationSec"],
            },
        },
        # Bespoke-effect briefs — the model's second, unconstrained way to add
        # effects (no count cap): a follow-up codegen call turns each brief
        # into a real (validated) Remotion component. Required (not optional)
        # because Gemini structured output reliably drops optional fields; an
        # empty array is a valid answer for a clip that only needs zoom punches.
        "customEffects": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "brief": {"type": "string"},
                    "startSec": {"type": "number"},
                    "durationSec": {"type": "number"},
                },
                "required": ["brief", "startSec", "durationSec"],
            },
        },
        # Rapid punch-zooms (the TikTok-pacing device) — pure NUMBERS applied
        # directly to the real footage by ffmpeg (packages/video/transforms.py),
        # never a generated component: no codegen call per zoom, so the model
        # can call for as many quick zoom moments as the clip's pacing wants
        # without adding cost per zoom. Required for the same reason as
        # customEffects; an empty array is valid for a clip that doesn't need any.
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
                    # docstring). Required by Gemini's structured-output
                    # (optional fields get dropped in practice — see the
                    # "instances" field retirement note above), but the model
                    # is told explicitly it may set both equal to
                    # focusX/focusY for a plain static hold, which is the
                    # common case.
                    "driftX": {"type": "number"},
                    "driftY": {"type": "number"},
                },
                "required": [
                    "startSec", "durationSec", "focusX", "focusY", "focusOn", "zoomTo",
                    "style", "rampSec", "driftX", "driftY",
                ],
            },
        },
        # Scene-cut TRANSITIONS (2026-07-18) — a whip-pan sweep straddling one
        # real cut instant, pure numbers applied to the real footage by ffmpeg
        # (packages/video/transforms.py "whip-pan"), same no-codegen-cost
        # reasoning as zoomPunches. Only ever placed AT a real cut boundary
        # (see <cuts> in the prompt) — rare and optional, never one per cut.
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
        # for footage that's just handheld-drifting the whole shot rather
        # than highlighting one specific detail — pure numbers, ffmpeg
        # (packages/video/transforms.py "scene-drift"). Distinct from
        # zoomPunches: no target detail, no hold plateau, spans the WHOLE
        # scene not a beat. Only meaningful (and only requested) when <cuts>
        # is given — without real scene boundaries there's nothing to span.
        "sceneDrifts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "startSec": {"type": "number"},
                    "durationSec": {"type": "number"},
                    "zoomTo": {"type": "number"},
                    "direction": {"type": "string", "enum": ["in", "left", "right", "up", "down"]},
                },
                "required": ["startSec", "durationSec", "zoomTo", "direction"],
            },
        },
    },
    "required": [
        "catalogPlacements", "customEffects", "zoomPunches", "transitions", "sceneDrifts",
    ],
}
