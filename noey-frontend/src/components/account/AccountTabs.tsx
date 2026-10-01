"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { IconCard, IconKey, IconLevels, IconUser } from "../ds/icons";
import { keepThai } from "../ds/ThaiText";
import { LinkPending } from "../shell/LinkPending";

/*
 * One name and one icon per destination, the same as the header's account
 * menu and the footer ("บัญชีของฉัน" is /account everywhere; the scissors
 * stay with the editor). `short` is the name on a phone, where all four tabs
 * sit side by side.
 */
const TABS = [
  { href: "/account", label: "บัญชีของฉัน", short: "บัญชี", Icon: IconUser },
  { href: "/account/quota", label: "โควตาและลิมิต", short: "โควตา", Icon: IconLevels },
  { href: "/account/billing", label: "แพลนและการชำระเงิน", short: "แพลน", Icon: IconCard },
  { href: "/account/profile", label: "ข้อมูลส่วนตัว", short: "โปรไฟล์", Icon: IconKey },
] as const;

/**
 * The design's account tabs, as real routes (each tab is its own URL), drawn
 * as the tabs along the top of an editor panel.
 */
export function AccountTabs() {
  const pathname = usePathname();
  const nav = useRef<HTMLElement>(null);

  // Between a phone and a full row of tabs the strip scrolls sideways: bring
  // the current tab into view (by moving the strip only, never the page).
  useEffect(() => {
    const strip = nav.current;
    const current = strip?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!strip || !current || strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollLeft = current.offsetLeft - (strip.clientWidth - current.offsetWidth) / 2;
  }, [pathname]);

  return (
    <nav ref={nav} className="tabs" aria-label="เมนูบัญชี">
      {TABS.map(({ href, label, short, Icon }) => (
        <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined}>
          <Icon size={16} className="tabs__icon" />
          <span className="tabs__label">{keepThai(label)}</span>
          <span className="tabs__short">{short}</span>
          <LinkPending />
        </Link>
      ))}
    </nav>
  );
}
