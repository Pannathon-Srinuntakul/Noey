"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconCard, IconKey, IconLevels, IconUser } from "../ds/icons";

const LINKS = [
  { href: "/account", label: "บัญชีของฉัน", Icon: IconUser },
  { href: "/account/quota", label: "โควตาและลิมิต", Icon: IconLevels },
  { href: "/account/billing", label: "แพลนและการชำระเงิน", Icon: IconCard },
  { href: "/account/profile", label: "ข้อมูลส่วนตัว", Icon: IconKey },
] as const;

/**
 * The header account menu's links: the account's four tabs with the tabs'
 * icons, the one being viewed marked (aria-current; account.css draws it).
 * A client component only for the pathname — the header itself stays static.
 */
export function AccountMenuLinks() {
  const pathname = usePathname();
  return LINKS.map(({ href, label, Icon }) => (
    <Link key={href} href={href} prefetch={false} aria-current={pathname === href ? "page" : undefined}>
      <Icon size={16} />
      {label}
    </Link>
  ));
}
