"""Blog content and image checks — pure functions, no database."""

from __future__ import annotations

import base64
import io

import pytest
from PIL import Image

from packages.blog import media
from packages.blog import validation as v

BASE = "https://media.noeystudio.com"


def _body(words: int = 0, extra: str = "") -> str:
    return "## หัวข้อ\n\nอ่าน [ราคา](/pricing) และ [ขอบเขต](https://noeystudio.com/scope) " + ("คำ " * words) + extra


def _problems(md: str, *, min_words: int = 0) -> list[str]:
    return v.content_problems(md, media_base=BASE, min_words=min_words)


@pytest.mark.parametrize("slug", ["thai-subtitles-tiktok-tips", "a", "a1-b2"])
def test_good_slugs(slug):
    assert v.slug_problem(slug) is None


@pytest.mark.parametrize("slug", ["", "Thai", "ซับไทย", "a_b", "-a", "a-", "a--b", "a b", "x" * 81])
def test_bad_slugs(slug):
    assert v.slug_problem(slug)


def test_contract_lengths():
    ok = v.field_problems(title="ชื่อบทความยาวพอ", meta_title="m" * 60, meta_description="d" * 160, excerpt="e" * 300)
    assert ok == []
    bad = v.field_problems(title="ชื่อบทความยาวพอ", meta_title="m" * 61, meta_description="d" * 161, excerpt="e" * 301)
    assert len(bad) == 3 and all("limit" in p for p in bad)


def test_clean_markdown_passes():
    assert _problems(_body(extra="\n\n### ย่อย\n\n- ข้อ\n\n![ภาพ](https://media.noeystudio.com/blog/abc.webp)")) == []


def test_code_blocks_may_show_html():
    md = _body() + "\n\n```html\n<script>alert(1)</script>\n```\n\nใช้ `<div>` ได้ในโค้ด"
    assert _problems(md) == []


@pytest.mark.parametrize(
    "snippet,needle",
    [
        ("<script>alert(1)</script>", "script"),
        ("<iframe src=x></iframe>", "iframe"),
        ("<IFRAME src=x>", "iframe"),
        ("<div>hi</div>", "raw HTML"),
        ("<br>", "raw HTML"),
        ("<!-- c -->", "raw HTML"),
        ("<img src=x onerror=alert(1)>", "raw HTML"),
    ],
)
def test_raw_html_is_refused(snippet, needle):
    found = " ".join(_problems(_body(extra=snippet)))
    assert needle in found


def test_autolinks_are_not_html():
    assert _problems(_body(extra="<https://noeystudio.com/guide>")) == []


def test_headings_start_at_h2():
    assert any("H1" in p for p in _problems("# ชื่อ\n\n" + _body()))
    assert any("H1" in p for p in _problems("ชื่อ\n===\n\n" + _body()))
    assert any("no `##`" in p for p in _problems("อ่าน [ก](/pricing) [ข](/scope) เนื้อหา"))


def test_images_must_come_from_the_media_store():
    p = _problems(_body(extra="![x](https://evil.example/a.png)"))
    assert any("upload_image" in x for x in p)
    p = _problems(_body(extra="![](https://media.noeystudio.com/blog/a.webp)"))
    assert any("alt" in x for x in p)
    p = _problems(_body(extra="![x](https://media.noeystudio.com/blog/../../etc)"))
    assert any("upload_image" in x for x in p)
    p = _problems(_body(extra="![x][ref]\n\n[ref]: https://evil.example/a.png"))
    assert any("Reference-style" in x for x in p)


def test_dangerous_link_schemes():
    assert any("forbidden scheme" in p for p in _problems(_body(extra="[x](javascript:alert(1))")))


def test_internal_links_required():
    md = "## หัวข้อ\n\nไม่มีลิงก์ภายใน [ภายนอก](https://example.com)"
    assert any("internal links" in p for p in _problems(md))
    assert v.is_internal_link("/guide/help") and v.is_internal_link("https://www.noeystudio.com/x")
    assert not v.is_internal_link("//evil.example") and not v.is_internal_link("https://noeystudio.com.evil.example/")


def test_thai_word_count_and_minimum():
    md = _body(words=0, extra="การตัดคลิปสั้นให้น่าดูต้องเริ่มจากการเลือกช็อตที่ชัดเจน " * 50)
    n = v.word_count(md)
    assert 400 < n < 800  # Thai is segmented, not split on spaces
    assert any("minimum" in p for p in _problems(md, min_words=n + 1))
    assert not any("minimum" in p for p in _problems(md, min_words=n))
    assert v.reading_minutes(md) == max(1, -(-n // v.WORDS_PER_MINUTE))


def test_vendor_names_are_banned():
    assert v.banned_terms(["ใช้ Gemini ตัดคลิป", "ChatGPT", "eleven labs", "เจมิไน"]) == ["chatgpt", "eleven labs", "gemini", "เจมิไน"]
    assert v.banned_terms(["Google ค้นหา", "claudette"]) == []


def test_faq_rules():
    good = [{"question": f"คำถามที่ {i}", "answer": "คำตอบแบบข้อความล้วน"} for i in range(3)]
    assert v.faq_problems(good) == []
    assert v.faq_problems(good[:2])
    assert v.faq_problems(good * 3)
    assert v.faq_problems([*good[:2], {"question": "คำถามมี html", "answer": "<b>ตัวหนา</b> คำตอบ"}])


def test_tag_slugs_normalise():
    assert v.slugify_tag("Thai Subtitles!") == "thai-subtitles"
    assert v.slugify_tag("ซับไทย") == ""


# ── images ───────────────────────────────────────────────────────────────────


def _png(w: int, h: int, *, exif: bool = False) -> bytes:
    img = Image.new("RGB", (w, h), (10, 200, 30))
    out = io.BytesIO()
    if exif:
        e = Image.Exif()
        e[0x010F] = "SecretCamera"  # Make
        e[0x8825] = {2: (13.0, 45.0, 0.0)}  # GPS
        img.save(out, format="JPEG", exif=e.tobytes())
    else:
        img.save(out, format="PNG")
    return out.getvalue()


def test_magic_bytes_decide_the_type():
    assert media.sniff(_png(4, 4)) == "png"
    assert media.sniff(_png(4, 4, exif=True)) == "jpeg"
    assert media.sniff(b"GIF89a....") is None
    assert media.sniff(b"<svg xmlns='http://www.w3.org/2000/svg'/>") is None


def test_reencode_strips_metadata_and_resizes():
    data = _png(3000, 1500, exif=True)
    assert b"SecretCamera" in data
    out, w, h = media.reencode(data)
    assert (w, h) == (1600, 800)
    assert out[:4] == b"RIFF" and out[8:12] == b"WEBP"
    assert b"SecretCamera" not in out and b"Exif" not in out
    with Image.open(io.BytesIO(out)) as img:
        assert not img.info.get("exif") and not img.getexif()


@pytest.mark.parametrize(
    "payload,needle",
    [
        (b"GIF89a" + b"\0" * 100, "Only PNG"),
        (b"%PDF-1.7 fake", "Only PNG"),
        (b"\x89PNG\r\n\x1a\n" + b"garbage" * 10, "could not be decoded"),
        (b"<svg onload=alert(1)>", "Only PNG"),
    ],
)
def test_fake_or_broken_files_are_refused(payload, needle):
    with pytest.raises(media.ImageRejected, match=needle):
        media.reencode(payload)


def test_too_many_pixels_is_refused():
    with pytest.raises(media.ImageRejected, match="4096"):
        media.reencode(_png(4097, 10))


def test_base64_limits():
    with pytest.raises(media.ImageRejected, match="8 MB"):
        media.decode_base64("A" * (12 * 1024 * 1024))
    with pytest.raises(media.ImageRejected, match="base64"):
        media.decode_base64("not base64 !!!")
    raw = _png(2, 2)
    assert media.decode_base64("data:image/png;base64," + base64.b64encode(raw).decode()) == raw


def test_media_url_containment():
    assert v.media_url_ok("https://media.noeystudio.com/blog/a.webp", BASE)
    assert not v.media_url_ok("https://media.noeystudio.com.evil.example/blog/a.webp", BASE)
    assert not v.media_url_ok("https://media.noeystudio.com/blog/../x", BASE)
    assert not v.media_url_ok("https://x/a.webp", "")
