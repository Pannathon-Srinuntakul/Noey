import Link from "next/link";
import { EDITOR_OPEN_PATH } from "@/lib/editor-handoff";
import { NAV_LINKS } from "@/lib/site";
import { SignOutButton } from "../account/SignOutButton";
import { NoeyMark } from "../NoeyMark";
import { AuthHintSync, NavLinks, ThemeToggle } from "./HeaderClient";

/**
 * Static header (no cookies read on the server, so marketing pages stay
 * static). Both account variants are in the HTML; CSS shows one from
 * <html data-auth>, which the pre-paint script sets from the hint cookie.
 *
 * The signed-in variant is the ONE place sign-out and "open editor" live (the
 * account page no longer repeats them). "Open editor" goes through the
 * handoff route so the editor opens already signed in (lib/editor-handoff.ts);
 * it is a plain <a>, never a prefetching <Link>, because the route mints a
 * one-time code.
 */
export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="site-header__inner">
        <Link href="/" className="brand">
          <NoeyMark size={20} className="brand__mark" />
          <span>Noey Studio</span>
          <span className="brand__tagline">ตัดคลิปด้วย AI</span>
        </Link>
        <NavLinks links={NAV_LINKS} className="site-nav" label="เมนูหลัก" />
        <ThemeToggle />
        <div className="auth-area auth-out">
          <Link href="/login" className="btn btn-ghost">
            เข้าสู่ระบบ
          </Link>
          <Link href="/signup" className="btn btn-primary">
            เริ่มใช้ฟรี
          </Link>
        </div>
        <div className="auth-area auth-in">
          <span className="auth-name" />
          <Link href="/account" className="btn btn-ghost" prefetch={false}>
            บัญชีของฉัน
          </Link>
          <SignOutButton className="auth-signout" />
          <a href={EDITOR_OPEN_PATH} className="btn btn-primary">
            เปิดห้องตัดต่อ
          </a>
        </div>
        <AuthHintSync />
      </div>
    </header>
  );
}
