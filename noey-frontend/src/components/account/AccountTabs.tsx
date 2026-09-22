"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/account", label: "ห้องตัดต่อ" },
  { href: "/account/quota", label: "โควตาและลิมิต" },
  { href: "/account/billing", label: "แพลนและการชำระเงิน" },
  { href: "/account/profile", label: "ข้อมูลส่วนตัว" },
] as const;

/** The design's account tabs, as real routes (each tab is its own URL). */
export function AccountTabs() {
  const pathname = usePathname();
  return (
    <nav className="tabs" aria-label="เมนูบัญชี">
      {TABS.map((tab) => (
        <Link key={tab.href} href={tab.href} aria-current={pathname === tab.href ? "page" : undefined}>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
