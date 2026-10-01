"""Render every transactional email with sample data into a folder of HTML
files (+ the plain-text twins and an index.html) for eyeballing in a browser.

    cd backend && python scripts/preview_emails.py <out_dir> [--site https://www.noeystudio.com]

Sends nothing. Sample data only — no database, no settings needed.
"""

import argparse
import sys
from html import escape
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from packages.email import templates
from packages.email.layout import SiteInfo
from packages.email.message import RenderedEmail


def samples(site: SiteInfo) -> dict[str, RenderedEmail]:
    base = site.base
    brand = "Noey Studio"
    return {
        "verify_email": templates.verify_email(
            brand=brand, link=templates.build_link(base, templates.VERIFY_PATH, "vT9x2QmZ_4kLs8Rw"),
            display_name=None, site=site,
        ),
        "reset_password": templates.reset_password(
            brand=brand, link=templates.build_link(base, templates.RESET_PATH, "rP3n7Hc_Jq2WvY0e"), site=site,
        ),
        "change_email_confirm": templates.change_email_confirm(
            brand=brand, link=templates.build_link(base, templates.VERIFY_PATH, "cE8b1Lz_Pk5TdU6s"),
            new_email="noey.creator@gmail.com", site=site,
        ),
        "change_email_notice": templates.change_email_notice(
            brand=brand, new_email="noey.creator@gmail.com", site=site,
        ),
        "account_deleted": templates.account_deleted(brand=brand, site=site),
        "contact_message": templates.contact_message(
            brand=brand, name="สมชาย ใจดี", email="somchai@example.com",
            message=(
                "สวัสดีครับ อยากสอบถามเรื่องแพ็กเกจรายเดือน\n"
                "ถ้าอัปเกรดกลางเดือน ระบบคิดเงินส่วนต่างอย่างไรครับ\n\n"
                "ขอบคุณครับ <b>not bold</b>"
            ),
            site=site,
        ),
        "admin_login_code": templates.admin_login_code(brand=brand, code="482913", ip="203.0.113.24", site=site),
        "circuit_breaker_tripped": templates.circuit_breaker_tripped(
            brand=brand, day="2026-09-30", spend_thb=5012.4, cap_thb=5000, site=site,
        ),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out_dir")
    ap.add_argument("--site", default="https://www.noeystudio.com")
    ap.add_argument("--support", default="support@noeystudio.com")
    args = ap.parse_args()
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    site = SiteInfo(site_url=args.site, support_email=args.support)
    rows = []
    for name, r in samples(site).items():
        (out / f"{name}.html").write_text(r.html, encoding="utf-8")
        (out / f"{name}.txt").write_text(r.text, encoding="utf-8")
        rows.append(
            f'<li><a href="{name}.html">{escape(name)}</a> · <a href="{name}.txt">text</a>'
            f"<br><small>{escape(r.subject)}</small></li>"
        )
    (out / "index.html").write_text(
        '<!doctype html><html lang="th"><meta charset="utf-8"><title>Noey email previews</title>'
        '<body style="font-family:-apple-system,Segoe UI,Tahoma,sans-serif;max-width:640px;margin:40px auto;'
        'line-height:1.7;padding:0 16px"><h1>Noey Studio — transactional emails</h1><ul>'
        + "".join(rows) + "</ul></body></html>",
        encoding="utf-8",
    )
    print(f"wrote {len(rows)} emails to {out}")


if __name__ == "__main__":
    main()
