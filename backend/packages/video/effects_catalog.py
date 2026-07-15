"""Component catalog for the effects AI placement pass.

The AI placement call runs server-side (Python) but must emit effect instances
that reference REAL components with valid params. The implementations live in two
places by design (overlays = Remotion/TS in the desktop node-sidecar, transforms
= ffmpeg/Python here), so this module is the single Python-readable description
of the whole catalog — id, kind, human title, prop surface, and short usage
guidance — that gets injected into the AI prompt and used to validate/clamp the
model's output.

Transform entries are derived from TRANSFORM_REGISTRY (their true source of
truth). Overlay entries MIRROR desktop/node-sidecar/src/compositions/registry.ts
— keep the two in sync when adding an overlay component (there are only a
handful; a build-time generator can replace this hand-mirror later if the set
grows). test_effects_catalog.py guards the transform half against drift.
"""

from __future__ import annotations

from typing import Any

from packages.video.transforms import TRANSFORM_REGISTRY

# Overlay components — MIRROR of registry.ts OVERLAY_REGISTRY (componentId + prop
# names/types + a one-line "when to use" for the model). Kept minimal on purpose.
_OVERLAY_CATALOG: list[dict[str, Any]] = [
    {
        "componentId": "text-reveal",
        "kind": "overlay",
        "title": "ข้อความเด้ง",
        "guidance": "Big animated word/phrase popping in — hooks, price drops, one-liners.",
        "props": {
            "text": "string — the text to show (Thai ok)",
            "color": "color hex — text color",
            "x": "0..1 — horizontal position (left anchor)",
            "y": "0..1 — vertical position (top anchor)",
            "fontSize": "12..320 — text size",
        },
    },
    {
        "componentId": "sticker-badge",
        "kind": "overlay",
        "title": "สติกเกอร์ป้าย",
        "guidance": "Rounded pill badge with emoji + label — promos, callouts, tags.",
        "props": {
            "label": "string — badge text (Thai ok)",
            "emoji": "string — one leading emoji (may be empty)",
            "bg": "color hex — pill fill",
            "color": "color hex — text color",
            "x": "0..1 — center X",
            "y": "0..1 — center Y",
            "fontSize": "12..200 — text size",
            "anim": "'pop' | 'slide' — entry animation",
        },
    },
    {
        "componentId": "shape-highlight",
        "kind": "overlay",
        "title": "รูปทรงไฮไลต์",
        "guidance": "Animated vector shape (ring/star/heart/spark/arrow) popped onto a "
        "focal point to draw the eye to a product or detail.",
        "props": {
            "shape": "'circle' | 'star' | 'heart' | 'spark' | 'arrow' — which shape",
            "color": "color hex",
            "x": "0..1 — center X (put it ON the thing to highlight)",
            "y": "0..1 — center Y",
            "size": "40..800 — shape size",
            "filled": "'true' | 'false' — filled vs outline-only (ring)",
            "strokeWidth": "1..60 — outline thickness",
        },
    },
    {
        "componentId": "light-leak",
        "kind": "overlay",
        "title": "แสงเลนส์",
        "guidance": "Full-frame cinematic light-leak wash (screen blend). Use sparingly on "
        "an opening or a beat for a warm film feel — not on every moment.",
        "props": {
            "hueShift": "0..360 — recolor the leak",
            "seed": "0..999 — pick a different sweep",
            "opacity": "0..1 — keep subtle (~0.3)",
        },
    },
    {
        "componentId": "lottie-sticker",
        "kind": "overlay",
        "title": "สติกเกอร์ Lottie",
        "guidance": "Plays a Lottie animation asset (from the user's sticker library). "
        "The asset itself is chosen in the editor, not by you — you only place/time it.",
        "props": {
            "x": "0..1 — center X",
            "y": "0..1 — center Y",
            "size": "40..900 — sticker size",
            "loop": "'true' | 'false' — loop the animation",
        },
    },
    {
        "componentId": "image-sticker",
        "kind": "overlay",
        "title": "สติกเกอร์รูปภาพ",
        "guidance": "Shows a static image sticker (from the user's sticker library, PNG/GIF/"
        "WEBP). The asset itself is chosen in the editor, not by you — you only place/time it.",
        "props": {
            "x": "0..1 — center X",
            "y": "0..1 — center Y",
            "size": "40..900 — sticker size",
        },
    },
]


def _transform_catalog() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for component_id, entry in TRANSFORM_REGISTRY.items():
        props = {
            name: f"{spec.get('type')}"
            + (
                f" {spec['min']}..{spec['max']}"
                if spec.get("type") == "number"
                else (f" {spec.get('options')}" if spec.get("type") == "enum" else "")
            )
            + f" — {spec.get('label')}"
            for name, spec in entry["propSchema"].items()
        }
        out.append(
            {
                "componentId": component_id,
                "kind": "transform",
                "title": entry["title"],
                "guidance": "Applied to the real footage (zoom/reframe), not an overlay.",
                "props": props,
            }
        )
    return out


def component_catalog() -> list[dict[str, Any]]:
    """Full catalog (overlays + transforms) for prompt + validation."""
    return [*_OVERLAY_CATALOG, *_transform_catalog()]


def known_component_ids() -> set[str]:
    return {c["componentId"] for c in component_catalog()}


_component_prop_keys_cache: dict[str, set[str]] | None = None


def _prop_keys_by_component() -> dict[str, set[str]]:
    global _component_prop_keys_cache
    if _component_prop_keys_cache is None:
        _component_prop_keys_cache = {
            c["componentId"]: set(c["props"]) for c in component_catalog()
        }
    return _component_prop_keys_cache


# Prop-key synonyms the model reaches for despite the catalog listing the real
# name (observed: sticker-badge's "label" written as "text"/"title"). Renamed
# BEFORE filtering, per componentId — a generic global map would be wrong here
# since e.g. text-reveal's real key genuinely IS "text".
_PROP_KEY_ALIASES: dict[str, dict[str, str]] = {
    "sticker-badge": {"text": "label", "title": "label", "message": "label"},
    "text-reveal": {"label": "text", "message": "text"},
    # observed repeatedly across live calls: the model reaches for the generic
    # word "scale" instead of the catalog's actual zoomTo/zoomFrom names.
    "punch-zoom": {"scale": "zoomTo", "zoom": "zoomTo"},
}


def normalize_props_for_component(component_id: str, props: dict[str, Any]) -> dict[str, Any]:
    """Rename known key synonyms, then drop any key the component doesn't
    declare — so a render never receives a prop it can't use (e.g. lottie-
    sticker's invented "url", or sticker-badge's "text" instead of "label").

    This is the actual fix, not a safety net: Remotion falls back to a
    component's own defaultProps for MISSING keys, but a WRONG key (like
    "text" when the component reads "label") is simply never read — silently
    rendering the default placeholder instead of the AI's real content. This
    function makes sure the right key is used in the first place.
    """
    known = _prop_keys_by_component().get(component_id)
    if known is None:  # unknown component — caller already handles this case
        return props
    aliases = _PROP_KEY_ALIASES.get(component_id, {})
    renamed = {aliases.get(k, k): v for k, v in props.items()}
    return {k: v for k, v in renamed.items() if k in known}


def catalog_prompt_text() -> str:
    """Render the catalog as a compact block for the AI system/user prompt."""
    lines: list[str] = []
    for c in component_catalog():
        lines.append(f"- {c['componentId']} (kind={c['kind']}) — {c['title']}: {c['guidance']}")
        for prop_name, desc in c["props"].items():
            lines.append(f"    • {prop_name}: {desc}")
    return "\n".join(lines)
