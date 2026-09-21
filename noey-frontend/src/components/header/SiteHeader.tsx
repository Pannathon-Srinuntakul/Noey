import Link from "next/link";
import { APP_URL, NAV_LINKS } from "@/lib/site";
import { NoeyMark } from "../NoeyMark";
import { AuthHintSync, NavLinks, ThemeToggle } from "./HeaderClient";

/**
 * Static header (no cookies read on the server, so marketing pages stay
 * static). Both account variants are in the HTML; CSS shows one from
 * <html data-auth>, which the pre-paint script sets from the hint cookie.
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
          <a href={APP_URL} className="btn btn-primary">
            ไปที่แอป
          </a>
        </div>
        <AuthHintSync />
      </div>
    </header>
  );
}
