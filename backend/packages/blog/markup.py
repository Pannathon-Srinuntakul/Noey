"""Parse and re-serialise the HTML/CSS an AI writer sends for a visual
(`create_visual`) or a cover (`render_cover`). No regular expressions decide
anything here: HTML goes through the standard library's HTML tokenizer
(html.parser) and CSS through a CSS Syntax Level 3 tokenizer below.

Two jobs:

1. **Refuse what is not allowed, naming the spot.** Every problem is a
   sentence a writer can act on ("html line 4: <iframe> is not allowed — …",
   "css line 12: `display: grid` …"), and ALL of them are returned at once.
2. **Emit what the browser will see.** The HTML is RE-SERIALISED from the
   parse — only the elements and attributes that passed, every attribute
   value quoted and escaped, text escaped, comments/doctype/CDATA dropped — so
   what is stored is exactly what was checked (no parser-differential tricks
   such as a `<noscript>`/`<svg><style>` breakout survive: those elements are
   refused, and no CSS may contain `<`).

This is a POLICY layer (clear errors, no outside URLs). The SECURITY boundary
of a visual is elsewhere: a sandboxed iframe without allow-same-origin on a
cookieless origin, with `connect-src 'none'` (packages/blog/visual.py,
docs/blog-mcp.md). A cover never runs anything: it is drawn to pixels.
"""

from __future__ import annotations

import html as html_lib
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import Literal

Mode = Literal["visual", "cover"]

#: Elements never allowed, with the fix-it hint.
DENIED_ELEMENTS: dict[str, str] = {
    "iframe": "no frames — draw the content itself",
    "frame": "no frames",
    "frameset": "no frames",
    "portal": "no frames",
    "form": "a visual is a picture — nothing to submit",
    "a": "a visual behaves like an image and cannot hold links — put links in the article text",
    "input": "no form controls",
    "button": "no form controls — draw a button-looking <div> instead",
    "select": "no form controls",
    "textarea": "no form controls",
    "option": "no form controls",
    "optgroup": "no form controls",
    "datalist": "no form controls",
    "output": "no form controls",
    "object": "no plugins/embedded documents",
    "embed": "no plugins/embedded documents",
    "applet": "no plugins/embedded documents",
    "param": "no plugins/embedded documents",
    "base": "no <base> — URLs are fixed",
    "meta": "no <meta> (refresh/CSP/charset are set by the server)",
    "link": "no <link> — put CSS in `css`; fonts are already loaded",
    "audio": "no audio/video in a visual — use a library video (`list_media`) in the article instead",
    "video": "no audio/video in a visual — use a library video (`list_media`) in the article instead",
    "source": "no audio/video in a visual",
    "track": "no audio/video in a visual",
    "noscript": "not needed — remove it",
    "noembed": "remove it",
    "noframes": "remove it",
    "template": "remove it — write the markup directly",
    "xmp": "remove it",
    "plaintext": "remove it",
    "listing": "remove it",
    "title": "no <title> — the alt text describes the visual",
    "math": "no MathML — draw it with HTML/SVG",
    "dialog": "remove it",
}
#: Wrappers a writer sometimes pastes; their content is kept, the tags dropped.
DROPPED_WRAPPERS = frozenset({"html", "head", "body"})
VOID_ELEMENTS = frozenset({"area", "br", "col", "hr", "img", "wbr"})
#: Attributes whose value is a URL (plus any attribute whose value has url()).
URL_ATTRIBUTES = frozenset(
    {
        "href", "src", "xlink:href", "poster", "data", "action", "formaction", "background", "cite",
        "longdesc", "usemap", "ping", "lowsrc", "dynsrc", "codebase", "archive", "manifest", "icon", "profile",
    }
)
#: Image types a data: URL may carry (images never run scripts).
DATA_IMAGE_TYPES = ("image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml")

MAX_PROBLEMS = 25

#: html.parser lowercases every name; an SVG's camelCase names are restored
#: (the HTML spec's "adjust SVG tag/attribute names" tables) so the cover
#: renderer — which parses the markup again — sees `viewBox`, not `viewbox`.
_SVG_TAGS = {t.lower(): t for t in (
    "altGlyph", "altGlyphDef", "altGlyphItem", "animateColor", "animateMotion", "animateTransform", "clipPath",
    "feBlend", "feColorMatrix", "feComponentTransfer", "feComposite", "feConvolveMatrix", "feDiffuseLighting",
    "feDisplacementMap", "feDistantLight", "feDropShadow", "feFlood", "feFuncA", "feFuncB", "feFuncG", "feFuncR",
    "feGaussianBlur", "feImage", "feMerge", "feMergeNode", "feMorphology", "feOffset", "fePointLight",
    "feSpecularLighting", "feSpotLight", "feTile", "feTurbulence", "foreignObject", "glyphRef", "linearGradient",
    "radialGradient", "textPath",
)}
_SVG_ATTRS = {a.lower(): a for a in (
    "attributeName", "attributeType", "baseFrequency", "baseProfile", "calcMode", "clipPathUnits", "diffuseConstant",
    "edgeMode", "filterUnits", "glyphRef", "gradientTransform", "gradientUnits", "kernelMatrix", "kernelUnitLength",
    "keyPoints", "keySplines", "keyTimes", "lengthAdjust", "limitingConeAngle", "markerHeight", "markerUnits",
    "markerWidth", "maskContentUnits", "maskUnits", "numOctaves", "pathLength", "patternContentUnits",
    "patternTransform", "patternUnits", "pointsAtX", "pointsAtY", "pointsAtZ", "preserveAlpha", "preserveAspectRatio",
    "primitiveUnits", "refX", "refY", "repeatCount", "repeatDur", "requiredExtensions", "requiredFeatures",
    "specularConstant", "specularExponent", "spreadMethod", "startOffset", "stdDeviation", "stitchTiles",
    "surfaceScale", "systemLanguage", "tableValues", "targetX", "targetY", "textLength", "viewBox", "viewTarget",
    "xChannelSelector", "yChannelSelector", "zoomAndPan",
)}


@dataclass
class Result:
    html: str = ""
    css: str = ""
    problems: list[str] = field(default_factory=list)
    #: Media-store images referenced (absolute URLs) — the caller checks each
    #: exists and is an image.
    media_urls: list[str] = field(default_factory=list)
    #: Every character of visible text (covers check the fonts cover them).
    text_chars: set[str] = field(default_factory=set)

    def add(self, problem: str) -> None:
        if len(self.problems) < MAX_PROBLEMS and problem not in self.problems:
            self.problems.append(problem)


# ── URLs ─────────────────────────────────────────────────────────────────────


def _clean_url(raw: str) -> str:
    # Browsers strip leading/trailing C0 controls and spaces and drop tabs and
    # newlines anywhere in a URL: judge the URL the browser would request.
    out = "".join(ch for ch in raw if ch not in "\t\n\r")
    return out.strip(" \x00\x01\x02\x03\x04\x05\x06\x07\x08\x0b\x0c\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f")


def check_url(raw: str, where: str, media_base: str, result: Result) -> None:
    """Allowed: `#fragment` (SVG gradients, <use href="#id">), data:image/*,
    and images of the blog media store. Anything else is named and refused."""
    url = _clean_url(raw)
    if not url or url.startswith("#"):
        return
    low = url.lower()
    if low.startswith("data:"):
        mime = low[5:].split(";", 1)[0].split(",", 1)[0].strip()
        if mime not in DATA_IMAGE_TYPES:
            result.add(f"{where}: data: URL of type `{mime or '?'}` — only data:image/(png|jpeg|gif|webp|svg+xml) is allowed.")
        return
    base = media_base.rstrip("/") + "/"
    if url.startswith(base):
        name = url[len(base):]
        stem, dot, ext = name.partition(".")
        if dot and ext == "webp" and len(stem) == 64 and all(c in "0123456789abcdef" for c in stem):
            if url not in result.media_urls:
                result.media_urls.append(url)
            return
        result.add(f"{where}: `{url[:120]}` is not an image of the media store — use an image url from `list_media` or `upload_image` (a .webp).")
        return
    result.add(
        f"{where}: `{url[:120]}` is outside the blog media store — external URLs are not allowed. "
        f"Use images from `list_media` (they start with {base}), a data:image URL, or inline SVG."
    )


# ── CSS (CSS Syntax Level 3 tokenizer, enough to find what matters) ──────────


@dataclass
class Tok:
    kind: str  # ident function at-keyword hash string url bad-url delim number colon semicolon comma ( ) [ ] { } ws
    value: str
    line: int


def _is_name_char(ch: str) -> bool:
    return ch.isalnum() or ch in "-_" or ord(ch) >= 0x80


def _is_name_start(ch: str) -> bool:
    return ch.isalpha() or ch == "_" or ord(ch) >= 0x80


def tokenize_css(text: str) -> list[Tok]:
    toks: list[Tok] = []
    i, n, line = 0, len(text), 1

    def escape(j: int) -> tuple[str, int]:
        # text[j] == "\\"
        j += 1
        if j >= n:
            return "�", j
        hexd = ""
        while j < n and len(hexd) < 6 and text[j] in "0123456789abcdefABCDEF":
            hexd += text[j]
            j += 1
        if hexd:
            if j < n and text[j] in " \t\n":
                j += 1
            cp = int(hexd, 16)
            return (chr(cp) if 0 < cp <= 0x10FFFF and not 0xD800 <= cp <= 0xDFFF else "�"), j
        return text[j], j + 1

    def name(j: int) -> tuple[str, int]:
        out = ""
        while j < n:
            if _is_name_char(text[j]):
                out += text[j]
                j += 1
            elif text[j] == "\\" and j + 1 < n and text[j + 1] != "\n":
                ch, j = escape(j)
                out += ch
            else:
                break
        return out, j

    def starts_ident(j: int) -> bool:
        if j >= n:
            return False
        c = text[j]
        if c == "-":
            return j + 1 < n and (_is_name_start(text[j + 1]) or text[j + 1] == "-" or (text[j + 1] == "\\" and j + 2 < n and text[j + 2] != "\n"))
        if c == "\\":
            return j + 1 < n and text[j + 1] != "\n"
        return _is_name_start(c)

    while i < n:
        c = text[i]
        if c == "/" and text.startswith("/*", i):
            end = text.find("*/", i + 2)
            end = n if end < 0 else end + 2
            line += text.count("\n", i, end)
            i = end
            continue
        if c in " \t\n\r\f":
            j = i
            while j < n and text[j] in " \t\n\r\f":
                j += 1
            line += text.count("\n", i, j)
            toks.append(Tok("ws", " ", line))
            i = j
            continue
        if c in "\"'":
            j, out, start_line = i + 1, "", line
            kind = "string"
            while j < n:
                ch = text[j]
                if ch == c:
                    j += 1
                    break
                if ch == "\n":
                    kind = "bad-string"
                    break
                if ch == "\\":
                    if j + 1 < n and text[j + 1] == "\n":
                        line += 1
                        j += 2
                        continue
                    esc, j = escape(j)
                    out += esc
                    continue
                out += ch
                j += 1
            toks.append(Tok(kind, out, start_line))
            i = j
            continue
        if c.isdigit() or (c in "+-." and i + 1 < n and (text[i + 1].isdigit() or (text[i + 1] == "." and i + 2 < n and text[i + 2].isdigit()))):
            j = i + 1
            while j < n and (text[j].isdigit() or text[j] in ".eE" or (text[j] in "+-" and text[j - 1] in "eE")):
                j += 1
            if starts_ident(j):
                _, j = name(j)
            elif j < n and text[j] == "%":
                j += 1
            toks.append(Tok("number", text[i:j], line))
            i = j
            continue
        if starts_ident(i):
            word, j = name(i)
            if j < n and text[j] == "(":
                if word.lower() == "url":
                    # url( — unquoted → a url token; quoted → function + string.
                    k = j + 1
                    while k < n and text[k] in " \t\n\r\f":
                        k += 1
                    if k < n and text[k] in "\"'":
                        toks.append(Tok("function", word, line))
                        i = j + 1
                        continue
                    out, bad = "", False
                    while k < n and text[k] != ")":
                        ch = text[k]
                        if ch == "\\" and k + 1 < n and text[k + 1] != "\n":
                            esc, k = escape(k)
                            out += esc
                            continue
                        if ch in "\"'(" or ch == "\n":
                            bad = True
                        out += ch
                        k += 1
                    line += text.count("\n", j, k)
                    toks.append(Tok("bad-url" if bad else "url", out.strip(), line))
                    i = k + 1
                    continue
                toks.append(Tok("function", word, line))
                i = j + 1
                continue
            toks.append(Tok("ident", word, line))
            i = j
            continue
        if c == "@" and starts_ident(i + 1):
            word, j = name(i + 1)
            toks.append(Tok("at-keyword", word, line))
            i = j
            continue
        if c == "#" and i + 1 < n and (_is_name_char(text[i + 1]) or text[i + 1] == "\\"):
            word, j = name(i + 1)
            toks.append(Tok("hash", word, line))
            i = j
            continue
        if c == ":":
            toks.append(Tok("colon", c, line))
        elif c == ";":
            toks.append(Tok("semicolon", c, line))
        elif c == ",":
            toks.append(Tok("comma", c, line))
        elif c in "()[]{}":
            toks.append(Tok(c, c, line))
        elif c == "\\":
            esc, j = escape(i)
            toks.append(Tok("delim", esc, line))
            i = j
            continue
        else:
            toks.append(Tok("delim", c, line))
        i += 1
    return toks


#: Functions whose string arguments are URLs.
_URL_FUNCTIONS = frozenset({"url", "src", "image", "image-set", "-webkit-image-set", "cross-fade", "-webkit-cross-fade"})
#: Never in any CSS.
_DENIED_AT_RULES = {
    "import": "no @import — everything must be in `css`",
    "font-face": "no @font-face — the brand fonts are already loaded (see get_site_info brand.fonts)",
    "namespace": "no @namespace",
}
_DENIED_FUNCTIONS = {"expression": "expression() is not CSS", "element": "-moz-element() is not allowed", "-moz-element": "-moz-element() is not allowed"}
_DENIED_PROPERTIES = {"behavior": "not CSS", "-moz-binding": "not allowed"}

#: What the cover renderer cannot draw. Name → fix-it.
_COVER_PROPERTIES = {
    "animation": "covers are still images — remove animation",
    "transition": "covers are still images — remove transition",
    "float": "use flexbox instead of float",
    "columns": "use flexbox instead of multi-column",
    "column-count": "use flexbox instead of multi-column",
    "grid": "CSS grid is not supported in covers — use flexbox",
    "content": "::before/::after content is not drawn in covers — put the text in the HTML",
}
_COVER_AT_RULES = {
    "keyframes": "covers are still images — remove @keyframes",
    "-webkit-keyframes": "covers are still images — remove @keyframes",
    "media": "covers have one fixed size (1600×900) — remove @media",
    "supports": "remove @supports",
    "container": "remove @container",
}


def _decl_problems(prop: str, value: list[Tok], where: str, mode: Mode, result: Result) -> None:
    p = prop.lower()
    vals = [t.value.lower() for t in value if t.kind in ("ident", "function")]
    if p in _DENIED_PROPERTIES:
        result.add(f"{where}: `{prop}` — {_DENIED_PROPERTIES[p]}.")
    if mode != "cover":
        return
    base = p.removeprefix("-webkit-")
    for key, hint in _COVER_PROPERTIES.items():
        if base == key or base.startswith(key + "-"):
            result.add(f"{where}: `{prop}` — {hint}.")
            return
    if p == "display" and any(v in ("grid", "inline-grid", "table", "inline-table", "inline", "inline-block") for v in vals):
        shown = next(v for v in vals if v in ("grid", "inline-grid", "table", "inline-table", "inline", "inline-block"))
        result.add(f"{where}: `display: {shown}` is not supported in covers — use `display: flex` (or `none`).")
    if p == "position" and any(v in ("fixed", "sticky") for v in vals):
        result.add(f"{where}: `position: {next(v for v in vals if v in ('fixed', 'sticky'))}` — covers support relative and absolute only.")


def check_css(text: str, label: str, media_base: str, mode: Mode, result: Result, *, declarations_only: bool = False) -> None:
    """Every problem in a stylesheet (or a `style` attribute when
    `declarations_only`), named by line. URLs go through `check_url`."""
    if "<" in text:
        line = text.count("\n", 0, text.index("<")) + 1
        result.add(f"{label}{'' if declarations_only else f' line {line}'}: CSS may not contain `<` (write \\3c inside a string if you need the character).")
    toks = tokenize_css(text)
    depth = 0
    #: Expecting a property name at the start of a declaration.
    at_decl_start = declarations_only
    i, n = 0, len(toks)
    while i < n:
        t = toks[i]
        where = label if declarations_only else f"{label} line {t.line}"
        if t.kind == "bad-url":
            result.add(f"{where}: malformed url(...) — quote the URL.")
        elif t.kind == "url":
            check_url(t.value, where, media_base, result)
        elif t.kind == "function":
            fname = t.value.lower()
            if fname in _DENIED_FUNCTIONS:
                result.add(f"{where}: {_DENIED_FUNCTIONS[fname]}.")
            if fname in _URL_FUNCTIONS:
                # The string arguments up to the matching ')' are URLs.
                level, j = 1, i + 1
                while j < n and level:
                    if toks[j].kind in ("function", "("):
                        level += 1
                    elif toks[j].kind == ")":
                        level -= 1
                    elif toks[j].kind == "string" and level == 1:
                        check_url(toks[j].value, where, media_base, result)
                    j += 1
        elif t.kind == "at-keyword":
            name = t.value.lower()
            if name in _DENIED_AT_RULES:
                result.add(f"{where}: @{t.value} — {_DENIED_AT_RULES[name]}.")
            elif mode == "cover" and name in _COVER_AT_RULES:
                result.add(f"{where}: @{t.value} — {_COVER_AT_RULES[name]}.")
            at_decl_start = False
        elif t.kind == "{":
            depth += 1
            at_decl_start = True
        elif t.kind == "}":
            depth = max(0, depth - 1)
            at_decl_start = depth > 0 or declarations_only
        elif t.kind == "semicolon":
            at_decl_start = depth > 0 or declarations_only
        elif t.kind == "ident" and at_decl_start:
            # property: value ;  (a nested rule's selector also starts with an
            # ident, but is not followed by ':' + value up to ';' — and covers
            # forbid pseudo-classes nowhere, so only "ident ws* colon" counts)
            j = i + 1
            while j < n and toks[j].kind == "ws":
                j += 1
            if j < n and toks[j].kind == "colon":
                k, value = j + 1, []
                level = 0
                while k < n:
                    kind = toks[k].kind
                    if kind in ("function", "(", "[", "{"):
                        level += 1
                    elif kind in (")", "]", "}"):
                        if level == 0:
                            break
                        level -= 1
                    elif kind == "semicolon" and level == 0:
                        break
                    value.append(toks[k])
                    k += 1
                # A selector like `a:hover {` reaches '{' at level 0 before
                # ';' — then this was not a declaration.
                if not any(v.kind == "{" for v in value):
                    _decl_problems(t.value, value, where, mode, result)
            at_decl_start = False
        elif t.kind not in ("ws",):
            at_decl_start = False
        i += 1


# ── HTML ─────────────────────────────────────────────────────────────────────


class _Sanitizer(HTMLParser):
    def __init__(self, mode: Mode, media_base: str, result: Result) -> None:
        super().__init__(convert_charrefs=True)
        self.mode = mode
        self.media_base = media_base
        self.result = result
        self.out: list[str] = []
        self.stack: list[str] = []
        #: Inside a refused element: its content is dropped too.
        self.skip_depth = 0
        self.skip_tag: str | None = None
        self.in_style = False
        self.style_text: list[str] = []
        self.style_line = 0

    def in_svg(self) -> bool:
        return "svg" in self.stack

    def where(self) -> str:
        return f"html line {self.getpos()[0]}"

    def _attrs(self, tag: str, attrs: list[tuple[str, str | None]]) -> str:
        parts: list[str] = []
        for raw_name, raw_value in attrs:
            name = raw_name.lower()
            value = raw_value if raw_value is not None else ""
            if name.startswith("on"):
                hint = "put JavaScript in `js`" if self.mode == "visual" else "covers run no JavaScript"
                self.result.add(f"{self.where()}: <{tag} {name}=…> — event handler attributes are not allowed ({hint}).")
                continue
            if name in ("srcset", "imagesrcset"):
                self.result.add(f"{self.where()}: <{tag} {name}> — use a single `src` instead of srcset.")
                continue
            if name == "srcdoc":
                self.result.add(f"{self.where()}: <{tag} srcdoc> is not allowed.")
                continue
            if name == "style":
                check_css(value, f"{self.where()}: <{tag} style>", self.media_base, self.mode, self.result, declarations_only=True)
            elif name.startswith("xmlns"):
                pass  # namespace declarations, not fetched
            elif name in URL_ATTRIBUTES or name.endswith(":href"):
                check_url(value, f"{self.where()}: <{tag} {name}>", self.media_base, self.result)
            elif "url(" in value.lower():
                check_css(f"x:{value}", f"{self.where()}: <{tag} {name}>", self.media_base, self.mode, self.result, declarations_only=True)
            if not all(ch.isalnum() or ch in "-_:." for ch in name):
                self.result.add(f"{self.where()}: attribute name `{name[:40]}` is not valid.")
                continue
            shown = _SVG_ATTRS.get(name, name) if self.in_svg() or tag == "svg" else name
            parts.append(f' {shown}="{html_lib.escape(value, quote=True)}"')
        return "".join(parts)

    def _open(self, tag: str, attrs: list[tuple[str, str | None]], self_closing: bool) -> None:
        tag = tag.lower()
        if self.skip_depth:
            if not self_closing and tag not in VOID_ELEMENTS:
                self.skip_depth += 1 if tag == self.skip_tag else 0
            return
        if tag in DROPPED_WRAPPERS:
            return
        if tag == "script":
            hint = "put JavaScript in the `js` argument" if self.mode == "visual" else "covers are still images and run no JavaScript"
            self.result.add(f"{self.where()}: <script> is not allowed here — {hint}.")
            self._skip(tag, self_closing)
            return
        if tag in DENIED_ELEMENTS:
            self.result.add(f"{self.where()}: <{tag}> is not allowed — {DENIED_ELEMENTS[tag]}.")
            self._skip(tag, self_closing)
            return
        if tag == "style":
            if "svg" in self.stack:
                self.result.add(f"{self.where()}: <style> inside <svg> is not allowed — put that CSS in `css`.")
                self._skip(tag, self_closing)
                return
            if self.mode == "cover":
                self.result.add(f"{self.where()}: <style> in the cover html — put the CSS in `css`.")
                self._skip(tag, self_closing)
                return
        if tag == "foreignobject" and self.mode == "cover":
            self.result.add(f"{self.where()}: <foreignObject> cannot be drawn in a cover.")
            self._skip(tag, self_closing)
            return
        attr_text = self._attrs(tag, attrs)
        svg = self.in_svg() or tag == "svg"
        shown = _SVG_TAGS.get(tag, tag) if svg else tag
        if tag in VOID_ELEMENTS and not svg:
            self.out.append(f"<{tag}{attr_text}>")
            return
        if self_closing:
            # Foreign (SVG) content honours `/>`; an HTML element does not, so
            # it is written as an explicit empty pair — the browser then builds
            # the same tree this parser saw.
            self.out.append(f"<{shown}{attr_text} />" if svg else f"<{tag}{attr_text}></{tag}>")
            return
        self.out.append(f"<{shown}{attr_text}>")
        self.stack.append(tag)
        if tag == "style":
            self.in_style = True
            self.style_text = []
            self.style_line = self.getpos()[0]

    def _skip(self, tag: str, self_closing: bool) -> None:
        if not self_closing and tag not in VOID_ELEMENTS:
            self.skip_depth, self.skip_tag = 1, tag

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._open(tag, attrs, self_closing=False)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._open(tag, attrs, self_closing=True)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if self.skip_depth:
            if tag == self.skip_tag:
                self.skip_depth -= 1
                if not self.skip_depth:
                    self.skip_tag = None
            return
        if tag in DROPPED_WRAPPERS or tag in VOID_ELEMENTS:
            return
        if tag in self.stack:
            # Close everything opened inside it as well (what a browser does).
            while self.stack:
                top = self.stack.pop()
                if top == "style":
                    self._end_style()
                svg = self.in_svg() or top == "svg"
                self.out.append(f"</{_SVG_TAGS.get(top, top) if svg else top}>")
                if top == tag:
                    break

    def _end_style(self) -> None:
        text = "".join(self.style_text)
        check_css(text, f"html <style> at line {self.style_line}", self.media_base, self.mode, self.result)
        self.out.append(text)
        self.in_style = False
        self.style_text = []

    def handle_data(self, data: str) -> None:
        if self.skip_depth:
            return
        if self.in_style:
            self.style_text.append(data)
            return
        self.result.text_chars.update(data)
        self.out.append(html_lib.escape(data, quote=False))

    def handle_comment(self, data: str) -> None:
        return  # dropped

    def handle_decl(self, decl: str) -> None:
        return  # <!doctype> dropped

    def unknown_decl(self, data: str) -> None:
        return  # <![CDATA[ … ]]> dropped

    def handle_pi(self, data: str) -> None:
        return

    def finish(self) -> str:
        self.close()
        while self.stack:
            top = self.stack.pop()
            if top == "style":
                self._end_style()
            svg = self.in_svg() or top == "svg"
            self.out.append(f"</{_SVG_TAGS.get(top, top) if svg else top}>")
        return "".join(self.out)


def sanitize(html: str, css: str, *, mode: Mode, media_base: str) -> Result:
    """Check + re-serialise one visual's or cover's markup. The result's
    `problems` lists everything to fix; `html`/`css` are only meaningful when
    there are none."""
    result = Result()
    if "\x00" in html or "\x00" in css:
        result.add("html/css contain a NUL character — remove it.")
    sanitizer = _Sanitizer(mode, media_base, result)
    sanitizer.feed(html)
    result.html = sanitizer.finish()
    if not result.html.strip():
        result.add("html is empty — send the markup of the picture.")
    check_css(css, "css", media_base, mode, result)
    result.css = css
    return result


def check_js(js: str, media_base: str, result: Result) -> None:
    """A visual's script. CSP (`connect-src 'none'`) and the iframe sandbox are
    what contain it; these checks keep the script inside its <script> element
    and catch the obvious mistake of pointing at the outside world."""
    low = js.lower()
    for needle, why in (("</script", "`</script` would end the script early"), ("<!--", "`<!--` changes how the script is parsed"), ("<script", "`<script` changes how the script is parsed")):
        if needle in low:
            line = js.count("\n", 0, low.index(needle)) + 1
            result.add(f"js line {line}: {why} — split the string (e.g. '<' + '/script').")
    base = media_base.rstrip("/") + "/"
    for scheme in ("https://", "http://"):
        start = 0
        while (k := low.find(scheme, start)) >= 0:
            end = k
            while end < len(js) and js[end] not in "\"'` \n\t)":
                end += 1
            url = js[k:end]
            if not url.startswith(base) and not url.startswith("http://www.w3.org/"):
                line = js.count("\n", 0, k) + 1
                result.add(f"js line {line}: `{url[:100]}` — a visual cannot load anything from outside (network access is blocked); use media-store images only.")
            start = end
