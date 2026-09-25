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
  | "scope"
  | "pricing"
  | "about"
  | "signup"
  | "login"
  | "terms"
  | "privacy"
  | GuideKey;

/**
 * Answer-first article pages plus the help/docs page, all under /guide. They
 * are registered here like any other page, so the sitemap, metadata, the feed
 * and the SEO tests pick them up without a second list.
 */
export type GuideKey =
  | "guide"
  | "guideCut"
  | "guideSubtitles"
  | "guideReview"
  | "guideLongform"
  | "guideChoose"
  | "guideHelp";

export const GUIDE_KEYS: readonly GuideKey[] = [
  "guideCut",
  "guideSubtitles",
  "guideReview",
  "guideLongform",
  "guideChoose",
  "guideHelp",
];

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
  /** ISO date the page was first published. Defaults to `updated`. */
  published?: string;
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
export const LEGAL_PAGES_ARE_DRAFTS = false;

export const PAGES: Record<PageKey, PageEntry> = {
  home: {
    path: "/",
    title: "ตัดคลิป TikTok ด้วย AI ในเบราว์เซอร์ | Noey Studio",
    description:
      "Noey Studio ตัดคลิปสั้นด้วย AI ในเบราว์เซอร์ ถอดเสียงไทย เลือกช่วงไฮไลต์ เขียนสคริปต์พากย์ ใส่ซับไทยอัตโนมัติ แก้ต่อได้ทุกช็อต เริ่มใช้ฟรี",
    label: "หน้าแรก",
    updated: "2026-09-26", published: "2026-09-21",
    indexable: true,
  },
  scope: {
    path: "/scope",
    title: "AI ตัดคลิปได้แค่ไหน ทำอะไรได้บ้าง | Noey Studio",
    description:
      "Noey Studio ถอดเสียง คัดช็อต เรียงลำดับ และใส่ซับไทยเป็นร่างแรกให้ คุณเกลาจังหวะต่อในไทม์ไลน์ ดูว่างานแบบไหนเหมาะ และอะไรที่ระบบยังทำไม่ได้",
    label: "ทำอะไรได้บ้าง",
    updated: "2026-09-23", published: "2026-09-21",
    indexable: true,
  },
  pricing: {
    path: "/pricing",
    title: "ราคาแพลนตัดต่อวิดีโอด้วย AI เริ่มฟรี | Noey Studio",
    // The pricing page builds its description from live prices; this is the
    // price-free fallback used when prices are unknown.
    description:
      "เทียบราคาทุกแพลนของ Noey Studio แพลนฟรี 0 บาท และแพลนรายเดือน Lite ถึง Max ดูปริมาณการใช้งาน ความยาวฟุตเทจ และพื้นที่เก็บงาน",
    label: "ราคา",
    updated: "2026-09-26", published: "2026-09-21",
    indexable: true,
  },
  about: {
    path: "/about",
    title: "เกี่ยวกับเราและช่องทางติดต่อ | Noey Studio",
    description:
      "Noey Studio เริ่มจากครีเอเตอร์ที่ลงคลิปรีวิวสินค้าทุกวันและอยากลดเวลาตัดคลิป อ่านแนวคิดของเครื่องมือ และส่งข้อความถึงทีมงานได้จากหน้านี้",
    label: "เกี่ยวกับเรา",
    updated: "2026-09-23", published: "2026-09-21",
    indexable: true,
  },
  signup: {
    path: "/signup",
    title: "สมัครใช้งานฟรี ไม่ต้องผูกบัตร | Noey Studio",
    description:
      "สมัครบัญชี Noey Studio แล้วเริ่มตัดคลิปด้วย AI ที่แพลนฟรีได้ทันที ไม่ต้องผูกบัตร ได้ทุกโหมดรวมโหมดพากย์ใหม่ อยากได้โควตาเพิ่มค่อยอัปเกรดทีหลัง",
    label: "สมัครใช้งาน",
    updated: "2026-09-22",
    indexable: true,
  },
  login: {
    path: "/login",
    title: "เข้าสู่ระบบ | Noey Studio",
    description:
      "เข้าสู่ระบบบัญชี Noey Studio เพื่อจัดการแพลนและการชำระเงิน ดูโควตาที่ใช้ไป และเปิดห้องตัดต่อด้วยบัญชีเดียวกัน",
    label: "เข้าสู่ระบบ",
    updated: "2026-09-21",
    indexable: false,
  },
  terms: {
    path: "/terms",
    title: "เงื่อนไขการใช้งาน | Noey Studio",
    description:
      "เงื่อนไขการใช้งาน Noey Studio บัญชีผู้ใช้ สิทธิในไฟล์และผลงาน ความรับผิดชอบต่อเนื้อหา โควตา ค่าบริการและการยกเลิก และการเก็บข้อมูลงาน",
    label: "เงื่อนไขการใช้งาน",
    updated: "2026-09-22",
    indexable: !LEGAL_PAGES_ARE_DRAFTS,
  },
  privacy: {
    path: "/privacy",
    title: "นโยบายความเป็นส่วนตัว | Noey Studio",
    description:
      "นโยบายความเป็นส่วนตัวของ Noey Studio ข้อมูลที่เก็บ วัตถุประสงค์ ฐานทางกฎหมาย การเปิดเผย ระยะเวลาเก็บ คุกกี้ และสิทธิของคุณตามกฎหมาย PDPA",
    label: "ความเป็นส่วนตัว",
    updated: "2026-09-22",
    indexable: !LEGAL_PAGES_ARE_DRAFTS,
  },
  guide: {
    path: "/guide",
    title: "คู่มือใช้งานและคำตอบที่ถามบ่อย | Noey Studio",
    description:
      "รวมคู่มือการตัดคลิปสั้นด้วย AI ของ Noey Studio ตัดคลิป TikTok ใส่ซับไทย ตัดคลิปรีวิวสินค้า ตัดคลิปยาวเป็นคลิปสั้น พร้อมหน้าช่วยเหลือเรื่องโหมด ไฟล์ และโควตา",
    label: "คู่มือใช้งาน",
    updated: "2026-09-23",
    published: "2026-09-23",
    indexable: true,
  },
  guideCut: {
    path: "/guide/ai-cut-tiktok",
    title: "ตัดคลิป TikTok ด้วย AI ยังไง | Noey Studio",
    description:
      "วิธีตัดคลิป TikTok ด้วย AI ตั้งแต่ลากไฟล์เข้าเบราว์เซอร์ เลือกโหมด รอระบบถอดเสียงและคัดช็อต จนถึงการเกลาไทม์ไลน์และดาวน์โหลดไฟล์แนวตั้ง 1080×1920",
    label: "ตัดคลิป TikTok ด้วย AI",
    updated: "2026-09-26",
    published: "2026-09-23",
    indexable: true,
  },
  guideSubtitles: {
    path: "/guide/thai-subtitles",
    title: "ใส่ซับไทยอัตโนมัติในคลิปยังไง | Noey Studio",
    description:
      "วิธีใส่ซับไทยอัตโนมัติในคลิปสั้น ระบบถอดเสียงพูดเป็นข้อความแล้ววางซับตามจังหวะที่พูดจริง ปรับฟอนต์ ขนาด ตำแหน่ง และแก้คำที่ถอดผิดได้ก่อนเรนเดอร์",
    label: "ใส่ซับไทยอัตโนมัติ",
    updated: "2026-09-23",
    published: "2026-09-23",
    indexable: true,
  },
  guideReview: {
    path: "/guide/product-review",
    title: "ตัดคลิปรีวิวสินค้าให้เร็วขึ้น | Noey Studio",
    description:
      "วิธีลดเวลาตัดคลิปรีวิวสินค้าสำหรับปักตะกร้า ถ่ายยังไงให้ AI คัดช็อตได้ดี ใช้โหมดไหน เขียนสคริปต์พากย์จากภาพ และเกลาไทม์ไลน์ให้จบเร็วขึ้นในรอบเดียว",
    label: "ตัดคลิปรีวิวสินค้า",
    updated: "2026-09-26",
    published: "2026-09-23",
    indexable: true,
  },
  guideLongform: {
    path: "/guide/long-to-shorts",
    title: "ตัดคลิปยาวเป็นคลิปสั้นหลายตัว | Noey Studio",
    description:
      "วิธีตัดคลิปยาว เช่น ไลฟ์หรือคลิปพูดยาว ให้กลายเป็นคลิปสั้นหลายตัว ระบบฟังเนื้อหาแล้วเลือกช่วงที่จบในตัวเอง พร้อมข้อจำกัดเรื่องความยาวฟุตเทจต่อแพลน",
    label: "ตัดคลิปยาวเป็นคลิปสั้น",
    updated: "2026-09-23",
    published: "2026-09-23",
    indexable: true,
  },
  guideChoose: {
    path: "/guide/choose-ai-editor",
    title: "เลือกเครื่องมือ AI ตัดต่อวิดีโอไทย | Noey Studio",
    description:
      "เกณฑ์เลือกเครื่องมือ AI ตัดต่อวิดีโอภาษาไทย ดูความแม่นของการถอดเสียงไทย การแก้ทับในไทม์ไลน์ ฟอร์แมตไฟล์ที่รับ ผลลัพธ์ที่ได้ และวิธีคิดค่าบริการ",
    label: "เลือกเครื่องมือ AI ตัดต่อ",
    updated: "2026-09-23",
    published: "2026-09-23",
    indexable: true,
  },
  guideHelp: {
    path: "/guide/help",
    title: "หน้าช่วยเหลือ โหมด ไฟล์ โควตา | Noey Studio",
    description:
      "เอกสารช่วยเหลือ Noey Studio อธิบายโหมดการตัดทั้งสามแบบ ไฟล์ที่รองรับ ขีดจำกัดของแต่ละแพลน สิ่งที่ AI ทำได้และทำไม่ได้ และวิธีแก้ปัญหาที่เจอบ่อย",
    label: "ช่วยเหลือ",
    updated: "2026-09-26",
    published: "2026-09-23",
    indexable: true,
  },
};

/** Primary navigation — the design's header links, plus the guide section. */
export const NAV_LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: PAGES.home.path, label: PAGES.home.label },
  { href: PAGES.scope.path, label: PAGES.scope.label },
  { href: PAGES.pricing.path, label: PAGES.pricing.label },
  { href: PAGES.guide.path, label: PAGES.guide.label },
  { href: PAGES.about.path, label: PAGES.about.label },
];

/** First-published date, falling back to the content date. */
export function publishedDate(key: PageKey): string {
  return PAGES[key].published ?? PAGES[key].updated;
}
