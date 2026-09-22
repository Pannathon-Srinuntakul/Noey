"""Thai transactional email copy: branded HTML (inline CSS) + a plain-text part.

Palette: background #f3f2f2, text #201f1d, accent #b68235. Table layout and
inline styles only — what mail clients actually render. Every dynamic value is
HTML-escaped. No AI vendor is ever named.

Links are always built from SITE_URL: `{SITE_URL}/verify-email?token=…` and
`{SITE_URL}/reset-password?token=…` (the change-email confirmation reuses the
verify page — the token carries its purpose).
"""

from dataclasses import dataclass
from html import escape
from urllib.parse import quote

from packages.email.message import RenderedEmail

BG = "#f3f2f2"
TEXT = "#201f1d"
ACCENT = "#b68235"
MUTED = "#6b6862"
CARD = "#ffffff"
RULE = "#e7e4e0"
FONT = "'Sarabun','Noto Sans Thai','Leelawadee UI',Tahoma,Arial,sans-serif"

VERIFY_PATH = "/verify-email"
RESET_PATH = "/reset-password"


def build_link(site_url: str, path: str, token: str) -> str:
    return f"{site_url.strip().rstrip('/')}{path}?token={quote(token, safe='')}"


def _one_line(value: str, limit: int = 100) -> str:
    """Safe inside a subject line: no line breaks, bounded length."""
    return " ".join(value.split())[:limit]


@dataclass(frozen=True)
class _Body:
    heading: str
    paragraphs: tuple[str, ...]
    button_label: str | None = None
    link: str | None = None
    note: str | None = None
    footer: str | None = None
    #: Pre-escaped HTML rows (the contact message); text twin in `text_rows`.
    html_rows: tuple[str, ...] = ()
    text_rows: tuple[str, ...] = ()


def _cell(content: str, *, size: int = 15, color: str = TEXT, pad: str = "12px 32px 0 32px",
          weight: int = 400, extra: str = "") -> str:
    return (
        f'<tr><td style="padding:{pad};font-family:{FONT};font-size:{size}px;line-height:1.7;'
        f'font-weight:{weight};color:{color};{extra}">{content}</td></tr>'
    )


def _render(brand: str, subject: str, body: _Body) -> RenderedEmail:
    rows = [
        _cell(escape(brand), size=15, color=ACCENT, weight=700, pad="28px 32px 0 32px",
              extra="letter-spacing:.02em;"),
        _cell(escape(body.heading), size=22, weight=700),
    ]
    rows += [_cell(escape(p)) for p in body.paragraphs]
    rows += list(body.html_rows)
    if body.button_label and body.link:
        href = escape(body.link, quote=True)
        rows.append(
            '<tr><td style="padding:24px 32px 0 32px;">'
            f'<a href="{href}" style="display:inline-block;background:{ACCENT};color:#ffffff;'
            f"text-decoration:none;font-family:{FONT};font-size:15px;font-weight:700;"
            f'padding:12px 24px;border-radius:8px;">{escape(body.button_label)}</a></td></tr>'
        )
    if body.note:
        rows.append(_cell(escape(body.note), size=13, color=MUTED, pad="16px 32px 0 32px"))
    if body.link:
        href = escape(body.link, quote=True)
        rows.append(_cell(
            "ถ้าปุ่มกดไม่ได้ ให้คัดลอกลิงก์นี้ไปเปิดในเบราว์เซอร์:<br>"
            f'<a href="{href}" style="color:{ACCENT};word-break:break-all;">{href}</a>',
            size=13, color=MUTED, pad="12px 32px 0 32px",
        ))
    if body.footer:
        rows.append(_cell(escape(body.footer), size=13, color=MUTED, pad="24px 32px 0 32px"))
    rows.append('<tr><td style="padding:28px 0 0 0;"></td></tr>')

    html = (
        '<!doctype html><html lang="th"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<meta name="color-scheme" content="light only">'
        f"<title>{escape(subject)}</title></head>"
        f'<body style="margin:0;padding:0;background:{BG};">'
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{BG};">'
        '<tr><td align="center" style="padding:32px 16px;">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="max-width:560px;background:{CARD};border-radius:12px;border:1px solid {RULE};">'
        + "".join(rows)
        + "</table></td></tr></table></body></html>"
    )

    lines = [brand, "", body.heading, ""]
    for p in body.paragraphs:
        lines += [p, ""]
    for row in body.text_rows:
        lines += [row, ""]
    if body.button_label and body.link:
        lines += [f"{body.button_label}: {body.link}", ""]
    if body.note:
        lines += [body.note, ""]
    if body.footer:
        lines += ["--", body.footer]
    return RenderedEmail(subject=subject, text="\n".join(lines).rstrip() + "\n", html=html)


def verify_email(*, brand: str, link: str, display_name: str | None) -> RenderedEmail:
    greeting = f"สวัสดี {display_name}" if display_name else "สวัสดี"
    return _render(brand, f"ยืนยันอีเมลของคุณ — {brand}", _Body(
        heading="ยืนยันอีเมลของคุณ",
        paragraphs=(
            greeting,
            (
                f"ขอบคุณที่สมัครใช้งาน {brand} กดปุ่มด้านล่างเพื่อยืนยันว่าอีเมลนี้เป็นของคุณ "
                "แล้วเริ่มใช้เครื่องมือตัดต่อด้วย AI ได้ทันที"
            ),
        ),
        button_label="ยืนยันอีเมล",
        link=link,
        note="ลิงก์นี้ใช้ได้ครั้งเดียว และหมดอายุใน 48 ชั่วโมง",
        footer=f"หากคุณไม่ได้สมัครใช้งาน {brand} ไม่ต้องทำอะไร บัญชีจะไม่ถูกยืนยันถ้าไม่มีการกดลิงก์นี้",
    ))


def reset_password(*, brand: str, link: str) -> RenderedEmail:
    return _render(brand, f"ตั้งรหัสผ่านใหม่ — {brand}", _Body(
        heading="ตั้งรหัสผ่านใหม่",
        paragraphs=(
            (
                f"เราได้รับคำขอตั้งรหัสผ่านใหม่สำหรับบัญชี {brand} ที่ใช้อีเมลนี้ "
                "กดปุ่มด้านล่างเพื่อตั้งรหัสผ่านใหม่"
            ),
            "เมื่อตั้งรหัสผ่านใหม่แล้ว ทุกอุปกรณ์ที่ล็อกอินค้างไว้จะถูกออกจากระบบ",
        ),
        button_label="ตั้งรหัสผ่านใหม่",
        link=link,
        note="ลิงก์นี้ใช้ได้ครั้งเดียว และหมดอายุใน 60 นาที",
        footer="หากคุณไม่ได้ขอตั้งรหัสผ่านใหม่ ไม่ต้องทำอะไร รหัสผ่านเดิมของคุณยังใช้ได้ตามปกติ",
    ))


def change_email_confirm(*, brand: str, link: str, new_email: str) -> RenderedEmail:
    return _render(brand, f"ยืนยันอีเมลใหม่ของบัญชี — {brand}", _Body(
        heading="ยืนยันอีเมลใหม่",
        paragraphs=(
            (
                f"มีคำขอเปลี่ยนอีเมลที่ใช้เข้าสู่ระบบ {brand} มาเป็น {new_email} "
                "กดปุ่มด้านล่างเพื่อยืนยัน"
            ),
            "อีเมลของบัญชีจะเปลี่ยนหลังจากกดยืนยันเท่านั้น",
        ),
        button_label="ยืนยันอีเมลใหม่",
        link=link,
        note="ลิงก์นี้ใช้ได้ครั้งเดียว และหมดอายุใน 24 ชั่วโมง",
        footer="หากคุณไม่ได้ขอเปลี่ยนอีเมล ไม่ต้องทำอะไร อีเมลของบัญชีจะไม่เปลี่ยน",
    ))


def change_email_notice(*, brand: str, new_email: str) -> RenderedEmail:
    return _render(brand, f"มีคำขอเปลี่ยนอีเมลของบัญชีคุณ — {brand}", _Body(
        heading="มีคำขอเปลี่ยนอีเมลของบัญชี",
        paragraphs=(
            f"มีคำขอเปลี่ยนอีเมลที่ใช้เข้าสู่ระบบ {brand} จากอีเมลนี้ไปเป็น {new_email}",
            (
                "การเปลี่ยนจะเกิดขึ้นก็ต่อเมื่อมีการกดยืนยันจากอีเมลใหม่เท่านั้น "
                "ถ้าเป็นคุณเอง ไม่ต้องทำอะไรเพิ่ม"
            ),
        ),
        note="ถ้าคุณไม่ได้ทำรายการนี้ ให้เปลี่ยนรหัสผ่านทันที — คำขอนี้ต้องใช้รหัสผ่านปัจจุบันของบัญชีคุณ",
        footer=f"อีเมลนี้ส่งถึงเจ้าของบัญชี {brand} เพื่อความปลอดภัยของบัญชี",
    ))


def contact_message(*, brand: str, name: str, email: str, message: str) -> RenderedEmail:
    body_html = escape(message).replace("\r\n", "\n").replace("\n", "<br>")
    return _render(brand, f"[{brand}] ข้อความจากฟอร์มติดต่อ — {_one_line(name)}", _Body(
        heading="ข้อความใหม่จากฟอร์มติดต่อ",
        paragraphs=(f"ชื่อ: {name}", f"อีเมล: {email}"),
        html_rows=(
            (
                '<tr><td style="padding:16px 32px 0 32px;">'
                f'<div style="border-left:3px solid {ACCENT};padding:4px 0 4px 16px;'
                f'font-family:{FONT};font-size:15px;line-height:1.7;color:{TEXT};">{body_html}</div>'
                "</td></tr>"
            ),
        ),
        text_rows=(message,),
        footer="กดตอบกลับอีเมลนี้เพื่อตอบผู้ติดต่อได้โดยตรง",
    ))


def admin_login_code(*, brand: str, code: str, ip: str | None) -> RenderedEmail:
    """The one-time code for the admin dashboard. The code is digits only."""
    where = f" จาก IP {ip}" if ip else ""
    code_html = (
        f'<tr><td style="padding:20px 32px 0 32px;font-family:{FONT};font-size:32px;'
        f'font-weight:700;letter-spacing:.3em;color:{TEXT};">{escape(code)}</td></tr>'
    )
    return _render(brand, f"รหัสเข้าสู่แผงผู้ดูแลระบบ — {brand}", _Body(
        heading="รหัสเข้าสู่แผงผู้ดูแลระบบ",
        paragraphs=(f"มีการเข้าสู่ระบบแผงผู้ดูแล {brand} ด้วยบัญชีนี้{where} กรอกรหัสด้านล่างเพื่อยืนยัน",),
        html_rows=(code_html,),
        text_rows=(f"รหัส: {code}",),
        note="รหัสนี้ใช้ได้ครั้งเดียว และหมดอายุใน 10 นาที อย่าบอกรหัสนี้กับใคร",
        footer="ถ้าคุณไม่ได้เข้าสู่ระบบ ให้เปลี่ยนรหัสผ่านทันที เพราะมีคนรู้รหัสผ่านของคุณ",
    ))


def circuit_breaker_tripped(*, brand: str, day: str, spend_thb: float, cap_thb: float) -> RenderedEmail:
    """Admin alert: today's AI spend reached the daily circuit-breaker cap and
    new AI jobs are paused (packages/billing/guard.py)."""
    return _render(brand, f"งาน AI ถูกหยุดชั่วคราว: ถึงเพดานค่าใช้จ่ายรายวัน — {brand}", _Body(
        heading="ถึงเพดานค่าใช้จ่าย AI รายวันแล้ว",
        paragraphs=(
            f"ค่าใช้จ่าย AI วันที่ {escape(day)} (UTC) ถึง ฿{spend_thb:,.2f} "
            f"จากเพดาน ฿{cap_thb:,.2f} ระบบหยุดรับงาน AI ใหม่ของลูกค้าแล้ว",
            "งานที่เริ่มไปแล้วยังทำต่อได้จนกว่าจะเกินเพดานมากกว่าที่ตั้งไว้ "
            "ปรับเพดานหรือปิดการหยุดอัตโนมัติได้ที่แผงผู้ดูแลระบบ",
        ),
        note="แจ้งเตือนนี้ส่งครั้งเดียวต่อวัน",
    ))
