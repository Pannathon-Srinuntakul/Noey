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
        "instances": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": ["overlay", "transform"]},
                    "componentId": {"type": "string"},
                    "startSec": {"type": "number"},
                    "durationSec": {"type": "number"},
                    "zOrder": {"type": "integer"},
                    # The per-component param bag as a JSON *string*, parsed by
                    # normalize/sanitize. Gemini structured output returns an
                    # empty object for a schemaless `{"type":"object"}` prop
                    # (it needs declared sub-properties, which are per-component
                    # here) — a string field lets the model fill props freely.
                    "propsJson": {"type": "string"},
                    # Promoted OUT of propsJson to top-level, REQUIRED fields:
                    # Gemini's structured-output enforcement only reaches
                    # top-level schema properties, not keys nested inside a
                    # string blob — focusX/focusY kept getting silently dropped
                    # from propsJson even with an explicit prompt rule (observed
                    # repeatedly on live calls) because there was nothing at the
                    # schema level forcing them. Only meaningful for
                    # kind="transform" (punch-zoom); overlay instances get an
                    # ignored placeholder — _sanitize copies these into props.
                    "focusX": {"type": "number"},
                    "focusY": {"type": "number"},
                    "reason": {"type": "string"},
                },
                # propsJson/focusX/focusY REQUIRED: Gemini's structured output
                # reliably emits only required fields and drops optional ones,
                # so making a field optional is equivalent to it never coming
                # back reliably — forcing it is what actually gets it filled.
                "required": [
                    "kind", "componentId", "startSec", "durationSec",
                    "propsJson", "focusX", "focusY",
                ],
            },
        },
    },
    "required": ["instances"],
}
