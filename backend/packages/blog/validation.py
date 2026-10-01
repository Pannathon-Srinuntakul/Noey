"""Pure checks on blog content — no database, no I/O.

Every check returns problems as plain sentences addressed to the WRITER (an AI
client through MCP, or the owner in the admin) saying what to change, never a
bare "invalid". Limits follow BLOG_CONTRACT.md: slug a-z0-9- <= 80, meta_title
<= 60, meta_description <= 160, excerpt <= 300; Markdown headings start at ##,
no raw HTML, images only from the blog media origin.
"""

from __future__ import annotations

import math
import re
import unicodedata
from collections.abc import Iterable
from functools import lru_cache

SLUG_MAX = 80
TITLE_MAX = 200
META_TITLE_MAX = 60
META_DESCRIPTION_MAX = 160
EXCERPT_MAX = 300
ALT_MAX = 300
TAG_NAME_MAX = 40
MAX_TAGS = 8
FAQ_MIN = 3
FAQ_MAX = 6
FAQ_QUESTION_MAX = 200
FAQ_ANSWER_MAX = 1000
CONTENT_MAX_CHARS = 60_000
MIN_INTERNAL_LINKS = 2
#: Pictures in the body: images, library videos and HTML visuals together.
MIN_BODY_MEDIA = 2
MAX_ANIMATED_VISUALS = 3

#: Thai prose reads at roughly 200 words a minute once segmented.
WORDS_PER_MINUTE = 200

SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")

#: AI vendors and model names the site never names (CLAUDE.md: "The UI never
#: names an AI vendor"). Matched case-insensitively on word boundaries; the
#: Thai spellings are matched as substrings.
BANNED_TERMS: tuple[str, ...] = (
    "gemini", "claude", "anthropic", "openai", "chatgpt", "gpt-3", "gpt-4", "gpt-5", "gpt4", "gpt5",
    "elevenlabs", "eleven labs", "twelve labs", "twelvelabs", "llama", "mistral", "deepseek",
    "grok", "copilot", "midjourney", "dall-e", "sora", "veo", "whisper",
)
BANNED_THAI: tuple[str, ...] = ("เจมิไน", "คล็อด", "แชทจีพีที", "แชตจีพีที", "อีเลฟเวนแล็บส์")
_BANNED_RE = re.compile(r"(?<![a-z0-9])(" + "|".join(re.escape(t) for t in BANNED_TERMS) + r")(?![a-z0-9])", re.IGNORECASE)

#: Hosts that count as "this site" for the internal-link rule.
SITE_HOSTS = ("noeystudio.com", "www.noeystudio.com")

_FENCE_RE = re.compile(r"^(```|~~~).*?^\1[ \t]*$", re.MULTILINE | re.DOTALL)
_INLINE_CODE_RE = re.compile(r"`[^`\n]*`")
_AUTOLINK_RE = re.compile(r"<(?:https?://|mailto:)[^>\s]+>", re.IGNORECASE)
_HTML_RE = re.compile(r"<\s*/?\s*[a-zA-Z!?][^>]*>?")
_DANGEROUS_RE = re.compile(r"<\s*/?\s*(script|iframe|object|embed|style|form|input|svg|math|link|meta)\b", re.IGNORECASE)
_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+\"[^\"]*\")?\s*\)")
_REF_IMAGE_RE = re.compile(r"!\[[^\]]*\]\[[^\]]*\]")
_LINK_RE = re.compile(r"(?<!!)\[([^\]]+)\]\(\s*<?([^)\s>]*)>?(?:\s+\"[^\"]*\")?\s*\)")
_BARE_URL_RE = re.compile(r"https?://[^\s)>\]]+")
_H1_ATX_RE = re.compile(r"^ {0,3}#(?!#)\s", re.MULTILINE)
_SETEXT_H1_RE = re.compile(r"^\S[^\n]*\n {0,3}=+[ \t]*$", re.MULTILINE)
_HEADING_RE = re.compile(r"^ {0,3}(#{2,6})\s+\S", re.MULTILINE)
_BAD_SCHEMES = ("javascript:", "data:", "vbscript:", "file:")
#: An HTML visual, alone on its line: `::visual[alt text](<32-hex id>)`.
VISUAL_RE = re.compile(r"^ {0,3}::visual\[([^\]\n]*)\]\(([^)\s]*)\)[ \t]*$", re.MULTILINE)
_VISUAL_ANY_RE = re.compile(r"::visual\b")
VISUAL_ID_RE = re.compile(r"^[0-9a-f]{32}$")


def _strip_code(md: str) -> str:
    return _INLINE_CODE_RE.sub(" ", _FENCE_RE.sub("\n", md))


def slug_problem(slug: str) -> str | None:
    if not slug:
        return "slug is empty — use lowercase a-z, 0-9 and single hyphens, e.g. `thai-subtitles-tiktok-tips`."
    if len(slug) > SLUG_MAX:
        return f"slug is {len(slug)} characters; the limit is {SLUG_MAX}. Shorten it."
    if not SLUG_RE.match(slug):
        return (
            f"slug `{slug}` is not allowed — use only lowercase a-z, 0-9 and single hyphens "
            "(no spaces, Thai, underscores, leading/trailing or double hyphens)."
        )
    return None


def slugify_tag(raw: str) -> str:
    """`Thai Subtitles!` → `thai-subtitles`. Non-ASCII letters are dropped, so a
    purely Thai name yields "" and the caller must ask for an English slug."""
    text = unicodedata.normalize("NFKD", raw).encode("ascii", "ignore").decode().lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return re.sub(r"-{2,}", "-", text)[:SLUG_MAX].strip("-")


def _length(field: str, value: str | None, *, maximum: int, minimum: int = 1) -> str | None:
    n = len(value or "")
    if n < minimum:
        return f"{field} is required (at least {minimum} characters)." if minimum > 1 else f"{field} is required."
    if n > maximum:
        return f"{field} is {n} characters; the limit is {maximum}. Shorten it."
    return None


def banned_terms(texts: Iterable[str | None]) -> list[str]:
    found: set[str] = set()
    for text in texts:
        if not text:
            continue
        found.update(m.group(1).lower() for m in _BANNED_RE.finditer(text))
        found.update(t for t in BANNED_THAI if t in text)
    return sorted(found)


@lru_cache(maxsize=1)
def _tokenizer():  # type: ignore[no-untyped-def]
    from pythainlp.tokenize import word_tokenize

    return word_tokenize


def word_count(markdown: str) -> int:
    """Words in the readable text: code, URLs and Markdown punctuation dropped,
    Thai segmented with pythainlp's newmm dictionary tokenizer."""
    text = _strip_code(markdown)
    text = VISUAL_RE.sub(" ", text)
    text = _IMAGE_RE.sub(" ", text)
    text = _LINK_RE.sub(lambda m: f" {m.group(1)} ", text)
    text = _BARE_URL_RE.sub(" ", text)
    text = re.sub(r"[#*_>|\-\[\]()`~]+", " ", text)
    tokens = _tokenizer()(text, engine="newmm", keep_whitespace=False)
    return sum(1 for t in tokens if any(ch.isalnum() for ch in t))


def reading_minutes(markdown: str) -> int:
    return max(1, math.ceil(word_count(markdown) / WORDS_PER_MINUTE))


def is_internal_link(url: str) -> bool:
    if url.startswith("/") and not url.startswith("//"):
        return True
    m = re.match(r"https?://([^/:?#]+)", url, re.IGNORECASE)
    return bool(m and m.group(1).lower() in SITE_HOSTS)


def media_url_ok(url: str, media_base: str) -> bool:
    base = media_base.rstrip("/") + "/"
    return bool(base.strip("/")) and url.startswith(base) and ".." not in url[len(base):]


def body_media(markdown: str) -> list[tuple[str, str, str]]:
    """The pictures of a body in reading order: (type, alt, ref) where type is
    `image` (an image or a video — ref is the URL) or `visual` (ref is the id).
    Code blocks are ignored."""
    prose = _strip_code(markdown)
    found: list[tuple[int, str, str, str]] = []
    for m in _IMAGE_RE.finditer(prose):
        found.append((m.start(), "image", m.group(1), m.group(2)))
    for m in VISUAL_RE.finditer(prose):
        found.append((m.start(), "visual", m.group(1), m.group(2)))
    return [(t, alt, ref) for _, t, alt, ref in sorted(found)]


def media_links(markdown: str, media_base: str) -> list[str]:
    """Plain links into the media store (a PDF download, say)."""
    return [u for _, u in _LINK_RE.findall(_strip_code(markdown)) if media_url_ok(u, media_base)]


def content_problems(
    markdown: str,
    *,
    media_base: str,
    min_words: int,
    require_internal_links: bool = True,
) -> list[str]:
    """Everything wrong with a Markdown body, as fix-it sentences."""
    problems: list[str] = []
    if not markdown or not markdown.strip():
        return ["content_md is empty."]
    if len(markdown) > CONTENT_MAX_CHARS:
        problems.append(f"content_md is {len(markdown)} characters; the limit is {CONTENT_MAX_CHARS}.")
    prose = _strip_code(markdown)
    without_autolinks = _AUTOLINK_RE.sub(" ", prose)
    if _DANGEROUS_RE.search(without_autolinks):
        problems.append(
            "content_md contains a <script>/<iframe>/<style>/embed-type tag — remove it; raw HTML is never allowed."
        )
    elif _HTML_RE.search(without_autolinks):
        snippet = _HTML_RE.search(without_autolinks).group(0)[:40]  # type: ignore[union-attr]
        problems.append(
            f"content_md contains raw HTML (`{snippet}`) — write plain Markdown only "
            "(no tags, no <br>, no HTML comments). If you meant a literal '<', write it as '&lt;'."
        )
    if _H1_ATX_RE.search(prose) or _SETEXT_H1_RE.search(prose):
        problems.append("content_md has an H1 (`# …` or `===` underline) — the page title is the H1; start headings at `##`.")
    if not _HEADING_RE.search(prose):
        problems.append("content_md has no `##` section headings — structure the article with `##` and `###`.")
    if _REF_IMAGE_RE.search(prose):
        problems.append("Reference-style images (`![alt][ref]`) are not allowed — use `![alt](url)` inline.")
    standalone = {m.start() + (len(m.group(0)) - len(m.group(0).lstrip(" "))) for m in VISUAL_RE.finditer(prose)}
    if any(m.start() not in standalone for m in _VISUAL_ANY_RE.finditer(prose)):
        problems.append(
            "A `::visual` must stand alone on its own line, exactly as create_visual returned it: "
            "`::visual[alt text](id)`."
        )
    for alt, ref in VISUAL_RE.findall(prose):
        if not VISUAL_ID_RE.match(ref):
            problems.append(f"`::visual[…]({ref[:40]})` — the id must be the 32-character id create_visual returned.")
        if not alt.strip():
            problems.append(f"`::visual[]({ref[:40]})` has no alt text — write what the visual shows inside the brackets.")
    for alt, url in _IMAGE_RE.findall(prose):
        if url.lower().split("?")[0].endswith(".pdf"):
            problems.append(f"`{url[:120]}` is a PDF — link to it as `[text](url)`, not as an image.")
        if not media_url_ok(url, media_base):
            problems.append(
                f"Image `{url[:120]}` is not from the blog media store — use an image or video from `list_media` "
                f"(or a small `upload_image` picture); its url starts with {media_base.rstrip('/')}/. For a drawn "
                "picture use `create_visual`."
            )
        if not alt.strip():
            problems.append(f"Image `{url[:120]}` has no alt text — write `![what the image shows](url)`.")
    links = [u for _, u in _LINK_RE.findall(prose)]
    for url in links + [u for _, u in _IMAGE_RE.findall(prose)]:
        if url.strip().lower().startswith(_BAD_SCHEMES):
            problems.append(f"Link `{url[:60]}` uses a forbidden scheme — only https:// or site paths like /pricing.")
    if require_internal_links:
        internal = {u for u in links if is_internal_link(u)}
        if len(internal) < MIN_INTERNAL_LINKS:
            problems.append(
                f"content_md links to {len(internal)} page(s) of this site; at least {MIN_INTERNAL_LINKS} different "
                "internal links are required (e.g. [ดูราคา](/pricing), [ทำอะไรได้บ้าง](/scope), a /guide page)."
            )
    if min_words > 0:
        words = word_count(markdown)
        if words < min_words:
            problems.append(f"content_md has about {words} words; the minimum is {min_words}. Expand the article.")
    return problems


def faq_problems(faq: list[dict[str, str]], *, required: bool = True) -> list[str]:
    problems: list[str] = []
    if required and not FAQ_MIN <= len(faq) <= FAQ_MAX:
        problems.append(f"faq has {len(faq)} item(s); write {FAQ_MIN}–{FAQ_MAX} question/answer pairs.")
    elif len(faq) > FAQ_MAX:
        problems.append(f"faq has {len(faq)} items; the maximum is {FAQ_MAX}.")
    for i, item in enumerate(faq, start=1):
        q, a = item.get("question", ""), item.get("answer", "")
        if p := _length(f"faq[{i}].question", q, maximum=FAQ_QUESTION_MAX, minimum=5):
            problems.append(p)
        if p := _length(f"faq[{i}].answer", a, maximum=FAQ_ANSWER_MAX, minimum=10):
            problems.append(p)
        if _HTML_RE.search(f"{q} {a}"):
            problems.append(f"faq[{i}] contains HTML — answers are plain text.")
    return problems


def field_problems(
    *,
    title: str | None,
    meta_title: str | None,
    meta_description: str | None,
    excerpt: str | None,
) -> list[str]:
    checks = [
        _length("title", title, maximum=TITLE_MAX, minimum=5),
        _length("meta_title", meta_title, maximum=META_TITLE_MAX, minimum=10),
        _length("meta_description", meta_description, maximum=META_DESCRIPTION_MAX, minimum=50),
        _length("excerpt", excerpt, maximum=EXCERPT_MAX, minimum=40),
    ]
    out = [p for p in checks if p]
    for name, value in (("title", title), ("meta_title", meta_title), ("meta_description", meta_description), ("excerpt", excerpt)):
        if value and _HTML_RE.search(value):
            out.append(f"{name} contains HTML — plain text only.")
    return out
