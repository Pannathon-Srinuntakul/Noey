"""The one shared layout every transactional email is rendered through.

A template describes an email as data — subject, preheader, heading, a list of
content blocks and the footer's "why you got this" line — and ``render_email``
turns that into BOTH parts: an HTML document and a plain-text twin carrying
the same content with every link written out in full.

HTML rules (what real mail clients render):

- table layout, ``role="presentation"`` on every layout table, a 600px column
  that is 100% fluid below that (plus a ghost table for Outlook desktop);
- all base styling inline; the only ``<style>`` block holds resets, the
  mobile padding tweak and dark-mode overrides for clients that honour
  ``prefers-color-scheme`` (Apple Mail, Outlook.com via ``[data-ogsc]``);
- colours chosen to survive the clients that auto-invert instead (Gmail app):
  light card + dark text, and the button is a DARK fill with white text, which
  those clients leave alone (a gold fill with dark text gets its text
  lightened into an unreadable gold-on-gold);
- bulletproof button (a table cell with a background, not an image);
- logo as a hosted PNG (``{SITE_URL}/email/logo-96.png`` — Gmail strips inline
  SVG) with width/height/alt, and a wordmark in live text beside it so the
  header still reads with images blocked;
- a hidden preheader per email; no JavaScript, no external CSS, no web fonts.

Every value that reaches the HTML is escaped here, at render time — blocks
hold raw text. No AI vendor is ever named.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from html import escape

from packages.email.message import RenderedEmail

# ── palette (brand: dark #171614, gold #d9a441) ───────────────────────────────
PAGE_BG = "#f3f2f2"
CARD_BG = "#ffffff"
INK = "#171614"  # brand dark: headings, body text, button fill
TEXT = "#2b2926"
MUTED = "#5f5b55"  # 6.6:1 on white
GOLD = "#d9a441"  # brand accent: decoration only, never text on white
LINK = "#8a5a12"  # the gold darkened to 6.2:1 on white, for link text
BOX_BG = "#f8f4ee"
BOX_RULE = "#eadfcb"
RULE = "#e7e4e0"

FONT = (
    "-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans Thai','Sarabun',"
    "'Leelawadee UI',Tahoma,Arial,sans-serif"
)
MONO = "'SFMono-Regular',Menlo,Consolas,'Courier New',monospace"

TAGLINE = "ตัดคลิปด้วย AI"
LOGO_PATH = "/email/logo-96.png"
PRIVACY_PATH = "/privacy"
TERMS_PATH = "/terms"


@dataclass(frozen=True)
class SiteInfo:
    """Where the footer and logo point. Built from settings in production."""

    site_url: str
    support_email: str
    business_address: str | None = None

    @property
    def base(self) -> str:
        return self.site_url.strip().rstrip("/")


def site_info_from_settings() -> SiteInfo:
    from packages.core.settings import get_settings

    s = get_settings()
    address = (s.email_business_address or "").strip() or None
    return SiteInfo(site_url=s.site_url, support_email=s.support_email.strip(), business_address=address)


# ── content blocks ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Paragraph:
    text: str


@dataclass(frozen=True)
class Action:
    """The primary call to action: a button, then the same URL as copyable text."""

    label: str
    url: str


@dataclass(frozen=True)
class Code:
    """A one-time code, shown large. Text part: ``<label>: <code>``."""

    label: str
    code: str


@dataclass(frozen=True)
class Notice:
    """A highlighted note — expiry, or what to do if this was not you."""

    text: str
    title: str | None = None


@dataclass(frozen=True)
class Details:
    """Label/value rows (who sent a contact message, spend vs cap, …)."""

    rows: tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class Quote:
    """Free text someone else wrote (the contact message), line breaks kept."""

    text: str
    title: str | None = None


Block = Paragraph | Action | Code | Notice | Details | Quote


@dataclass(frozen=True)
class Email:
    subject: str
    #: The inbox preview line. Hidden in the body.
    preheader: str
    heading: str
    blocks: Sequence[Block]
    #: Footer line, specific to this email: "คุณได้รับอีเมลนี้เพราะ…".
    reason: str
    greeting: str | None = None


# ── helpers ───────────────────────────────────────────────────────────────────

_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u200e\u200f\u202a-\u202e\u2066-\u2069]")


def clean_text(value: str) -> str:
    """Drop control characters and bidi overrides from outside text (a
    right-to-left override can make a link or address read backwards)."""
    return _CONTROL.sub("", value)


def one_line(value: str, limit: int = 150) -> str:
    """Safe inside a header: no line breaks or control characters, bounded."""
    return " ".join(clean_text(value).split())[:limit]


def _e(value: str) -> str:
    return escape(value, quote=True)


def _multiline(value: str) -> str:
    return _e(value.replace("\r\n", "\n").replace("\r", "\n")).replace("\n", "<br>")


def _td(content: str, *, size: int = 16, color: str = TEXT, weight: int = 400, pad: str = "0 0 16px 0",
        cls: str = "nx-text", extra: str = "") -> str:
    return (
        f'<tr><td class="{cls}" style="padding:{pad};font-family:{FONT};font-size:{size}px;'
        f'line-height:1.7;font-weight:{weight};color:{color};{extra}">{content}</td></tr>'
    )


def _box(inner: str, *, pad: str = "16px 20px", accent: bool = True) -> str:
    left = f"border-left:4px solid {GOLD};" if accent else ""
    cls = "nx-box nx-accent" if accent else "nx-box"
    return (
        '<tr><td style="padding:0 0 20px 0;">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">'
        f'<tr><td class="{cls}" bgcolor="{BOX_BG}" style="padding:{pad};background:{BOX_BG};'
        f'border:1px solid {BOX_RULE};{left}border-radius:8px;">{inner}</td></tr></table></td></tr>'
    )


def _link(url: str, text: str | None = None) -> str:
    return (
        f'<a class="nx-link" href="{_e(url)}" style="color:{LINK};text-decoration:underline;'
        f'word-break:break-all;">{_e(text if text is not None else url)}</a>'
    )


def _button(label: str, url: str) -> str:
    href = _e(url)
    return (
        '<tr><td style="padding:8px 0 20px 0;">'
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
        f'<td class="nx-btn" align="center" bgcolor="{INK}" style="border-radius:8px;background:{INK};'
        f'mso-padding-alt:14px 28px;">'
        f'<a class="nx-btn-a" href="{href}" target="_blank" style="display:inline-block;padding:14px 28px;'
        f"font-family:{FONT};font-size:16px;line-height:1.3;font-weight:700;color:#ffffff;"
        f'text-decoration:none;border-radius:8px;">{_e(label)}</a>'
        "</td></tr></table></td></tr>"
    )


def _block_html(block: Block) -> str:
    if isinstance(block, Paragraph):
        return _td(_multiline(block.text))
    if isinstance(block, Action):
        fallback = (
            f'<div class="nx-muted" style="font-family:{FONT};font-size:13px;line-height:1.6;color:{MUTED};'
            f'padding:0 0 4px 0;">ถ้าปุ่มกดไม่ได้ ให้คัดลอกลิงก์นี้ไปเปิดในเบราว์เซอร์</div>'
            f'<div style="font-family:{FONT};font-size:13px;line-height:1.6;">{_link(block.url)}</div>'
        )
        return _button(block.label, block.url) + _box(fallback, pad="12px 16px", accent=False)
    if isinstance(block, Code):
        inner = (
            f'<div class="nx-muted" style="font-family:{FONT};font-size:13px;line-height:1.6;color:{MUTED};'
            f'text-align:center;">{_e(block.label)}</div>'
            f'<div class="nx-text nx-code" style="font-family:{MONO};font-size:34px;line-height:1.3;'
            f'font-weight:700;letter-spacing:8px;color:{INK};text-align:center;padding:6px 0 0 0;">'
            f"{_e(block.code)}</div>"
        )
        return _box(inner, pad="20px 16px", accent=False)
    if isinstance(block, Notice):
        title = (
            f'<div class="nx-text" style="font-family:{FONT};font-size:15px;line-height:1.6;font-weight:700;'
            f'color:{INK};padding:0 0 4px 0;">{_e(block.title)}</div>'
            if block.title else ""
        )
        body = (
            f'<div class="nx-text" style="font-family:{FONT};font-size:15px;line-height:1.7;color:{TEXT};">'
            f"{_multiline(block.text)}</div>"
        )
        return _box(title + body)
    if isinstance(block, Details):
        rows = "".join(
            f'<tr><td class="nx-muted" valign="top" style="padding:6px 16px 6px 0;font-family:{FONT};'
            f'font-size:14px;line-height:1.6;color:{MUTED};white-space:nowrap;">{_e(label)}</td>'
            f'<td class="nx-text" valign="top" style="padding:6px 0;font-family:{FONT};font-size:15px;'
            f'line-height:1.6;color:{INK};font-weight:600;word-break:break-word;">{_e(value)}</td></tr>'
            for label, value in block.rows
        )
        return (
            '<tr><td style="padding:0 0 20px 0;">'
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
            f'class="nx-rule" style="border-top:1px solid {RULE};border-bottom:1px solid {RULE};">'
            f"{rows}</table></td></tr>"
        )
    if isinstance(block, Quote):
        title = (
            f'<div class="nx-muted" style="font-family:{FONT};font-size:13px;line-height:1.6;color:{MUTED};'
            f'padding:0 0 6px 0;">{_e(block.title)}</div>'
            if block.title else ""
        )
        body = (
            f'<div class="nx-text" style="font-family:{FONT};font-size:15px;line-height:1.7;color:{TEXT};'
            f'word-break:break-word;">{_multiline(block.text)}</div>'
        )
        return _box(title + body)
    raise TypeError(f"unknown email block: {type(block).__name__}")


def _block_text(block: Block) -> list[str]:
    if isinstance(block, Paragraph):
        return [block.text]
    if isinstance(block, Action):
        return [f"{block.label}:\n{block.url}"]
    if isinstance(block, Code):
        return [f"{block.label}: {block.code}"]
    if isinstance(block, Notice):
        return [f"{block.title}: {block.text}" if block.title else block.text]
    if isinstance(block, Details):
        return ["\n".join(f"{label}: {value}" for label, value in block.rows)]
    if isinstance(block, Quote):
        quoted = "\n".join(f"> {line}" if line else ">" for line in block.text.replace("\r\n", "\n").split("\n"))
        return [f"{block.title}:\n{quoted}" if block.title else quoted]
    raise TypeError(f"unknown email block: {type(block).__name__}")


# ── the document ──────────────────────────────────────────────────────────────

_HEAD_STYLE = (
    "<style>"
    ":root{color-scheme:light dark;supported-color-schemes:light dark;}"
    "body{margin:0!important;padding:0!important;width:100%!important;"
    "-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}"
    "table,td{border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;}"
    "img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;}"
    "a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important;"
    "font-size:inherit!important;font-family:inherit!important;font-weight:inherit!important;"
    "line-height:inherit!important;}"
    "@media only screen and (max-width:620px){"
    ".nx-pad{padding-left:20px!important;padding-right:20px!important;}"
    ".nx-code{font-size:28px!important;letter-spacing:5px!important;}"
    "}"
    "@media (prefers-color-scheme:dark){"
    ".nx-bg{background:#171614!important;}"
    ".nx-card{background:#211f1c!important;border-color:#34312c!important;}"
    ".nx-text{color:#f3f2f2!important;}"
    ".nx-muted{color:#b5b0a8!important;}"
    ".nx-link{color:#e6b95c!important;}"
    ".nx-box{background:#2b2824!important;border-color:#3f3a33!important;}"
    ".nx-accent{border-left-color:#d9a441!important;}"
    ".nx-rule{border-color:#3a3631!important;}"
    ".nx-btn{background:#d9a441!important;}"
    ".nx-btn-a{color:#171614!important;}"
    "}"
    "[data-ogsc] .nx-text{color:#f3f2f2!important;}"
    "[data-ogsc] .nx-muted{color:#b5b0a8!important;}"
    "[data-ogsc] .nx-link{color:#e6b95c!important;}"
    "[data-ogsb] .nx-bg{background:#171614!important;}"
    "[data-ogsb] .nx-card{background:#211f1c!important;}"
    "[data-ogsb] .nx-box{background:#2b2824!important;}"
    "</style>"
)

# Spacer after the preheader so the client's preview does not run on into
# the body text.
_PREHEADER_FILLER = "&#847;&zwnj;&nbsp;" * 80


def _header(site: SiteInfo, brand: str) -> str:
    logo = f"{site.base}{LOGO_PATH}"
    return (
        '<tr><td class="nx-pad" style="padding:0 32px 20px 32px;">'
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
        f'<td width="44" height="44" bgcolor="{INK}" style="width:44px;height:44px;border-radius:10px;'
        f'background:{INK};">'
        f'<a href="{_e(site.base)}" target="_blank" style="text-decoration:none;">'
        f'<img src="{_e(logo)}" width="44" height="44" alt="{_e(brand)}" '
        f'style="display:block;width:44px;height:44px;border:0;border-radius:10px;font-family:{FONT};'
        f'font-size:10px;font-weight:700;color:{GOLD};"></a></td>'
        '<td style="padding:0 0 0 12px;">'
        f'<div class="nx-text" style="font-family:{FONT};font-size:18px;line-height:1.3;font-weight:700;'
        f'color:{INK};">{_e(brand)}</div>'
        f'<div class="nx-muted" style="font-family:{FONT};font-size:13px;line-height:1.4;color:{MUTED};">'
        f"{_e(TAGLINE)}</div></td>"
        "</tr></table></td></tr>"
    )


def _footer_html(site: SiteInfo, brand: str, reason: str) -> str:
    small = f"font-family:{FONT};font-size:12px;line-height:1.7;color:{MUTED};"
    link = f"color:{MUTED};text-decoration:underline;"
    support = _e(site.support_email)
    lines = [
        f'<div class="nx-muted" style="{small}font-weight:700;">{_e(brand)} · {_e(TAGLINE)}</div>',
        f'<div class="nx-muted" style="{small}">{_e(reason)}</div>',
        (
            f'<div class="nx-muted" style="{small}">มีคำถามหรือต้องการความช่วยเหลือ ติดต่อ '
            f'<a class="nx-muted" href="mailto:{support}" style="{link}">{support}</a></div>'
        ),
        (
            f'<div class="nx-muted" style="{small}">'
            f'<a class="nx-muted" href="{_e(site.base + PRIVACY_PATH)}" style="{link}">นโยบายความเป็นส่วนตัว</a>'
            " &nbsp;·&nbsp; "
            f'<a class="nx-muted" href="{_e(site.base + TERMS_PATH)}" style="{link}">ข้อกำหนดการใช้งาน</a>'
            " &nbsp;·&nbsp; "
            f'<a class="nx-muted" href="{_e(site.base)}" style="{link}">{_e(_host(site.base))}</a></div>'
        ),
    ]
    if site.business_address:
        lines.append(f'<div class="nx-muted" style="{small}">{_e(site.business_address)}</div>')
    return (
        '<tr><td class="nx-pad" align="left" style="padding:24px 32px 0 32px;">'
        + "".join(lines)
        + "</td></tr>"
    )


def _host(url: str) -> str:
    return url.split("://", 1)[-1]


def _footer_text(site: SiteInfo, brand: str, reason: str) -> list[str]:
    lines = [
        "-- ",
        f"{brand} · {TAGLINE}",
        reason,
        f"ติดต่อเรา: {site.support_email}",
        f"นโยบายความเป็นส่วนตัว: {site.base}{PRIVACY_PATH}",
        f"ข้อกำหนดการใช้งาน: {site.base}{TERMS_PATH}",
    ]
    if site.business_address:
        lines.append(site.business_address)
    return lines


def render_email(brand: str, email: Email, site: SiteInfo | None = None) -> RenderedEmail:
    site = site or site_info_from_settings()
    brand = one_line(brand, 60) or "Noey Studio"
    subject = one_line(email.subject)

    body_rows = []
    if email.greeting:
        body_rows.append(_td(_e(email.greeting), pad="0 0 8px 0"))
    body_rows += [_block_html(b) for b in email.blocks]

    card = (
        '<tr><td style="padding:0 16px;">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="nx-card" '
        f'bgcolor="{CARD_BG}" style="background:{CARD_BG};border:1px solid {RULE};border-radius:12px;">'
        f'<tr><td height="4" bgcolor="{GOLD}" style="height:4px;line-height:4px;font-size:0;background:{GOLD};'
        'border-radius:12px 12px 0 0;">&nbsp;</td></tr>'
        '<tr><td class="nx-pad" style="padding:32px 36px 16px 36px;">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">'
        + _td(_e(email.heading), size=24, color=INK, weight=700, pad="0 0 16px 0", extra="line-height:1.4;")
        + "".join(body_rows)
        + "</table></td></tr></table></td></tr>"
    )

    html = (
        "<!DOCTYPE html>"
        '<html lang="th" dir="ltr" xmlns="http://www.w3.org/1999/xhtml" '
        'xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">'
        "<head>"
        '<meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        '<meta http-equiv="X-UA-Compatible" content="IE=edge">'
        '<meta name="x-apple-disable-message-reformatting">'
        '<meta name="format-detection" content="telephone=no, date=no, address=no, email=no, url=no">'
        '<meta name="color-scheme" content="light dark">'
        '<meta name="supported-color-schemes" content="light dark">'
        f"<title>{_e(subject)}</title>"
        "<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch>"
        "</o:OfficeDocumentSettings></xml><![endif]-->"
        f"{_HEAD_STYLE}"
        "</head>"
        f'<body class="nx-bg" style="margin:0;padding:0;background:{PAGE_BG};">'
        f'<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;'
        f'overflow:hidden;mso-hide:all;color:{PAGE_BG};">{_e(one_line(email.preheader, 200))}'
        f"{_PREHEADER_FILLER}</div>"
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="nx-bg" '
        f'bgcolor="{PAGE_BG}" style="background:{PAGE_BG};">'
        '<tr><td align="center" style="padding:32px 0 40px 0;">'
        '<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" '
        'border="0"><tr><td><![endif]-->'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
        'style="max-width:600px;margin:0 auto;">'
        + _header(site, brand)
        + card
        + _footer_html(site, brand, email.reason)
        + "</table>"
        "<!--[if mso]></td></tr></table><![endif]-->"
        "</td></tr></table></body></html>"
    )

    parts: list[str] = [brand, "", email.heading, ""]
    if email.greeting:
        parts += [email.greeting, ""]
    for block in email.blocks:
        for chunk in _block_text(block):
            parts += [chunk, ""]
    parts += _footer_text(site, brand, email.reason)
    text = "\n".join(parts).rstrip() + "\n"
    return RenderedEmail(subject=subject, text=text, html=html)
