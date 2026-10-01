import Link from "next/link";
import { GUIDE_KEYS, NAV_LINKS, PAGES } from "@/lib/site";
import { NoeyMark } from "./NoeyMark";
import { keepThaiProse } from "./ds/ThaiProse";

/**
 * The account column. The footer is static like the header, so it carries
 * both sets and the same html[data-auth] switch shows one: signed out, log in
 * and sign up; signed in, the account's own tabs (their labels, as the tabs
 * print them).
 */
const ACCOUNT_LINKS: ReadonlyArray<{ href: string; label: string; auth?: "in" | "out" }> = [
  { href: PAGES.login.path, label: PAGES.login.label, auth: "out" },
  { href: PAGES.signup.path, label: PAGES.signup.label, auth: "out" },
  { href: "/account", label: "บัญชีของฉัน", auth: "in" },
  { href: "/account/quota", label: "โควตาและลิมิต", auth: "in" },
  { href: "/account/billing", label: "แพลนและการชำระเงิน", auth: "in" },
  { href: PAGES.terms.path, label: PAGES.terms.label },
  { href: PAGES.privacy.path, label: PAGES.privacy.label },
];

/**
 * End credits. Every page closes on the same night scene (the footer is
 * always dark, see `.ftr` in shell.css): the page fades to black, the splice
 * mark sits large behind the credits, and the reel numbers are decoration.
 */
export function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="ftr theme-night" data-site-footer="">
      <NoeyMark size="100%" className="ftr__mark" />
      <div className="wrap ftr__inner">
        <div className="ftr__lead">
          <div>
            <p className="ftr__brand">
              <NoeyMark size={30} />
              Noey Studio
            </p>
            <p className="ftr__about">{keepThaiProse("ห้องตัดต่อวิดีโอด้วย AI ที่ทำงานในเบราว์เซอร์ สำหรับครีเอเตอร์และร้านค้าที่ถ่ายคลิปเอง")}</p>
          </div>
          <div className="ftr__cols">
            <nav className="ftr__col" aria-labelledby="footer-menu">
              <p className="ftr__heading">
                <span className="tc" aria-hidden="true">
                  R1
                </span>
                <span id="footer-menu">เมนู</span>
              </p>
              {/* Footer links are never prefetched on sight: on short pages the whole
                  footer is on screen at load, and a dozen prefetches would compete
                  with the page's first paint. */}
              {NAV_LINKS.map((link) => (
                <Link key={link.href} href={link.href} prefetch={false}>
                  {link.label}
                </Link>
              ))}
            </nav>
            <nav className="ftr__col" aria-labelledby="footer-guide">
              <p className="ftr__heading">
                <span className="tc" aria-hidden="true">
                  R2
                </span>
                <span id="footer-guide">คู่มือ</span>
              </p>
              {GUIDE_KEYS.map((key) => (
                <Link key={PAGES[key].path} href={PAGES[key].path} prefetch={false}>
                  {PAGES[key].label}
                </Link>
              ))}
            </nav>
            <nav className="ftr__col" aria-labelledby="footer-account">
              <p className="ftr__heading">
                <span className="tc" aria-hidden="true">
                  R3
                </span>
                <span id="footer-account">บัญชี</span>
              </p>
              {ACCOUNT_LINKS.map((link) => (
                <Link key={link.href} href={link.href} prefetch={false} className={link.auth ? `auth-${link.auth}` : undefined}>
                  {link.label}
                </Link>
              ))}
            </nav>
          </div>
        </div>
        <div className="ftr__legal">
          <div>© {year} Noey Studio</div>
          {/* The page's running length is written in by ScrollTimeline once it is measured. */}
          <span className="tc" aria-hidden="true" data-end-tc="">
            END
          </span>
        </div>
      </div>
    </footer>
  );
}
