"""Tests for effects_codegen.py's pre-check (NOT the real security gate — that
is desktop/node-sidecar/src/codegenValidate.mjs; this is only a fast fail-early
filter, tested here for its own correctness)."""

from __future__ import annotations

from packages.video.effects_codegen import _build_user_text, _looks_safe


def test_looks_safe_accepts_clean_component() -> None:
    src = """
import React from 'react'
import { AbsoluteFill, useCurrentFrame } from 'remotion'
export const GeneratedEffect = () => {
  const frame = useCurrentFrame()
  return <AbsoluteFill />
}
"""
    assert _looks_safe(src) is True


def test_looks_safe_rejects_require() -> None:
    assert _looks_safe("const fs = require('fs')\nexport const GeneratedEffect = () => null") is False


def test_looks_safe_rejects_disallowed_import() -> None:
    assert _looks_safe("import axios from 'axios'\nexport const GeneratedEffect = () => null") is False


def test_looks_safe_rejects_eval() -> None:
    assert _looks_safe("eval('1')\nexport const GeneratedEffect = () => null") is False


def test_looks_safe_rejects_process() -> None:
    assert _looks_safe("console.log(process.env)\nexport const GeneratedEffect = () => null") is False


def test_looks_safe_rejects_missing_export_name() -> None:
    assert _looks_safe("export const SomethingElse = () => null") is False


def test_looks_safe_allows_remotion_subpackages() -> None:
    src = "import { Circle } from '@remotion/shapes'\nexport const GeneratedEffect = () => <Circle radius={1} />"
    assert _looks_safe(src) is True


def test_looks_safe_allows_layout_utils_and_paths() -> None:
    src = (
        "import { measureText } from '@remotion/layout-utils'\n"
        "import { interpolatePath } from '@remotion/paths'\n"
        "export const GeneratedEffect = () => null"
    )
    assert _looks_safe(src) is True


def test_looks_safe_allows_extended_remotion_packages() -> None:
    src = (
        "import { createRoundedTextBox } from '@remotion/rounded-text-box'\n"
        "import { Starburst } from '@remotion/starburst'\n"
        "import { noise2D } from '@remotion/noise'\n"
        "import { interpolateStyles } from '@remotion/animation-utils'\n"
        "import { Trail } from '@remotion/motion-blur'\n"
        "export const GeneratedEffect = () => null"
    )
    assert _looks_safe(src) is True


def test_looks_safe_allows_effects_subpaths() -> None:
    # @remotion/effects IS wired in now: Remotion's bundled headless shell
    # ships the canvas-draw-element flag pre-enabled (v4.0.455+) and the
    # sidecar passes chromiumOptions gl=angle, so shader effects render on
    # clean machines. Per-effect subpath imports are the documented usage.
    for sub in ('glow', 'drop-shadow', 'chromatic-aberration', 'zoom-blur'):
        src = f"import {{ x }} from '@remotion/effects/{sub}'\nexport const GeneratedEffect = () => null"
        assert _looks_safe(src) is True, sub
    bare = "import { glow } from '@remotion/effects'\nexport const GeneratedEffect = () => null"
    assert _looks_safe(bare) is True


def test_looks_safe_still_rejects_animated_emoji() -> None:
    # Real Remotion package, deliberately NOT in the codegen allowlist: asset
    # paths inside generated code are fragile, so it ships as a trusted
    # registry component instead (see effects_codegen.py module docstring).
    emoji = "import { AnimatedEmoji } from '@remotion/animated-emoji'\nexport const GeneratedEffect = () => null"
    assert _looks_safe(emoji) is False


def test_looks_safe_allows_lucide_react() -> None:
    lucide = "import { Play, Sparkles } from 'lucide-react'\nexport const GeneratedEffect = () => null"
    assert _looks_safe(lucide) is True


def test_looks_safe_rejects_framer_and_other_web_libraries() -> None:
    # framer-motion / motion: wrong under Remotion frame-by-frame render.
    # Other web libs: not installed.
    framer = "import { motion } from 'framer-motion'\nexport const GeneratedEffect = () => null"
    motion_pkg = "import { motion } from 'motion/react'\nexport const GeneratedEffect = () => null"
    axios = "import axios from 'axios'\nexport const GeneratedEffect = () => null"
    react_icons = "import { FaHeart } from 'react-icons/fa'\nexport const GeneratedEffect = () => null"
    assert _looks_safe(framer) is False
    assert _looks_safe(motion_pkg) is False
    assert _looks_safe(axios) is False
    assert _looks_safe(react_icons) is False


def test_build_user_text_without_reference() -> None:
    txt = _build_user_text("ทำสติกเกอร์รูปหัวใจ", has_reference_image=False)
    assert "หัวใจ" in txt
    assert "reference image" not in txt


def test_build_user_text_with_reference() -> None:
    txt = _build_user_text("", has_reference_image=True)
    assert "reference image is attached" in txt
    assert "no specific instruction" in txt
