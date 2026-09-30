"""Thai transactional email copy, one function per email.

Each function only describes its email (subject, preheader, heading, content
blocks, the footer's reason line); ``layout.render_email`` owns every byte of
HTML and the plain-text twin, so all emails share one header, card and footer.
Values are passed RAW — the layout escapes them. No AI vendor is ever named.

Links are always built from SITE_URL: `{SITE_URL}/verify-email?token=…` and
`{SITE_URL}/reset-password?token=…` (the change-email confirmation reuses the
verify page — the token carries its purpose).

Every template takes an optional ``site`` (footer/logo URLs); unset → read
from settings. Tests and the preview script pass one explicitly.
"""

from urllib.parse import quote

from packages.email.layout import (
    Action,
    Code,
    Details,
    Email,
    Notice,
    Paragraph,
    Quote,
    SiteInfo,
    clean_text,
    one_line,
    render_email,
)
from packages.email.message import RenderedEmail

VERIFY_PATH = "/verify-email"
RESET_PATH = "/reset-password"

NOT_YOU = "ถ้าไม่ใช่คุณ"


def build_link(site_url: str, path: str, token: str) -> str:
    return f"{site_url.strip().rstrip('/')}{path}?token={quote(token, safe='')}"


def verify_email(
    *, brand: str, link: str, display_name: str | None, site: SiteInfo | None = None
) -> RenderedEmail:
    return render_email(brand, Email(
        subject=f"ยืนยันอีเมลของคุณ — {brand}",
        preheader=f"กดยืนยันอีเมลเพื่อเริ่มใช้ {brand} ลิงก์หมดอายุใน 48 ชั่วโมง",
        heading="ยืนยันอีเมลของคุณ",
        greeting=f"สวัสดี {display_name}" if display_name else "สวัสดี",
        blocks=(
            Paragraph(
                f"ขอบคุณที่สมัครใช้งาน {brand} กดปุ่มด้านล่างเพื่อยืนยันว่าอีเมลนี้เป็นของคุณ "
                "แล้วเริ่มใช้เครื่องมือตัดต่อด้วย AI ได้ทันที"
            ),
            Action("ยืนยันอีเมล", link),
            Notice("ลิงก์นี้ใช้ได้ครั้งเดียว และหมดอายุใน 48 ชั่วโมง"),
            Paragraph(
                f"{NOT_YOU}: หากคุณไม่ได้สมัครใช้งาน {brand} ไม่ต้องทำอะไร "
                "บัญชีจะไม่ถูกยืนยันถ้าไม่มีการกดลิงก์นี้"
            ),
        ),
        reason=f"คุณได้รับอีเมลนี้เพราะมีการใช้อีเมลนี้สมัครบัญชี {brand}",
    ), site)


def reset_password(*, brand: str, link: str, site: SiteInfo | None = None) -> RenderedEmail:
    return render_email(brand, Email(
        subject=f"ตั้งรหัสผ่านใหม่ — {brand}",
        preheader="ลิงก์ตั้งรหัสผ่านใหม่ของคุณ ใช้ได้ครั้งเดียวภายใน 60 นาที",
        heading="ตั้งรหัสผ่านใหม่",
        blocks=(
            Paragraph(
                f"เราได้รับคำขอตั้งรหัสผ่านใหม่สำหรับบัญชี {brand} ที่ใช้อีเมลนี้ "
                "กดปุ่มด้านล่างเพื่อตั้งรหัสผ่านใหม่"
            ),
            Action("ตั้งรหัสผ่านใหม่", link),
            Notice(
                "ลิงก์นี้ใช้ได้ครั้งเดียว และหมดอายุใน 60 นาที\n"
                "เมื่อตั้งรหัสผ่านใหม่แล้ว ทุกอุปกรณ์ที่ล็อกอินค้างไว้จะถูกออกจากระบบ"
            ),
            Paragraph(
                f"{NOT_YOU}: หากคุณไม่ได้ขอตั้งรหัสผ่านใหม่ ไม่ต้องทำอะไร "
                "รหัสผ่านเดิมของคุณยังใช้ได้ตามปกติ และอย่าส่งต่ออีเมลนี้ให้ใคร"
            ),
        ),
        reason=f"คุณได้รับอีเมลนี้เพราะมีคำขอตั้งรหัสผ่านใหม่สำหรับบัญชี {brand} ที่ใช้อีเมลนี้",
    ), site)


def change_email_confirm(
    *, brand: str, link: str, new_email: str, site: SiteInfo | None = None
) -> RenderedEmail:
    return render_email(brand, Email(
        subject=f"ยืนยันอีเมลใหม่ของบัญชี — {brand}",
        preheader="กดยืนยันเพื่อเปลี่ยนอีเมลเข้าสู่ระบบมาเป็นอีเมลนี้ ลิงก์หมดอายุใน 24 ชั่วโมง",
        heading="ยืนยันอีเมลใหม่",
        blocks=(
            Paragraph(f"มีคำขอเปลี่ยนอีเมลที่ใช้เข้าสู่ระบบ {brand} มาเป็นอีเมลนี้"),
            Details(rows=(("อีเมลใหม่", new_email),)),
            Paragraph("อีเมลของบัญชีจะเปลี่ยนหลังจากกดยืนยันเท่านั้น"),
            Action("ยืนยันอีเมลใหม่", link),
            Notice("ลิงก์นี้ใช้ได้ครั้งเดียว และหมดอายุใน 24 ชั่วโมง"),
            Paragraph(f"{NOT_YOU}: หากคุณไม่ได้ขอเปลี่ยนอีเมล ไม่ต้องทำอะไร อีเมลของบัญชีจะไม่เปลี่ยน"),
        ),
        reason=f"คุณได้รับอีเมลนี้เพราะมีคำขอเปลี่ยนอีเมลของบัญชี {brand} มาเป็นอีเมลนี้",
    ), site)


def change_email_notice(*, brand: str, new_email: str, site: SiteInfo | None = None) -> RenderedEmail:
    return render_email(brand, Email(
        subject=f"มีคำขอเปลี่ยนอีเมลของบัญชีคุณ — {brand}",
        preheader="แจ้งเพื่อความปลอดภัย: มีคำขอเปลี่ยนอีเมลเข้าสู่ระบบของบัญชีคุณ",
        heading="มีคำขอเปลี่ยนอีเมลของบัญชี",
        blocks=(
            Paragraph(f"มีคำขอเปลี่ยนอีเมลที่ใช้เข้าสู่ระบบ {brand} จากอีเมลนี้ไปเป็น"),
            Details(rows=(("อีเมลใหม่", new_email),)),
            Paragraph(
                "การเปลี่ยนจะเกิดขึ้นก็ต่อเมื่อมีการกดยืนยันจากอีเมลใหม่ภายใน 24 ชั่วโมงเท่านั้น "
                "ถ้าเป็นคุณเอง ไม่ต้องทำอะไรเพิ่ม"
            ),
            Notice(
                "ให้เปลี่ยนรหัสผ่านทันที — คำขอนี้ต้องใช้รหัสผ่านปัจจุบันของบัญชีคุณ "
                "แล้วติดต่อทีมงานตามอีเมลด้านล่าง",
                title=NOT_YOU,
            ),
        ),
        reason=f"คุณได้รับอีเมลนี้เพราะอีเมลนี้เป็นอีเมลปัจจุบันของบัญชี {brand} เราแจ้งทุกครั้งที่มีคำขอเปลี่ยนอีเมล",
    ), site)


def account_deleted(*, brand: str, site: SiteInfo | None = None) -> RenderedEmail:
    """Sent to the address the account HAD, after it was deleted."""
    return render_email(brand, Email(
        subject=f"บัญชีของคุณถูกลบแล้ว — {brand}",
        preheader=f"บัญชี {brand} ที่ใช้อีเมลนี้ถูกลบตามคำขอของคุณแล้ว",
        heading="ลบบัญชีเรียบร้อยแล้ว",
        blocks=(
            Paragraph(f"บัญชี {brand} ที่ใช้อีเมลนี้ถูกลบตามคำขอของคุณแล้ว"),
            Paragraph(
                "โปรเจกต์ ไฟล์วิดีโอบนเซิร์ฟเวอร์ และข้อมูลส่วนตัวของบัญชีถูกลบทั้งหมด "
                "และการสมัครสมาชิกแบบรายเดือน (ถ้ามี) ถูกยกเลิกทันที"
            ),
            Paragraph(
                "เราเก็บเฉพาะบันทึกทางบัญชี (ประวัติการชำระเงินและการใช้งาน) "
                "ในรูปแบบที่ไม่ระบุตัวตน ตามที่กฎหมายกำหนด"
            ),
            Notice(
                "ถ้าคุณไม่ได้เป็นคนลบบัญชีนี้ กรุณาติดต่อเราทันทีโดยตอบกลับอีเมลนี้ "
                "หรือเขียนถึงอีเมลฝ่ายช่วยเหลือด้านล่าง",
                title=NOT_YOU,
            ),
        ),
        reason=(
            f"คุณได้รับอีเมลนี้เพราะอีเมลนี้เคยเป็นอีเมลของบัญชี {brand} ที่เพิ่งถูกลบ "
            "และเป็นอีเมลสุดท้ายที่เราจะส่งถึงบัญชีนี้"
        ),
    ), site)


def contact_message(
    *, brand: str, name: str, email: str, message: str, site: SiteInfo | None = None
) -> RenderedEmail:
    # Visitor-controlled: stripped of control/bidi characters here, escaped by
    # the layout, and kept to one bounded line in the subject.
    name, email, message = clean_text(name), clean_text(email), clean_text(message)
    return render_email(brand, Email(
        subject=f"[{brand}] ข้อความจากฟอร์มติดต่อ — {one_line(name, 100)}",
        preheader=f"จาก {one_line(name, 60)}: {one_line(message, 120)}",
        heading="ข้อความใหม่จากฟอร์มติดต่อ",
        blocks=(
            Details(rows=(("ชื่อ", name), ("อีเมล", email))),
            Quote(message, title="ข้อความ"),
            Paragraph("กดตอบกลับอีเมลนี้เพื่อตอบผู้ติดต่อได้โดยตรง"),
        ),
        reason=f"คุณได้รับอีเมลนี้เพราะอีเมลนี้ถูกตั้งเป็นปลายทางของฟอร์มติดต่อบนเว็บไซต์ {brand}",
    ), site)


def admin_login_code(
    *, brand: str, code: str, ip: str | None, site: SiteInfo | None = None
) -> RenderedEmail:
    """The one-time code for the admin dashboard. The code is digits only."""
    where = f" จาก IP {ip}" if ip else ""
    return render_email(brand, Email(
        subject=f"รหัสเข้าสู่แผงผู้ดูแลระบบ — {brand}",
        # The code itself stays out of the preview line (lock screens show it).
        preheader="รหัสยืนยันแบบใช้ครั้งเดียว หมดอายุใน 10 นาที",
        heading="รหัสเข้าสู่แผงผู้ดูแลระบบ",
        blocks=(
            Paragraph(f"มีการเข้าสู่ระบบแผงผู้ดูแล {brand} ด้วยบัญชีนี้{where} กรอกรหัสด้านล่างเพื่อยืนยัน"),
            Code("รหัส", code),
            Notice("รหัสนี้ใช้ได้ครั้งเดียว และหมดอายุใน 10 นาที อย่าบอกรหัสนี้กับใคร"),
            Notice(
                "ให้เปลี่ยนรหัสผ่านทันที เพราะมีคนรู้รหัสผ่านของคุณ",
                title="ถ้าคุณไม่ได้เข้าสู่ระบบ",
            ),
        ),
        reason=f"คุณได้รับอีเมลนี้เพราะมีการเข้าสู่แผงผู้ดูแลระบบ {brand} ด้วยบัญชีผู้ดูแลนี้",
    ), site)


def circuit_breaker_tripped(
    *, brand: str, day: str, spend_thb: float, cap_thb: float, site: SiteInfo | None = None
) -> RenderedEmail:
    """Admin alert: today's AI spend reached the daily circuit-breaker cap and
    new AI jobs are paused (packages/billing/guard.py)."""
    return render_email(brand, Email(
        subject=f"งาน AI หยุดชั่วคราว: ถึงเพดานค่าใช้จ่ายรายวัน — {brand}",
        preheader=f"ค่าใช้จ่าย AI วันที่ {day} ถึง ฿{spend_thb:,.2f} ระบบหยุดรับงาน AI ใหม่แล้ว",
        heading="ถึงเพดานค่าใช้จ่าย AI รายวันแล้ว",
        blocks=(
            Paragraph("ค่าใช้จ่าย AI ของวันนี้ถึงเพดานที่ตั้งไว้ ระบบหยุดรับงาน AI ใหม่ของลูกค้าแล้ว"),
            Details(rows=(
                ("วันที่ (UTC)", day),
                ("ค่าใช้จ่าย", f"฿{spend_thb:,.2f}"),
                ("เพดาน", f"฿{cap_thb:,.2f}"),
            )),
            Paragraph(
                "งานที่เริ่มไปแล้วยังทำต่อได้จนกว่าจะเกินเพดานมากกว่าที่ตั้งไว้ "
                "ปรับเพดานหรือปิดการหยุดอัตโนมัติได้ที่แผงผู้ดูแลระบบ"
            ),
            Notice("แจ้งเตือนนี้ส่งครั้งเดียวต่อวัน"),
        ),
        reason=f"คุณได้รับอีเมลนี้เพราะคุณเป็นผู้ดูแลระบบ {brand}",
    ), site)
