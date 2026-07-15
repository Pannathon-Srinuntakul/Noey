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


def test_build_user_text_without_reference() -> None:
    txt = _build_user_text("ทำสติกเกอร์รูปหัวใจ", has_reference_image=False)
    assert "หัวใจ" in txt
    assert "reference image" not in txt


def test_build_user_text_with_reference() -> None:
    txt = _build_user_text("", has_reference_image=True)
    assert "reference image is attached" in txt
    assert "no specific instruction" in txt
