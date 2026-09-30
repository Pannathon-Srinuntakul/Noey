import Link from "next/link";
import { EDITOR_OPEN_PATH } from "@/lib/editor-handoff";
import { NAV_LINKS } from "@/lib/site";
import { SignOutButton } from "../account/SignOutButton";
import { IconChevronDown, IconUser } from "../ds/icons";
import { NoeyMark } from "../NoeyMark";
import { ScrollTimeline } from "../shell/ScrollTimeline";
import { AuthHintSync, HeaderDisclosures, NavLinks, ThemeToggle } from "./HeaderClient";

/**
 * The floating toolbar: logo, the five sections, theme, and the account
 * actions — with the page's own timeline ruler under it (ScrollTimeline).
 *
 * Static (no cookies read on the server, so marketing pages stay static).
 * Both account variants are in the HTML; CSS shows one from <html
 * data-auth>, which the pre-paint script sets from the hint cookie.
 *
 * The signed-in variant is the ONE place sign-out and "open editor" live (the
 * account page does not repeat them). "Open editor" goes through the handoff
 * route so the editor opens already signed in (lib/editor-handoff.ts); it is
 * a plain <a>, never a prefetching <Link>, because the route mints a
 * one-time code.
 *
 * Below 1024px the links and account actions move into a full-screen sheet.
 * The sheet and the account menu are <details>, so both open without
 * JavaScript; HeaderDisclosures closes them on navigation and Escape.
 */
export function SiteHeader() {
  return (
    <header className="hdr" data-site-header="">
      <div className="hdr__bar">
        <div className="hdr__row">
          <Link href="/" className="brand">
            <NoeyMark size={28} className="brand__mark" />
            <span className="brand__words">
              <span className="brand__name">Noey Studio</span>
              <span className="brand__tagline">ตัดคลิปด้วย AI</span>
            </span>
          </Link>
          <NavLinks links={NAV_LINKS} className="hdr__nav" label="เมนูหลัก" />
          <div className="hdr__tools">
            <ThemeToggle />
            <div className="auth-area auth-out">
              <Link href="/login" className="btn btn-ghost btn-sm">
                เข้าสู่ระบบ
              </Link>
              <Link href="/signup" className="btn btn-primary btn-sm" data-magnetic="">
                เริ่มใช้ฟรี
              </Link>
            </div>
            <div className="auth-area auth-in">
              <details className="acct" data-header-disclosure="">
                <summary>
                  <span className="acct__avatar" aria-hidden="true">
                    <IconUser size={16} />
                  </span>
                  <span className="acct__label">
                    <span className="auth-name" />
                    <span className="acct__fallback">บัญชีของฉัน</span>
                  </span>
                  <IconChevronDown size={15} className="acct__chev" />
                </summary>
                <div className="acct__menu">
                  <Link href="/account" prefetch={false}>
                    บัญชีของฉัน
                  </Link>
                  <SignOutButton className="auth-signout" />
                </div>
              </details>
              <a href={EDITOR_OPEN_PATH} className="btn btn-primary btn-sm" data-magnetic="">
                เปิดห้องตัดต่อ
              </a>
            </div>
            <details className="menu" data-header-disclosure="">
              <summary aria-label="เมนู">
                <span className="menu__icon" aria-hidden="true" />
              </summary>
              <div className="menu__sheet">
                <NavLinks links={NAV_LINKS} className="menu__nav" label="เมนูหลัก (จอเล็ก)" numbered />
                <div className="menu__foot">
                  <div className="auth-area auth-out">
                    <Link href="/login" className="btn btn-secondary btn-lg">
                      เข้าสู่ระบบ
                    </Link>
                    <Link href="/signup" className="btn btn-primary btn-lg">
                      เริ่มใช้ฟรี
                    </Link>
                  </div>
                  <div className="auth-area auth-in">
                    <span className="auth-name" />
                    <Link href="/account" className="btn btn-secondary btn-lg" prefetch={false}>
                      บัญชีของฉัน
                    </Link>
                    <a href={EDITOR_OPEN_PATH} className="btn btn-primary btn-lg">
                      เปิดห้องตัดต่อ
                    </a>
                    <SignOutButton className="auth-signout" />
                  </div>
                  <div className="menu__theme">
                    <ThemeToggle />
                  </div>
                </div>
              </div>
            </details>
          </div>
        </div>
        <ScrollTimeline />
      </div>
      <AuthHintSync />
      <HeaderDisclosures />
    </header>
  );
}
