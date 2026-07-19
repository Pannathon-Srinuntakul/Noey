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
        "componentId": "callout",
        "kind": "overlay",
        "title": "ป้ายชี้จุด (บอลลูน+เส้นลาก)",
        "guidance": "Label bubble with a drawn-on arrow pointing at a spot — tutorials, "
        "\"look here\", naming a product detail. Replaces the old bare badge/shape combo.",
        "props": {
            "label": "string — SHORT phrase, Thai ok",
            "x": "0..1 — the point being pointed AT (not the bubble)",
            "y": "0..1 — the point being pointed AT",
            "position": "'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' — which "
            "quadrant the bubble sits in relative to the point",
            "offset": "40..400 — bubble distance from the point in px on a 1080-wide frame",
            "fontSize": "16..100 — text size",
            "color": "color hex — text color",
            "bgColor": "color hex — bubble fill",
            "arrowColor": "color hex — line + anchor dot color",
        },
    },
    {
        "componentId": "text-neon",
        "kind": "overlay",
        "title": "ข้อความนีออน",
        "guidance": "Glowing neon-sign text pop-in — hooks, price drops, energetic one-liners.",
        "props": {
            "text": "string — SHORT punchy phrase, 2-4 Thai words max",
            "color": "color hex — text color",
            "glowColor": "color hex — glow color",
            "x": "0..1 — center X",
            "y": "0..1 — center Y",
            "fontSize": "12..320 — text size",
        },
    },
    {
        "componentId": "text-glitch",
        "kind": "overlay",
        "title": "ข้อความกลิตช์",
        "guidance": "RGB-split glitch text pop-in — tech/edgy hooks, before-reveal tension.",
        "props": {
            "text": "string — SHORT phrase",
            "color": "color hex",
            "x": "0..1 — center X",
            "y": "0..1 — center Y",
            "fontSize": "12..320 — text size",
            "intensity": "0..1 — glitch strength",
        },
    },
    {
        "componentId": "text-typewriter",
        "kind": "overlay",
        "title": "ข้อความพิมพ์ดีด",
        "guidance": "Character-by-character typewriter reveal — narration-style captions, "
        "step-by-step explanations.",
        "props": {
            "text": "string — phrase (typing takes time, keep it short)",
            "color": "color hex",
            "x": "0..1 — center X",
            "y": "0..1 — center Y",
            "fontSize": "12..320 — text size",
            "caret": "'true' | 'false' — blinking cursor",
        },
    },
    {
        "componentId": "text-shimmer",
        "kind": "overlay",
        "title": "ข้อความไล่สีวิ้ง",
        "guidance": "Gradient shimmer sweep across text — premium/luxury feel, brand names.",
        "props": {
            "text": "string — SHORT phrase",
            "colorA": "color hex — gradient start",
            "colorB": "color hex — gradient end",
            "x": "0..1 — center X",
            "y": "0..1 — center Y",
            "fontSize": "12..320 — text size",
        },
    },
    {
        "componentId": "price-counter",
        "kind": "overlay",
        "title": "ตัวเลขนับ (ราคา)",
        "guidance": "Number counts up/down from A to B — price reveals, follower/sales counts.",
        "props": {
            "from": "0..9999999 — start value",
            "to": "0..9999999 — end value",
            "prefix": "string — e.g. '฿'",
            "suffix": "string — e.g. '+'",
            "color": "color hex",
            "x": "0..1 — center X",
            "y": "0..1 — center Y",
            "fontSize": "12..320 — text size",
        },
    },
    {
        "componentId": "tiktok-text-box",
        "kind": "overlay",
        "title": "กล่องข้อความ TikTok",
        "guidance": "The TikTok-style rounded solid-fill text pill (multiline). Classic "
        "on-screen caption look. Keep text SHORT (about 4–8 Thai words) so the "
        "pill stays readable — long lines overflow the box.",
        "props": {
            "text": "string — short punchy phrase (prefer ≤8 Thai words)",
            "bg": "color hex — box fill",
            "color": "color hex — text color",
            "x": "0..1 — center X",
            "y": "0..1 — center Y",
            "fontSize": "12..200 — text size (at 1080 width; ~36-56 typical)",
            "align": "'left' | 'center' | 'right' — prefer 'center' unless layout needs otherwise",
        },
    },
    {
        "componentId": "particle-burst",
        "kind": "overlay",
        "title": "อนุภาค (คอนเฟตติ/ประกาย/หัวใจ/กลีบดอก/ฟองสบู่/ควัน)",
        "guidance": "Particles bursting from a point or falling/rising across the frame — "
        "celebration beats, reveals, ambient texture.",
        "props": {
            "kind": "'confetti' | 'sparkle' | 'heart' | 'petal' | 'bubble' | 'smoke' — particle look",
            "mode": "'burst' | 'fall' | 'rise' — trajectory",
            "x": "0..1 — origin X (ignored in 'fall')",
            "y": "0..1 — origin Y (ignored in 'fall')",
            "count": "1..180 — particle count",
            "colorA": "color hex",
            "colorB": "color hex",
            "size": "4..80 — particle size",
        },
    },
    {
        "componentId": "vibe-wash",
        "kind": "overlay",
        "title": "ฟิล์มกรน/VHS/ขอบมืด/สีเหลื่อม/แสงออโรร่า/โบเก้",
        "guidance": "Full-frame semi-transparent mood wash. Use sparingly — one beat, not "
        "every moment.",
        "props": {
            "kind": "'grain' | 'vhs' | 'vignette' | 'chromatic' | 'aurora' | 'bokeh' — wash style",
            "intensity": "0..1 — keep subtle (~0.4-0.6)",
            "tint": "color hex",
        },
    },
    {
        "componentId": "text-scramble",
        "kind": "overlay",
        "title": "ข้อความถอดรหัส",
        "guidance": "Characters scramble/decode into the final text — hacker/reveal-code vibe.",
        "props": {
            "text": "string — SHORT phrase",
            "color": "color hex — while scrambling",
            "lockedColor": "color hex — once resolved",
            "x": "0..1 — center X",
            "y": "0..1 — center Y",
            "fontSize": "12..240 — text size",
        },
    },
    {
        "componentId": "text-wave",
        "kind": "overlay",
        "title": "ข้อความคลื่น",
        "guidance": "Per-character ripple/wave motion, holds while riding — playful, musical.",
        "props": {
            "text": "string — SHORT phrase",
            "color": "color hex",
            "x": "0..1 — center X",
            "y": "0..1 — center Y",
            "fontSize": "12..320 — text size",
        },
    },
    {
        "componentId": "text-mask-reveal",
        "kind": "overlay",
        "title": "ข้อความเผยทีละบรรทัด",
        "guidance": "Clip-path wipe reveal per line — clean, editorial, calm reveals.",
        "props": {
            "text": "string — can wrap to multiple lines",
            "color": "color hex",
            "x": "0..1 — center X",
            "y": "0..1 — center Y",
            "fontSize": "12..320 — text size",
        },
    },
    {
        "componentId": "text-explode",
        "kind": "overlay",
        "title": "ข้อความระเบิด",
        "guidance": "Characters scatter outward then resolve into the text, local flash — "
        "high-energy hooks, big reveals.",
        "props": {
            "text": "string — SHORT phrase",
            "color": "color hex",
            "x": "0..1 — center X",
            "y": "0..1 — center Y",
            "fontSize": "12..320 — text size",
        },
    },
    {
        "componentId": "matrix-rain",
        "kind": "overlay",
        "title": "ฝนโค้ด Matrix",
        "guidance": "Full-frame falling-code wash. Tech/hacker mood beat — use sparingly.",
        "props": {
            "color": "color hex",
            "intensity": "0..1 — keep subtle (~0.4-0.6)",
        },
    },
    {
        "componentId": "animated-emoji",
        "kind": "overlay",
        "title": "อีโมจิเคลื่อนไหว",
        "guidance": "A real animated (video-based) emoji sticker — reactions, emphasis beats.",
        "props": {
            "emoji": "enum — one of the curated animated emoji names",
            "x": "0..1 — center X",
            "y": "0..1 — center Y",
            "size": "60..700 — sticker size",
        },
    },
    {
        "componentId": "shape-kit",
        "kind": "overlay",
        "title": "รูปทรง (วงแหวน/คลื่นน้ำ/หมุน/มอร์ฟ/มันดาลา)",
        "guidance": "Decorative geometric motif — accent, not a pointer (use `callout` to "
        "point at something specific).",
        "props": {
            "kind": "'progress-ring' | 'ripple' | 'spinning-rings' | 'morph-blob' | 'mandala'",
            "x": "0..1 — center X",
            "y": "0..1 — center Y",
            "size": "60..800 — footprint diameter",
            "color": "color hex",
            "colorB": "color hex — secondary",
            "percent": "0..100 — only used by 'progress-ring'",
        },
    },
    {
        "componentId": "liquid-kit",
        "kind": "overlay",
        "title": "ของเหลว (บลอบ/หมุนวน/กระเซ็น)",
        "guidance": "Organic liquid-motion accent shape.",
        "props": {
            "kind": "'blob' | 'swirl' | 'splatter'",
            "x": "0..1 — center X",
            "y": "0..1 — center Y",
            "size": "60..800 — footprint diameter",
            "color": "color hex",
            "colorB": "color hex — secondary",
        },
    },
    {
        "componentId": "roller-text",
        "kind": "overlay",
        "title": "ตัวเลข/คำหมุน (นับถอยหลัง/สล็อต/ป้ายพลิก)",
        "guidance": "Cycles through a list of items and settles on the last — countdowns, "
        "feature lists rolling by, airport-board reveals.",
        "props": {
            "kind": "'countdown' | 'slot' | 'split-flap'",
            "words": "string — pipe-separated items, LAST one is the settle target, "
            "e.g. '5|4|3|2|1|GO'",
            "x": "0..1 — center X",
            "y": "0..1 — center Y",
            "fontSize": "20..260 — text size",
            "color": "color hex — while cycling",
            "accentColor": "color hex — once settled",
        },
    },
    {
        "componentId": "cinematic-grade",
        "kind": "overlay",
        "title": "เกรดสีหนัง (นัวร์/ไซไฟ/สยองขวัญ/วินเทจ/มหากาพย์)",
        "guidance": "Full-frame genre color-grade wash (tint+vignette+grain). One mood beat, "
        "not the whole clip.",
        "props": {
            "kind": "'noir' | 'sci-fi' | 'horror' | 'vintage' | 'epic'",
            "intensity": "0..1 — keep moderate (~0.4-0.6)",
        },
    },
    {
        "componentId": "logo-reveal",
        "kind": "overlay",
        "title": "เผยโลโก้/รูปภาพ (มาสก์/กลิตช์/อนุภาค/ปั๊มตรา/เรืองแสง/หมุน 3 มิติ)",
        "guidance": "Animates a user-uploaded image/logo. The image asset itself is chosen "
        "in the editor, not by you — you only pick the motion kind + place/time it.",
        "props": {
            "kind": "'mask-reveal' | 'glitch' | 'particles' | 'stamp' | 'neon-glow' | '3d-rotate'",
            "x": "0..1 — center X",
            "y": "0..1 — center Y",
            "size": "60..800 — footprint",
            "glowColor": "color hex — used by 'particles'/'neon-glow'",
        },
    },
    {
        "componentId": "price-swap",
        "kind": "overlay",
        "title": "ราคาลด (ขีดฆ่า/สลับ)",
        "guidance": "Old price strikes through and fades, new price slides in — discount/"
        "price-drop reveals. Very high affiliate value.",
        "props": {
            "from": "string — old price, e.g. '฿999'",
            "to": "string — new price, e.g. '฿499'",
            "x": "0..1 — center X",
            "y": "0..1 — center Y",
            "fontSize": "20..240 — text size",
            "color": "color hex",
            "lineColor": "color hex — strike line",
        },
    },
    {
        "componentId": "marker-highlight",
        "kind": "overlay",
        "title": "ปากกาเน้นข้อความ",
        "guidance": "A highlighter-marker stroke sweeps in behind ONE phrase inside a "
        "sentence — emphasize the part that matters.",
        "props": {
            "before": "string — text before the highlighted phrase (may be empty)",
            "highlight": "string — the emphasized phrase",
            "after": "string — text after (may be empty)",
            "x": "0..1 — center X",
            "y": "0..1 — center Y",
            "fontSize": "20..200 — text size",
            "color": "color hex — normal text",
            "markerColor": "color hex — highlighter stroke",
            "highlightedTextColor": "color hex — text color once highlighted",
        },
    },
    {
        "componentId": "stat-chart",
        "kind": "overlay",
        "title": "กราฟสถิติ (แท่ง/เส้น)",
        "guidance": "Animated bar or line chart — sales growth, before/after stats.",
        "props": {
            "kind": "'bar' | 'line'",
            "data": "string — pipe-separated numbers, e.g. '35|60|45|80'",
            "labels": "string — optional pipe-separated labels (bar only), same count as data",
            "x": "0..1 — center X",
            "y": "0..1 — center Y",
            "size": "200..1000 — footprint",
            "color": "color hex",
        },
    },
    {
        "componentId": "marquee-text",
        "kind": "overlay",
        "title": "ข้อความวิ่ง (ตัวหนังสือไหล)",
        "guidance": "Infinite scrolling ticker banner — feature/benefit list running across "
        "the frame edge.",
        "props": {
            "text": "string — repeats seamlessly, include a separator like ' · '",
            "y": "0..1 — vertical position",
            "fontSize": "16..160 — text size",
            "color": "color hex",
            "direction": "'left' | 'right'",
            "speed": "1..12 — scroll speed",
        },
    },
    {
        "componentId": "quote-card",
        "kind": "overlay",
        "title": "คำรีวิวลูกค้า",
        "guidance": "Testimonial reveal: quote cascades in word-by-word, then author+role — "
        "social-proof moments.",
        "props": {
            "quote": "string — the review text",
            "author": "string — e.g. '@handle'",
            "role": "string — e.g. 'ลูกค้าจริง'",
            "x": "0..1 — center X",
            "y": "0..1 — center Y",
            "fontSize": "24..140 — quote text size",
            "color": "color hex",
            "accentColor": "color hex — divider line",
        },
    },
    {
        "componentId": "stat-card",
        "kind": "overlay",
        "title": "สถิติเด่น (ตัวเลข+ป้ายกำกับ)",
        "guidance": "A big count-up number with a label and underline reveal — hero-stat "
        "flex moments ('1,200+ orders sold').",
        "props": {
            "value": "0..999999999 — end value",
            "label": "string — what the number represents",
            "prefix": "string",
            "suffix": "string — e.g. '+'",
            "x": "0..1 — center X",
            "y": "0..1 — center Y",
            "fontSize": "30..240 — number size",
            "color": "color hex — number",
            "labelColor": "color hex",
            "accentColor": "color hex — underline",
        },
    },
    {
        "componentId": "feature-list",
        "kind": "overlay",
        "title": "รายการจุดเด่น (bullet list)",
        "guidance": "Staggered glow-dot bullet list — '3 reasons to buy' style lists.",
        "props": {
            "items": "string — pipe-separated list items, e.g. 'ส่งฟรี|ของแท้ 100%|คืนเงินได้'",
            "x": "0..1 — center X",
            "y": "0..1 — center Y",
            "fontSize": "20..100 — text size",
            "color": "color hex",
            "accentColor": "color hex — dots",
        },
    },
    {
        "componentId": "spotlight-callout",
        "kind": "overlay",
        "title": "วงเน้นจุดสำคัญ + ป้ายคำอธิบาย",
        "guidance": "Dims the WHOLE frame except a rectangular region of the REAL footage, "
        "rings it, labels it — 'look at THIS specific part of the product'.",
        "props": {
            "targetX": "0..1 — target rect left edge",
            "targetY": "0..1 — target rect top edge",
            "targetW": "0.05..1 — target rect width",
            "targetH": "0.05..1 — target rect height",
            "label": "string — SHORT phrase",
            "accentColor": "color hex — ring color",
            "dimOpacity": "0..0.9 — how dark the surrounding area gets",
        },
    },
    {
        "componentId": "plain-caption",
        "kind": "overlay",
        "title": "ข้อความรีวิวเรียบๆ (ขาวขอบดำ)",
        "guidance": "The LEAST decorated text component — bold text, dark outline, no "
        "background, no glow/glitch/shimmer, simple fade+settle in and out. Use this as "
        "the DEFAULT for product-review/demo captions (one per feature beat) — see "
        "<context> in the system prompt. Deliberately stays out of the footage's way.",
        "props": {
            "text": "string — can be multi-word/short sentence",
            "x": "0..1 — center X",
            "y": "0..1 — center Y",
            "fontSize": "24..160 — text size",
            "color": "color hex — text fill (white is the classic choice)",
            "outlineColor": "color hex — outline (black is the classic choice)",
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

# Thai display font choices — mirrors desktop/node-sidecar/src/compositions/
# fonts.ts THAI_FONTS exactly (id + one-line mood note). Injected into every
# catalog component that has a real `fontFamily` prop (below) AND rendered as
# its own <fonts> guide block in the placement prompt (effects_ai.py) so the
# model picks a font per MOMENT, not just reaches for the alphabetically-first
# option every time.
THAI_FONT_GUIDE: list[tuple[str, str]] = [
    ("kanit", "bold geometric — confident, modern, general-purpose hook/price text"),
    ("prompt", "rounded friendly — approachable everyday commentary"),
    ("chonburi", "loud display serif-loop — big opening hooks, high-impact single words"),
    ("mitr", "soft rounded modern — calm, warm, product description"),
    ("itim", "handwritten casual — playful reactions, cute/fun asides"),
    ("taviraj", "elegant serif — quotes, reviews, premium/editorial feel"),
    ("sriracha", "script/personal-note — intimate, diary-style asides"),
]

_FONT_PROP_DESC = "enum — " + " | ".join(f"'{fid}' ({mood.split(' — ')[0]})" for fid, mood in THAI_FONT_GUIDE)

# Components with a real `fontFamily` prop (mirrors registry.ts — every text-*
# component + the text-bearing card/banner ones). Injected here instead of
# repeated 18 times in the literal above.
_FONT_AWARE_COMPONENTS = {
    "text-neon", "text-glitch", "text-typewriter", "text-shimmer", "price-counter",
    "tiktok-text-box", "text-wave", "text-mask-reveal", "text-explode", "callout",
    "marker-highlight", "price-swap", "roller-text", "marquee-text", "quote-card",
    "stat-card", "feature-list", "spotlight-callout", "plain-caption",
}
for _entry in _OVERLAY_CATALOG:
    if _entry["componentId"] in _FONT_AWARE_COMPONENTS:
        _entry["props"]["fontFamily"] = _FONT_PROP_DESC


def _transform_catalog() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    _GUIDANCE = {
        "punch-zoom": (
            "Push/cut-zoom the REAL footage onto a named product detail "
            "(focusX/focusY = that detail's on-screen position — almost never "
            "dead center 0.5/0.5 for standing product shots)."
        ),
        "whip-pan": "Applied to the real footage (zoom/reframe), not an overlay.",
        "scene-drift": "Applied to the real footage (zoom/reframe), not an overlay.",
    }
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
                "guidance": _GUIDANCE.get(
                    component_id, "Applied to the real footage (zoom/reframe), not an overlay."
                ),
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
# name (observed: sticker-badge's "label" written as "text"/"title" — pattern
# kept for callout, its spiritual successor). Renamed BEFORE filtering, per
# componentId — a generic global map would be wrong here since e.g. text-neon's
# real key genuinely IS "text".
_PROP_KEY_ALIASES: dict[str, dict[str, str]] = {
    "callout": {"text": "label", "title": "label", "message": "label"},
    # observed repeatedly across live calls: the model reaches for the generic
    # word "scale" instead of the catalog's actual zoomTo/zoomFrom names.
    "punch-zoom": {"scale": "zoomTo", "zoom": "zoomTo"},
}


# Hard numeric bounds per component prop — the server-side half of frame
# safety. The prompt asks for sane values; this guarantees them even when the
# model ignores it. Positions are clamped tighter than 0..1 so a center anchor
# can never sit ON the frame edge. Only props actually at risk of pushing an
# element off-frame or into a broken range are listed — not every numeric
# prop needs a bound (e.g. a `speed` or `count` prop degrades gracefully at
# any value the schema itself allows).
_POS = (0.03, 0.97)
_NUMERIC_BOUNDS: dict[str, dict[str, tuple[float, float]]] = {
    "callout": {"x": _POS, "y": _POS, "fontSize": (16, 100), "offset": (40, 400)},
    "text-neon": {"x": _POS, "y": _POS, "fontSize": (12, 320)},
    "text-glitch": {"x": _POS, "y": _POS, "fontSize": (12, 320)},
    "text-typewriter": {"x": _POS, "y": _POS, "fontSize": (12, 320)},
    "text-shimmer": {"x": _POS, "y": _POS, "fontSize": (12, 320)},
    "price-counter": {"x": _POS, "y": _POS, "fontSize": (12, 320)},
    "tiktok-text-box": {"x": _POS, "y": _POS, "fontSize": (12, 200)},
    "particle-burst": {"x": _POS, "y": _POS, "count": (1, 180), "size": (4, 80)},
    "vibe-wash": {"intensity": (0, 1)},
    "text-scramble": {"x": _POS, "y": _POS, "fontSize": (12, 240)},
    "text-wave": {"x": _POS, "y": _POS, "fontSize": (12, 320)},
    "text-mask-reveal": {"x": _POS, "y": _POS, "fontSize": (12, 320)},
    "text-explode": {"x": _POS, "y": _POS, "fontSize": (12, 320)},
    "matrix-rain": {"intensity": (0, 1)},
    "animated-emoji": {"x": _POS, "y": _POS, "size": (60, 700)},
    "shape-kit": {"x": _POS, "y": _POS, "size": (60, 800), "percent": (0, 100)},
    "liquid-kit": {"x": _POS, "y": _POS, "size": (60, 800)},
    "roller-text": {"x": _POS, "y": _POS, "fontSize": (20, 260)},
    "cinematic-grade": {"intensity": (0, 1)},
    "logo-reveal": {"x": _POS, "y": _POS, "size": (60, 800)},
    "price-swap": {"x": _POS, "y": _POS, "fontSize": (20, 240)},
    "marker-highlight": {"x": _POS, "y": _POS, "fontSize": (20, 200)},
    "stat-chart": {"x": _POS, "y": _POS, "size": (200, 1000)},
    "marquee-text": {"y": _POS, "fontSize": (16, 160), "speed": (1, 12)},
    "quote-card": {"x": _POS, "y": _POS, "fontSize": (24, 140)},
    "stat-card": {"x": _POS, "y": _POS, "fontSize": (30, 240)},
    "feature-list": {"x": _POS, "y": _POS, "fontSize": (20, 100)},
    "spotlight-callout": {
        "targetX": (0, 1),
        "targetY": (0, 1),
        "targetW": (0.05, 1),
        "targetH": (0.05, 1),
        "dimOpacity": (0, 0.9),
    },
    "plain-caption": {"x": _POS, "y": _POS, "fontSize": (24, 160)},
    "lottie-sticker": {"x": _POS, "y": _POS, "size": (40, 900)},
    "image-sticker": {"x": _POS, "y": _POS, "size": (40, 900)},
    "punch-zoom": {"zoomTo": (1, 4), "focusX": _POS, "focusY": _POS, "rampSec": (0.05, 5)},
}

# Max text lengths — a text overlay is a punchline, not a paragraph; anything
# longer degrades into subtitle-sized soup even with auto-fit.
_TEXT_LIMITS: dict[str, dict[str, int]] = {
    "callout": {"label": 24},
    "text-neon": {"text": 28},
    "text-glitch": {"text": 28},
    "text-typewriter": {"text": 40},
    "text-shimmer": {"text": 28},
    "tiktok-text-box": {"text": 60},
    "text-scramble": {"text": 24},
    "text-wave": {"text": 24},
    "text-mask-reveal": {"text": 60},
    "text-explode": {"text": 20},
    "price-swap": {"from": 12, "to": 12},
    # "highlight" listed first — it's the one prop that can't legitimately be
    # empty (before/after are optional lead-in/trail-off text); dict order
    # matters here, missing_required_content_key() checks the first key only.
    "marker-highlight": {"highlight": 20, "before": 30, "after": 30},
    "roller-text": {"words": 60},
    "marquee-text": {"text": 80},
    "quote-card": {"quote": 90, "author": 24, "role": 24},
    "stat-card": {"label": 30},
    "feature-list": {"items": 140},
    "spotlight-callout": {"label": 24},
    "plain-caption": {"text": 60},
}


def normalize_props_for_component(component_id: str, props: dict[str, Any]) -> dict[str, Any]:
    """Rename known key synonyms, drop any key the component doesn't declare,
    clamp numeric props into hard bounds, and truncate over-long text — so a
    render never receives a prop it can't use (e.g. lottie-sticker's invented
    "url", or callout's "text" instead of "label") nor a value that
    pushes the element off-frame.

    The key-normalization is the actual fix, not a safety net: Remotion falls
    back to a component's own defaultProps for MISSING keys, but a WRONG key
    (like "text" when the component reads "label") is simply never read —
    silently rendering the default placeholder instead of the AI's real
    content. The clamps are the safety net: prompt rules ask for in-frame
    values, this guarantees them.
    """
    known = _prop_keys_by_component().get(component_id)
    if known is None:  # unknown component — caller already handles this case
        return props
    aliases = _PROP_KEY_ALIASES.get(component_id, {})
    renamed = {aliases.get(k, k): v for k, v in props.items()}
    kept = {k: v for k, v in renamed.items() if k in known}

    bounds = _NUMERIC_BOUNDS.get(component_id, {})
    limits = _TEXT_LIMITS.get(component_id, {})
    out: dict[str, Any] = {}
    for k, v in kept.items():
        if k in bounds and isinstance(v, (int, float)) and not isinstance(v, bool):
            lo, hi = bounds[k]
            out[k] = min(max(float(v), lo), hi)
        elif k in limits and isinstance(v, str) and len(v) > limits[k]:
            out[k] = v[: limits[k]].rstrip()
        else:
            out[k] = v
    return out


def missing_required_content_key(component_id: str, props: dict[str, Any]) -> str | None:
    """Return the name of a primary-content prop (the text/label/quote/items
    key `_TEXT_LIMITS` tracks per component) if it is absent or blank, else
    None. Belt-and-suspenders for a real observed failure mode: the model
    picks the right catalog component at the right time but ships it with
    `props: {}` (or missing just the one prop that actually carries content),
    which renders the component's generic bundled default — bland text in the
    wrong place, looking unfinished and disconnected from the clip. That is
    worse than not placing the effect at all, so the caller drops it instead.
    Only checks the FIRST tracked key per component (the one that most
    directly represents "this component has nothing to say" when empty —
    e.g. text-neon's `text`, quote-card's `quote`); secondary keys like
    marker-highlight's `before`/`after` are legitimately optional.
    """
    limits = _TEXT_LIMITS.get(component_id)
    if not limits:
        return None
    key = next(iter(limits))
    value = props.get(key)
    if not isinstance(value, str) or not value.strip():
        return key
    return None


def catalog_prompt_text() -> str:
    """Render the catalog as a compact block for the AI system/user prompt."""
    lines: list[str] = []
    for c in component_catalog():
        lines.append(f"- {c['componentId']} (kind={c['kind']}) — {c['title']}: {c['guidance']}")
        for prop_name, desc in c["props"].items():
            lines.append(f"    • {prop_name}: {desc}")
    return "\n".join(lines)
