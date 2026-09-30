"""Every transactional email goes through the one shared layout — structural
checks, no snapshots: both parts, preheader, logo, footer, escaping, links."""

import re
from html.parser import HTMLParser

import pytest

from packages.email import templates
from packages.email.layout import SiteInfo, render_email
from packages.email.message import RenderedEmail

SITE = SiteInfo(site_url="https://www.noeystudio.com/", support_email="support@noeystudio.com")
BASE = "https://www.noeystudio.com"
BRAND = "Noey Studio"
EVIL = '<script>alert("x")</script><img src=x onerror=alert(1)>'
VERIFY = f"{BASE}/verify-email?token=tok_V-1"
RESET = f"{BASE}/reset-password?token=tok_R-2"
CHANGE = f"{BASE}/verify-email?token=tok_C-3"
VENDORS = re.compile(r"gemini|google ai|anthropic|claude|openai|gpt|elevenlabs|twelve ?labs", re.IGNORECASE)


def _all() -> dict[str, tuple[RenderedEmail, str | None]]:
    """name → (rendered, the action URL or code the text part must carry)."""
    return {
        "verify_email": (templates.verify_email(brand=BRAND, link=VERIFY, display_name=EVIL, site=SITE), VERIFY),
        "reset_password": (templates.reset_password(brand=BRAND, link=RESET, site=SITE), RESET),
        "change_email_confirm": (
            templates.change_email_confirm(brand=BRAND, link=CHANGE, new_email=f"{EVIL}@x.com", site=SITE), CHANGE,
        ),
        "change_email_notice": (
            templates.change_email_notice(brand=BRAND, new_email=f"{EVIL}@x.com", site=SITE), None,
        ),
        "account_deleted": (templates.account_deleted(brand=BRAND, site=SITE), None),
        "contact_message": (
            templates.contact_message(brand=BRAND, name=EVIL, email="eve@example.com", message=f"hi\n{EVIL}", site=SITE),
            None,
        ),
        "admin_login_code": (templates.admin_login_code(brand=BRAND, code="482913", ip="203.0.113.9", site=SITE), "482913"),
        "circuit_breaker_tripped": (
            templates.circuit_breaker_tripped(brand=BRAND, day="2026-09-30", spend_thb=1234.5, cap_thb=1000, site=SITE),
            None,
        ),
    }


RENDERED = _all()
NAMES = sorted(RENDERED)


class _Tags(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.tags: list[tuple[str, dict[str, str | None]]] = []

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))


def _tags(html: str) -> list[tuple[str, dict[str, str | None]]]:
    p = _Tags()
    p.feed(html)
    return p.tags


@pytest.mark.parametrize("name", NAMES)
def test_both_parts_and_document_basics(name):
    r, _ = RENDERED[name]
    assert r.subject and r.text.strip() and r.html.startswith("<!DOCTYPE html>")
    assert re.search(r"[฀-๿]", r.subject)
    assert "\n" not in r.subject and "\r" not in r.subject
    assert len(r.subject) <= 150 and not re.search(r"[!?]{2,}", r.subject)
    h = r.html
    assert '<html lang="th" dir="ltr"' in h
    assert '<meta name="color-scheme" content="light dark">' in h
    assert '<meta name="supported-color-schemes" content="light dark">' in h
    assert "max-width:600px" in h
    assert "<script" not in h.lower() and "javascript:" not in h.lower()
    assert '<link' not in h and "@import" not in h and "@font-face" not in h
    assert not VENDORS.search(r.subject + h + r.text)
    # Every layout table is presentational.
    tables = [a for t, a in _tags(h) if t == "table"]
    assert tables and all(a.get("role") == "presentation" for a in tables)


@pytest.mark.parametrize("name", NAMES)
def test_preheader_logo_and_footer(name):
    r, _ = RENDERED[name]
    h = r.html
    assert re.search(r'<div style="display:none;[^"]*mso-hide:all;[^"]*">[^<&]+', h), "hidden preheader"
    imgs = [a for t, a in _tags(h) if t == "img"]
    assert imgs == [imgs[0]]
    logo = imgs[0]
    assert logo["src"] == f"{BASE}/email/logo-96.png"
    assert logo["alt"] == BRAND and logo["width"] == "44" and logo["height"] == "44"
    # With images blocked the header still names the product in live text.
    assert f">{BRAND}</div>" in h
    for part in (h, r.text):
        assert "คุณได้รับอีเมลนี้เพราะ" in part
        assert "support@noeystudio.com" in part
    assert f'href="{BASE}/privacy"' in h and f'href="{BASE}/terms"' in h
    assert f"{BASE}/privacy" in r.text and f"{BASE}/terms" in r.text
    assert "unsubscribe" not in (h + r.text).lower()


@pytest.mark.parametrize("name", NAMES)
def test_no_unreplaced_placeholders(name):
    r, _ = RENDERED[name]
    body = re.sub(r"<style>.*?</style>", "", r.html, flags=re.DOTALL)  # CSS braces are not placeholders
    for part in (r.subject, r.text, body):
        assert not re.search(r"\{[a-z_]+\}|\{\{|\}\}|\bNone\b|\$\{", part), part[:200]


@pytest.mark.parametrize("name", NAMES)
def test_action_url_or_code_is_in_both_parts(name):
    r, target = RENDERED[name]
    if target is None:
        return
    assert target in r.text
    if target.startswith("http"):
        # A bulletproof (table-cell) button AND the same URL as copyable text.
        assert r.html.count(f'href="{target}"') == 2
        assert f">{target}</a>" in r.html
        assert re.search(r'<td class="nx-btn"[^>]*bgcolor=', r.html)
    else:
        assert f">{target}</div>" in r.html


@pytest.mark.parametrize("name", NAMES)
def test_user_input_is_escaped(name):
    r, _ = RENDERED[name]
    assert "<script>" not in r.html and "<img src=x" not in r.html
    if name in {"verify_email", "change_email_confirm", "change_email_notice", "contact_message"}:
        assert "&lt;script&gt;" in r.html


def test_security_emails_state_expiry_and_what_if_not_you():
    expect = {
        "verify_email": "48 ชั่วโมง",
        "reset_password": "60 นาที",
        "change_email_confirm": "24 ชั่วโมง",
        "admin_login_code": "10 นาที",
    }
    for name, expiry in expect.items():
        r, _ = RENDERED[name]
        assert expiry in r.text and expiry in r.html
    for name in ("verify_email", "reset_password", "change_email_confirm", "change_email_notice",
                 "account_deleted", "admin_login_code"):
        r, _ = RENDERED[name]
        assert "ถ้าไม่ใช่คุณ" in r.text or "ถ้าคุณไม่ได้" in r.text, name


def test_admin_code_stays_out_of_the_preview_line():
    r, _ = RENDERED["admin_login_code"]
    preheader = re.search(r'mso-hide:all;[^"]*">([^&<]+)', r.html).group(1)
    assert "482913" not in preheader
    assert re.search(r"รหัส: (\d{6})", r.text)  # tests/admin_helpers.py reads it this way


def test_contact_relay_cannot_inject_html_or_headers():
    r = templates.contact_message(
        brand=BRAND, name="Eve\r\nBcc: x@evil.com\u202e", email="eve@example.com",
        message='<a href="https://evil.example">click</a>\n<style>*{display:none}</style>', site=SITE,
    )
    assert "\n" not in r.subject and "\r" not in r.subject and "\u202e" not in r.subject
    assert "<a href=\"https://evil.example\"" not in r.html and "<style>*" not in r.html
    assert "&lt;a href=&quot;https://evil.example&quot;&gt;" in r.html
    assert "evil.example" in r.text  # the plain part is text/plain: shown verbatim, harmless
    assert "\u202e" not in r.html and "\u202e" not in r.text


def test_business_address_only_when_set():
    assert "Bangkok" not in RENDERED["reset_password"][0].html
    site = SiteInfo(site_url=BASE, support_email="help@example.com", business_address="1 Road, Bangkok 10110")
    r = templates.reset_password(brand=BRAND, link=RESET, site=site)
    assert "1 Road, Bangkok 10110" in r.html and "1 Road, Bangkok 10110" in r.text
    assert "help@example.com" in r.html and "support@noeystudio.com" not in r.html


def test_site_url_comes_from_settings_when_not_passed(monkeypatch):
    from packages.core import settings as settings_mod

    real = settings_mod.get_settings()
    fake = real.model_copy(update={"site_url": "https://site.example.test", "support_email": "s@example.test"})
    monkeypatch.setattr(settings_mod, "get_settings", lambda: fake)
    r = templates.account_deleted(brand=BRAND)
    assert 'src="https://site.example.test/email/logo-96.png"' in r.html
    assert "s@example.test" in r.text


def test_unknown_block_is_rejected():
    from packages.email.layout import Email

    with pytest.raises(TypeError):
        render_email(BRAND, Email(subject="s", preheader="p", heading="h", blocks=(object(),), reason="r"), SITE)  # type: ignore[arg-type]
