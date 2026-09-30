"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { IconCard, IconLevels, IconScissors, IconUser } from "../ds/icons";
import { keepThai } from "../ds/ThaiText";

const TABS = [
  { href: "/account", label: "ห้องตัดต่อ", Icon: IconScissors },
  { href: "/account/quota", label: "โควตาและลิมิต", Icon: IconLevels },
  { href: "/account/billing", label: "แพลนและการชำระเงิน", Icon: IconCard },
  { href: "/account/profile", label: "ข้อมูลส่วนตัว", Icon: IconUser },
] as const;

/**
 * The design's account tabs, as real routes (each tab is its own URL), drawn
 * as the tabs along the top of an editor panel.
 */
export function AccountTabs() {
  const pathname = usePathname();
  const nav = useRef<HTMLElement>(null);

  // On a phone the strip scrolls sideways: bring the current tab into view
  // (by moving the strip only, never the page).
  useEffect(() => {
    const strip = nav.current;
    const current = strip?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!strip || !current || strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollLeft = current.offsetLeft - (strip.clientWidth - current.offsetWidth) / 2;
  }, [pathname]);

  return (
    <nav ref={nav} className="tabs" aria-label="เมนูบัญชี">
      {TABS.map(({ href, label, Icon }) => (
        <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined}>
          <Icon size={16} className="tabs__icon" />
          <span>{keepThai(label)}</span>
        </Link>
      ))}
    </nav>
  );
}
