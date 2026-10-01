import Link from "next/link";
import { EDITOR_OPEN_PATH } from "@/lib/editor-handoff";
import { NAV_LINKS } from "@/lib/site";
import { SignOutButton } from "../account/SignOutButton";
import { IconCard, IconChevronDown, IconLevels, IconScissors, IconUser } from "../ds/icons";
import { NoeyMark } from "../NoeyMark";
import { ScrollTimeline } from "../shell/ScrollTimeline";
import { AuthHintSync, HeaderDisclosures, NavLinks, PageLink, ThemeToggle } from "./HeaderClient";

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
          {/* No viewport prefetch: the home page is the heaviest route, and the
              logo sits in view on every page load, where the prefetch would
              compete with the page's own first paint on a slow connection. */}
          <Link href="/" className="brand" prefetch={false}>
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
              <PageLink href="/login" className="btn btn-ghost btn-sm">
                เข้าสู่ระบบ
              </PageLink>
              {/* Not prefetched on sight: /signup carries the editor mock-up and its
                  stylesheets, too heavy to fetch alongside every page's first paint. */}
              <PageLink href="/signup" className="btn btn-primary btn-sm" magnetic prefetch={false}>
                เริ่มใช้ฟรี
              </PageLink>
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
                  {/* Who is signed in, as the head of the panel below it. */}
                  <div className="acct__head" aria-hidden="true">
                    <span className="acct__avatar">
                      <IconUser size={16} />
                    </span>
                    <span className="auth-name" />
                  </div>
                  {/* The account's four tabs, with the tabs' own icons (AccountTabs). */}
                  <Link href="/account" prefetch={false}>
                    <IconScissors size={16} />
                    บัญชีของฉัน
                  </Link>
                  <Link href="/account/quota" prefetch={false}>
                    <IconLevels size={16} />
                    โควตาและลิมิต
                  </Link>
                  <Link href="/account/billing" prefetch={false}>
                    <IconCard size={16} />
                    แพลนและการชำระเงิน
                  </Link>
                  <Link href="/account/profile" prefetch={false}>
                    <IconUser size={16} />
                    ข้อมูลส่วนตัว
                  </Link>
                  <SignOutButton className="auth-signout" icon />
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
                    <PageLink href="/login" className="btn btn-secondary btn-lg">
                      เข้าสู่ระบบ
                    </PageLink>
                    <PageLink href="/signup" className="btn btn-primary btn-lg">
                      เริ่มใช้ฟรี
                    </PageLink>
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
