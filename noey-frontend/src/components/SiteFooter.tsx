import Link from "next/link";
import { GUIDE_KEYS, NAV_LINKS, PAGES } from "@/lib/site";

const ACCOUNT_LINKS = [
  { href: PAGES.login.path, label: PAGES.login.label },
  { href: PAGES.signup.path, label: PAGES.signup.label },
  { href: PAGES.terms.path, label: PAGES.terms.label },
  { href: PAGES.privacy.path, label: PAGES.privacy.label },
];

export function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <div className="site-footer__about">
          <p className="site-footer__brand">Noey Studio</p>
          <p>ห้องตัดต่อวิดีโอด้วย AI ที่ทำงานในเบราว์เซอร์ สำหรับครีเอเตอร์และร้านค้าที่ถ่ายคลิปเอง</p>
        </div>
        <div className="site-footer__cols">
          <nav className="site-footer__col" aria-labelledby="footer-menu">
            <p className="site-footer__heading" id="footer-menu">
              เมนู
            </p>
            {NAV_LINKS.map((link) => (
              <Link key={link.href} href={link.href}>
                {link.label}
              </Link>
            ))}
          </nav>
          <nav className="site-footer__col" aria-labelledby="footer-guide">
            <p className="site-footer__heading" id="footer-guide">
              คู่มือ
            </p>
            {GUIDE_KEYS.map((key) => (
              <Link key={PAGES[key].path} href={PAGES[key].path}>
                {PAGES[key].label}
              </Link>
            ))}
          </nav>
          <nav className="site-footer__col" aria-labelledby="footer-account">
            <p className="site-footer__heading" id="footer-account">
              บัญชี
            </p>
            {ACCOUNT_LINKS.map((link) => (
              <Link key={link.href} href={link.href} prefetch={false}>
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
      </div>
      <div className="site-footer__legal">
        <div>© {year} Noey Studio</div>
      </div>
    </footer>
  );
}
