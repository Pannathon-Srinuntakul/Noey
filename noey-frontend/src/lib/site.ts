/**
 * Site-wide constants and the page registry.
 *
 * Every indexable page's title, description and "content last changed" date
 * lives here, in ONE place, so the page itself, the sitemap, JSON-LD
 * `dateModified` and the SEO unit tests all read the same values.
 *
 * `updated` is the date the page's CONTENT last changed — not the build or
 * ISR regeneration time. Bump it by hand when the copy changes; a date that
 * moves on every rebuild is a fake freshness signal.
 */

function normalizeOrigin(raw: string): string {
  const url = new URL(raw);
  // Canonicals, sitemap entries and og:url are composed from this origin; a
  // trailing path would silently prefix every URL on the site.
  return url.origin;
}

export const SITE_NAME = "Noey Studio";

/** Public origin of this site, e.g. `https://noeystudio.com` (no trailing slash). */
export const SITE_URL = normalizeOrigin(
  process.env.NEXT_PUBLIC_SITE_URL || "https://noeystudio.com",
);

/**
 * The editor web app. Falls back to the web build's local dev port so a fresh
 * checkout works; production MUST set NEXT_PUBLIC_APP_URL.
 */
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:5174";

export const LOCALE = "th_TH";
export const LANG = "th";

/** Brand colours from the logo README (gold on dark / dark gold on light). */
export const BRAND = {
  gold: "#d9a441",
  goldOnLight: "#b68235",
  ink: "#201f1d",
  ground: "#171614",
  offWhite: "#f3f2f2",
  mutedOnDark: "#bdb8b0",
} as const;

/**
 * Absolute URL for a site path. The root is spelled without a trailing slash
 * everywhere (canonical, og:url, sitemap, JSON-LD) — the form Next.js emits
 * for a root canonical — so every surface names the home page identically.
 */
export function absoluteUrl(path: string): string {
  if (path === "/" || path === "") return SITE_URL;
  return new URL(path, SITE_URL).toString();
}

export type PageKey =
  | "home"
  | "examples"
  | "pricing"
  | "about"
  | "signup"
  | "login"
  | "terms"
  | "privacy";

export interface PageEntry {
  path: string;
  /** Full <title>, brand included. Must stay <= 60 characters (unit-tested). */
  title: string;
  /** Meta description. Must stay <= 160 characters (unit-tested). */
  description: string;
  /** Short label used in breadcrumbs and navigation. */
  label: string;
  /** ISO date (YYYY-MM-DD) the page content last changed. */
  updated: string;
  /** Search engines may index the page and it belongs in the sitemap. */
  indexable: boolean;
}

/**
 * Legal pages are Thai DRAFT templates until the owner finalises them. While
 * this is true they render a visible draft banner AND carry `noindex` and stay
 * out of the sitemap: a draft refund or privacy clause quoted back by a search
 * or AI engine as if it were binding is worse than no page at all. Flip to
 * `false` once a lawyer-reviewed version replaces the draft text.
 */
export const LEGAL_PAGES_ARE_DRAFTS = true;

export const PAGES: Record<PageKey, PageEntry> = {
  home: {
    path: "/",
    title: "ตัดคลิป TikTok ด้วย AI ในเบราว์เซอร์ | Noey Studio",
    description:
      "Noey Studio ตัดคลิปสั้นด้วย AI ในเบราว์เซอร์ ถอดเสียงไทย เลือกช่วงไฮไลต์ เขียนสคริปต์พากย์ ใส่ซับไทยอัตโนมัติ แก้ต่อได้ทุกช็อต เริ่มใช้ฟรี",
    label: "หน้าแรก",
    updated: "2026-09-21",
    indexable: true,
  },
  examples: {
    path: "/examples",
    title: "ตัวอย่างคลิปรีวิวสินค้าที่ตัดด้วย AI | Noey Studio",
    description:
      "ดูตัวอย่างคลิปรีวิวสินค้าที่ตัดด้วย Noey Studio โหมดพากย์ใหม่ AI เขียนสคริปต์พากย์ไทยจากภาพ อัดเสียงในเบราว์เซอร์ แล้วใส่ซับไทยให้อัตโนมัติ",
    label: "ตัวอย่างงาน",
    updated: "2026-09-21",
    indexable: true,
  },
  pricing: {
    path: "/pricing",
    title: "ราคาแพลนตัดต่อวิดีโอด้วย AI เริ่มฟรี | Noey Studio",
    // The pricing page builds its description from live prices; this is the
    // price-free fallback used when prices are unknown.
    description:
      "เทียบราคาทุกแพลนของ Noey Studio แพลนฟรี 0 บาท และแพลนรายเดือน Lite, Starter, Pro, Studio ดูโควตางาน AI ความยาวฟุตเทจ และพื้นที่เก็บงาน",
    label: "ราคา",
    updated: "2026-09-21",
    indexable: true,
  },
  about: {
    path: "/about",
    title: "เกี่ยวกับเราและช่องทางติดต่อ | Noey Studio",
    description:
      "Noey Studio เริ่มจากครีเอเตอร์ที่ลงคลิปรีวิวสินค้าทุกวันและอยากลดเวลาตัดคลิป อ่านแนวคิดของเครื่องมือ และส่งข้อความถึงทีมงานได้จากหน้านี้",
    label: "เกี่ยวกับเรา",
    updated: "2026-09-21",
    indexable: true,
  },
  signup: {
    path: "/signup",
    title: "สมัครใช้งานฟรี ไม่ต้องผูกบัตร | Noey Studio",
    description:
      "สมัครบัญชี Noey Studio แล้วเริ่มตัดคลิปด้วย AI ที่แพลนฟรีได้ทันที ไม่ต้องผูกบัตร ได้ทุกโหมดรวมโหมดพากย์ใหม่ อยากได้โควตาเพิ่มค่อยอัปเกรดทีหลัง",
    label: "สมัครใช้งาน",
    updated: "2026-09-21",
    indexable: true,
  },
  login: {
    path: "/login",
    title: "เข้าสู่ระบบ | Noey Studio",
    description:
      "เข้าสู่ระบบบัญชี Noey Studio เพื่อจัดการแพลนและการชำระเงิน ดูโควตาที่ใช้ไป และเปิดแอปตัดต่อด้วยบัญชีเดียวกัน",
    label: "เข้าสู่ระบบ",
    updated: "2026-09-21",
    indexable: false,
  },
  terms: {
    path: "/terms",
    title: "เงื่อนไขการใช้งาน (ฉบับร่าง) | Noey Studio",
    description:
      "ฉบับร่างเงื่อนไขการใช้งาน Noey Studio ครอบคลุมบัญชีผู้ใช้ แพลนและการชำระเงิน การยกเลิก การใช้งานที่ยอมรับได้ และสิทธิ์ในผลงาน",
    label: "เงื่อนไขการใช้งาน",
    updated: "2026-09-21",
    indexable: !LEGAL_PAGES_ARE_DRAFTS,
  },
  privacy: {
    path: "/privacy",
    title: "นโยบายความเป็นส่วนตัว (ฉบับร่าง) | Noey Studio",
    description:
      "ฉบับร่างนโยบายความเป็นส่วนตัวของ Noey Studio ข้อมูลที่เก็บ เหตุผลที่เก็บ ระยะเวลาเก็บ และสิทธิ์ของเจ้าของข้อมูลตามกฎหมาย PDPA",
    label: "ความเป็นส่วนตัว",
    updated: "2026-09-21",
    indexable: !LEGAL_PAGES_ARE_DRAFTS,
  },
};

/** Primary navigation — the design's four header links, in order. */
export const NAV_LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: PAGES.home.path, label: PAGES.home.label },
  { href: PAGES.examples.path, label: PAGES.examples.label },
  { href: PAGES.pricing.path, label: PAGES.pricing.label },
  { href: PAGES.about.path, label: PAGES.about.label },
];
