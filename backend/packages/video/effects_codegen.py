"""AI-generated effect components (REMOTION_EFFECTS_REQUIREMENTS.md §6
extension, decided 2026-07-16).

The fixed component registry (effects_catalog.py) covers common cases; this
module lets the user (or the placement pass) ask for something genuinely new —
a component the registry doesn't have — described by a text prompt and/or a
reference image. The model writes a plain JS+JSX Remotion component; nothing
about that source is trusted based on this call succeeding.

SECURITY MODEL — read before touching this file:
The output of this call is UNTRUSTED input, no different in kind from user-
uploaded content, even though it looks like source code. A prompt instruction
telling the model "don't access the filesystem" is NOT a security boundary — the
same call that produces this code also processes user-controlled content
(the reference image, the free-text prompt) that could carry an injected
instruction trying to override those rules, the same way any prompt injection
attack works. The prompt below states the rules anyway (cheap, reduces wasted
generations that fail validation) but the REAL enforcement is entirely on the
desktop side: desktop/node-sidecar/src/codegenValidate.mjs statically parses
the returned source and rejects anything outside a hard allowlist BEFORE it is
ever bundled or executed. `_looks_safe()` below is a fast, best-effort,
NON-AUTHORITATIVE pre-filter — it exists only to fail fast and save a wasted
render round-trip; it must never be treated as the actual gate.
"""

from __future__ import annotations

import base64
import re
from pathlib import Path
from typing import Any

GENERATED_COMPONENT_SYSTEM = """<role>
You write ONE small Remotion (React video) overlay component in plain
JavaScript + JSX — no TypeScript syntax, no type annotations. Do all reasoning
in English. On-screen text you author should be in Thai (Thai affiliate
content) unless the user's prompt says otherwise.
</role>

<output_contract>
Return ONLY the source code, nothing else — no markdown fences, no prose before
or after. The source MUST:
- `export const GeneratedEffect = (props) => { ... }` — the component, taking
  a single props object (destructure whatever fields you need).
- Optionally `export const generatedEffectDefaultProps = { ... }` — sensible
  defaults for every prop you use.
- Import ONLY from: "react", "remotion", "@remotion/shapes", "@remotion/lottie",
  "@remotion/light-leaks". No other import is allowed and will be rejected.
- Never touch the filesystem, network, environment, or any Node/browser global
  (no fs, child_process, process, fetch, XMLHttpRequest, eval, Function,
  require, __dirname, global, globalThis). Anything like this is rejected
  before it ever runs — don't include it even experimentally.
- Paint NOTHING full-frame opaque — this is a TRANSPARENT overlay composited
  on top of a video by ffmpeg afterwards. No background-color on the root
  element/AbsoluteFill.
- Use `useCurrentFrame()` + `interpolate()`/`spring()` from "remotion" for
  animation, matching Remotion's own composition conventions (prefer
  `interpolate()` for most animation, `spring()` for spring-like physics; use
  the `scale`/`translate`/`rotate` CSS shorthand properties, not a combined
  `transform` string).
</output_contract>

<sizing>
The composition canvas size is NOT fixed — read it from remotion's
`useVideoConfig()` (`width`, `height`) and position elements as fractions of
that, the same convention the built-in registry components use (props named
`x`/`y` as 0..1 fractions is a good default unless the brief calls for
something else).
</sizing>
"""


def _build_user_text(prompt: str, has_reference_image: bool) -> str:
    prompt_block = prompt.strip() or "(no specific instruction — use good judgment for a TikTok-style effect)"
    ref_note = (
        "\n\nA reference image is attached — take visual inspiration from its style/"
        "colors/mood, but still only compose from the allowed imports above; do not "
        "attempt to literally embed or fetch the reference image itself."
        if has_reference_image
        else ""
    )
    return f"<request>{prompt_block}</request>{ref_note}\n\nReturn ONLY the component source code."


# Fast, NON-AUTHORITATIVE pre-filter — see module docstring. The real gate is
# desktop/node-sidecar/src/codegenValidate.mjs (a real AST parse). This is a
# best-effort regex pass purely to avoid a wasted render round-trip when the
# model obviously ignored the rules; it is deliberately conservative (may
# reject some things a full parse would allow) since false negatives here are
# harmless — the desktop-side gate would catch them anyway.
_FORBIDDEN_PATTERNS = [
    r"\brequire\s*\(",
    r"\beval\s*\(",
    r"\bnew\s+Function\s*\(",
    r"\bfetch\s*\(",
    r"\bXMLHttpRequest\b",
    r"\bprocess\.",
    r"\b__dirname\b",
    r"\b__filename\b",
    r"\bglobalThis\b",
    r"^\s*import\s+.*from\s+['\"](?!react|remotion|@remotion/(shapes|lottie|light-leaks))",
]


def _looks_safe(source: str) -> bool:
    for pattern in _FORBIDDEN_PATTERNS:
        if re.search(pattern, source, re.MULTILINE):
            return False
    return "GeneratedEffect" in source


async def generate_effect_component(
    prompt: str,
    *,
    reference_image_path: str | Path | None = None,
    project_uid: str,
) -> str:
    """Ask the model for a new Remotion overlay component's source.

    Returns the raw (untrusted) source text. Caller MUST pass it through the
    desktop-side validator before ever bundling/rendering it — this function
    only does a cheap non-authoritative pre-check to avoid wasting a whole
    generate+bundle+render round trip on an obviously-bad response.
    """
    from packages.core.settings import get_settings
    from packages.llm.config import call_kwargs
    from packages.llm.gateway import acompletion

    settings = get_settings()

    content: list[dict[str, Any]] = []
    if reference_image_path:
        b64 = base64.b64encode(Path(reference_image_path).read_bytes()).decode("ascii")
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
        })
    content.append({
        "type": "text",
        "text": _build_user_text(prompt, has_reference_image=bool(reference_image_path)),
    })

    extra = call_kwargs(model=settings.effects_codegen_model, effort="medium")
    extra["timeout"] = settings.effects_codegen_timeout_sec

    resp = await acompletion(
        [{"role": "user", "content": content}],
        system=GENERATED_COMPONENT_SYSTEM,
        **extra,
    )
    source = (resp.choices[0].message.content or "").strip()
    # Strip a markdown fence if the model added one despite the instruction not to.
    source = re.sub(r"^```(?:jsx?|tsx?)?\n|\n```$", "", source).strip()

    if not _looks_safe(source):
        raise ValueError("generated component failed the pre-check — try a different prompt")

    return source
