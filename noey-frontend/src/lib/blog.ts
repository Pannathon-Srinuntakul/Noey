/**
 * The blog: types, copy, URLs and the mapping from the public blog API
 * (BLOG_CONTRACT.md at the repo root) to what the pages render.
 *
 * Pure — no fetch, no Next.js import — so the pages, the feeds, the sitemap,
 * llms.txt and the unit tests share one definition. The fetching lives in
 * lib/server/blog.ts.
 *
 * Everything the API returns is treated as untrusted input: every field is
 * type-checked, a post with an unusable slug, title, category or date is
 * dropped rather than rendered half-broken, and a cover is only kept when
 * its URL is one the page may load (https, or the configured media base).
 */
import type { FaqItem } from "./faq";
import { SITE_NAME } from "./site";

// ─── Routes and copy ─────────────────────────────────────────────────────────

export const BLOG_PATH = "/blog";
export const BLOG_FEED_PATH = "/blog/feed.xml";
/** The day the blog went up: what an empty blog's feed is dated. */
export const BLOG_LAUNCH_DATE = "2026-10-01";
/** Posts per listing page (the API's default page size). */
export const BLOG_PER_PAGE = 12;
/** Posts named in llms.txt. */
export const BLOG_LLMS_LIMIT = 20;
/** Posts in the Atom feeds. */
export const BLOG_FEED_LIMIT = 50;
/** A tag page with fewer posts than this is `noindex` (a thin page). */
export const TAG_INDEX_MIN_POSTS = 3;
/** Seconds between refreshes: listings (and every file that lists posts), and one article. */
export const BLOG_LIST_REVALIDATE = 600;
export const BLOG_POST_REVALIDATE = 3600;

/**
 * Every visible string the blog adds. Logged in CONTENT_CHANGES.md ("Text
 * added: the blog"); the call to action reuses the site's own sign-up lines.
 */
export const BLOG_COPY = {
  label: "บทความ",
  /** The blog's card under "อ่านต่อนอกคู่มือ" on /guide. */
  guideNote: "เรื่องการตัดคลิปสั้น ซับไทย และการทำคลิปขายของ นอกเหนือจากวิธีใช้",
  /** The <title> before the brand (the page adds " | Noey Studio"). */
  title: "บทความตัดคลิปสั้นและซับไทย",
  description:
    "บทความจาก Noey Studio เรื่องการตัดคลิปสั้นด้วย AI ซับไทย เสียงในคลิป และการทำคลิปรีวิวขายของบน TikTok สำหรับครีเอเตอร์และแม่ค้าที่ถ่ายคลิปเอง",
  h1: "บทความจากห้องตัดต่อ",
  lead: "เรื่องการตัดคลิปสั้น ซับไทย เสียง และการทำคลิปขายของ สำหรับครีเอเตอร์และแม่ค้าที่ถ่ายคลิปเอง",
  leadGuide: "อยากได้วิธีใช้ Noey Studio ทีละขั้น อ่านที่",
  filterLabel: "หมวดบทความ",
  allPosts: "ทั้งหมด",
  postsCount: (n: number) => `${n.toLocaleString("en-US")} บทความ`,
  page: (n: number) => `หน้า ${n}`,
  pagination: "เลขหน้า",
  previous: "หน้าก่อน",
  next: "หน้าถัดไป",
  readMinutes: (n: number) => `อ่าน ${n} นาที`,
  by: `โดย ${SITE_NAME}`,
  published: "เผยแพร่",
  updated: "อัปเดตล่าสุด",
  newest: "ล่าสุด",
  categoryTitle: (name: string) => `บทความหมวด${name}`,
  tagTitle: (name: string) => `บทความแท็ก ${name}`,
  tagLead: (name: string) => `บทความทั้งหมดที่ติดแท็ก “${name}” เรียงจากล่าสุด`,
  tagsLabel: "แท็ก",
  emptyTitle: "ยังไม่มีบทความในแทร็กนี้",
  emptyAll: "ยังไม่มีบทความเผยแพร่ ระหว่างนี้อ่านคู่มือใช้งานที่ตอบคำถามที่คนถามบ่อยไว้แล้วได้",
  emptyFiltered: "หมวดนี้ยังไม่มีบทความ ลองดูบทความหมวดอื่น หรืออ่านคู่มือใช้งาน",
  toGuide: "ไปที่คู่มือใช้งาน",
  toAll: "ดูบทความทั้งหมด",
  unavailableTitle: "ตอนนี้ยังโหลดบทความไม่ได้",
  unavailableText: "ระบบดึงบทความไม่สำเร็จชั่วคราว ลองใหม่อีกครั้งในอีกสักครู่ ระหว่างนี้อ่านคู่มือใช้งานได้ตามปกติ",
  retry: "ลองใหม่",
  tocLabel: "หัวข้อในบทความ",
  faqTitle: "คำถามที่พบบ่อย (FAQ)",
  relatedTitle: "บทความที่เกี่ยวข้อง",
  guideTitle: "อ่านต่อในคู่มือใช้งาน",
  ctaTitle: "ลองใช้ Noey Studio",
  ctaText: "สมัครแล้วได้เครดิตทดลองฟรีทันที ไม่ต้องผูกบัตร ใช้หมดแล้วค่อยเลือกแพลนรายเดือน",
  ctaButton: "เริ่มใช้ฟรี",
  ctaScope: "ดูว่าระบบทำอะไรได้บ้าง",
  ctaPricing: "ดูราคา",
  backToBlog: "กลับไปหน้าบทความทั้งหมด",
  feedLink: "ติดตามบทความผ่าน RSS/Atom",
  feedTitle: `บทความ · ${SITE_NAME}`,
  coverMark: "ภาพปก",
} as const;

/** The guide pages each category leans on: "อ่านต่อในคู่มือใช้งาน" at the foot of a post. */
export const CATEGORY_GUIDES: Readonly<Record<string, readonly string[]>> = {
  "editing-tips": ["/guide/ai-cut-tiktok", "/guide/long-to-shorts"],
  "subtitles-audio": ["/guide/thai-subtitles", "/guide/ai-cut-tiktok"],
  "selling-on-tiktok": ["/guide/product-review", "/guide/choose-ai-editor"],
  "content-ideas": ["/guide/long-to-shorts", "/guide/product-review"],
};
/** Any other category: the guide's own index and the help page. */
export const DEFAULT_GUIDES: readonly string[] = ["/guide/ai-cut-tiktok", "/guide/help"];

export function blogPostPath(slug: string): string {
  return `${BLOG_PATH}/${slug}`;
}

export function blogMarkdownPath(slug: string): string {
  return `${BLOG_PATH}/${slug}.md`;
}

export function categoryPath(slug: string): string {
  return `${BLOG_PATH}/category/${slug}`;
}

export function tagPath(slug: string): string {
  return `${BLOG_PATH}/tag/${slug}`;
}

/** A listing's URL for page `page`: page 1 is the bare path, the rest `?page=N` (the canonical form). */
export function withPage(path: string, page: number): string {
  return page > 1 ? `${path}?page=${page}` : path;
}

/** A listing's `[page]` segment: 1–9999, written without leading zeros; null otherwise. */
export function parsePageParam(raw: string | undefined): number | null {
  return raw && /^[1-9][0-9]{0,3}$/.test(raw) ? Number(raw) : null;
}

/** Static params for a listing's first pages (at most `max`), from its post count. */
export function firstPages(total: number, max = 5): string[] {
  return Array.from({ length: Math.min(max, pageCount(total)) }, (_, index) => String(index + 1));
}

export function pageCount(total: number, perPage = BLOG_PER_PAGE): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / perPage));
}

// ─── Types (the pages' view of a post) ──────────────────────────────────────

export interface BlogRef {
  slug: string;
  name: string;
}

export interface BlogCover {
  url: string;
  alt: string;
  /** Natural size, when the API knows it (it does for a post's own cover). */
  width: number | null;
  height: number | null;
}

export interface BlogPostSummary {
  slug: string;
  title: string;
  metaTitle: string;
  metaDescription: string;
  excerpt: string;
  cover: BlogCover | null;
  category: BlogRef;
  tags: BlogRef[];
  source: "ai" | "human";
  readingMinutes: number;
  /** ISO-8601 UTC. */
  publishedAt: string;
  updatedAt: string;
}

export interface BlogRelated {
  slug: string;
  title: string;
  excerpt: string;
  cover: BlogCover | null;
  category: BlogRef;
  publishedAt: string;
}

export interface BlogPost extends BlogPostSummary {
  contentMd: string;
  faq: FaqItem[];
  related: BlogRelated[];
}

export interface BlogListPage {
  items: BlogPostSummary[];
  page: number;
  perPage: number;
  total: number;
}

export interface BlogCategory extends BlogRef {
  description: string;
  postCount: number;
}

export interface BlogTag extends BlogRef {
  postCount: number;
}

export interface BlogSlug {
  slug: string;
  updatedAt: string;
}

// ─── Mapping untrusted JSON ─────────────────────────────────────────────────

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MAX = 80;

export function isBlogSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= SLUG_MAX && SLUG.test(value);
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** A trimmed string with control characters removed, cut to `max`; "" for anything else. */
function text(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  return clean.length > max ? clean.slice(0, max).trimEnd() : clean;
}

/** An ISO-8601 timestamp the Date parser accepts, normalised to UTC; null otherwise. */
function isoTime(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function dimension(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 20_000 ? value : null;
}

function ref(value: unknown, max = 80): BlogRef | null {
  if (!isObject(value) || !isBlogSlug(value.slug)) return null;
  const name = text(value.name, max);
  return name ? { slug: value.slug, name } : null;
}

/**
 * Where the site may load blog images from: the configured media base
 * (BLOG_MEDIA_PUBLIC_URL, read at build time by next.config.ts) with any
 * protocol, or any https URL. Returns the parsed URL or null.
 */
export function allowedImageUrl(value: unknown, mediaBase: string | null): URL | null {
  if (typeof value !== "string" || value.length > 1000) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (mediaBase && isUnderMediaBase(url, mediaBase)) return url;
  return url.protocol === "https:" ? url : null;
}

/** The URL sits under the media base (same origin, path below the base's path). */
export function isUnderMediaBase(url: URL, mediaBase: string): boolean {
  let base: URL;
  try {
    base = new URL(mediaBase);
  } catch {
    return false;
  }
  if (url.origin !== base.origin || url.search) return false;
  const prefix = base.pathname.replace(/\/+$/, "") + "/";
  return url.pathname.startsWith(prefix) && !url.pathname.slice(prefix.length).split("/").includes("..");
}

function cover(post: Json, mediaBase: string | null, withSize: boolean): BlogCover | null {
  const url = allowedImageUrl(post.cover_image_url, mediaBase);
  if (!url) return null;
  return {
    url: url.toString(),
    alt: text(post.cover_alt, 300),
    width: withSize ? dimension(post.cover_width) : null,
    height: withSize ? dimension(post.cover_height) : null,
  };
}

function minutes(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.min(999, Math.round(value)) : 1;
}

export function mapPostSummary(value: unknown, mediaBase: string | null): BlogPostSummary | null {
  if (!isObject(value) || !isBlogSlug(value.slug)) return null;
  const title = text(value.title, 200);
  const category = ref(value.category);
  const publishedAt = isoTime(value.published_at);
  if (!title || !category || !publishedAt) return null;
  const updatedAt = isoTime(value.updated_at);
  const excerpt = text(value.excerpt, 300);
  const tags = Array.isArray(value.tags) ? value.tags.map((tag) => ref(tag, 40)).filter((tag): tag is BlogRef => tag !== null) : [];
  return {
    slug: value.slug,
    title,
    metaTitle: text(value.meta_title, 60) || title,
    metaDescription: text(value.meta_description, 160) || excerpt,
    excerpt,
    cover: cover(value, mediaBase, true),
    category,
    // One tag per slug, in the API's order.
    tags: tags.filter((tag, index) => tags.findIndex((other) => other.slug === tag.slug) === index).slice(0, 8),
    source: value.source === "human" ? "human" : "ai",
    readingMinutes: minutes(value.reading_minutes),
    publishedAt,
    // A post is never updated before it is published; an older value is noise.
    updatedAt: updatedAt && updatedAt > publishedAt ? updatedAt : publishedAt,
  };
}

function mapRelated(value: unknown, mediaBase: string | null): BlogRelated | null {
  if (!isObject(value) || !isBlogSlug(value.slug)) return null;
  const title = text(value.title, 200);
  const category = ref(value.category);
  const publishedAt = isoTime(value.published_at);
  if (!title || !category || !publishedAt) return null;
  return { slug: value.slug, title, excerpt: text(value.excerpt, 300), cover: cover(value, mediaBase, false), category, publishedAt };
}

function mapFaq(value: unknown): FaqItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (isObject(item) ? { question: text(item.question, 200), answer: text(item.answer, 1000) } : null))
    .filter((item): item is FaqItem => !!item && !!item.question && !!item.answer)
    .slice(0, 10);
}

export function mapPost(value: unknown, mediaBase: string | null): BlogPost | null {
  const summary = mapPostSummary(value, mediaBase);
  if (!summary || !isObject(value)) return null;
  const contentMd = typeof value.content_md === "string" ? value.content_md.slice(0, 100_000) : "";
  if (!contentMd.trim()) return null;
  const related = Array.isArray(value.related)
    ? value.related
        .map((item) => mapRelated(item, mediaBase))
        .filter((item): item is BlogRelated => item !== null && item.slug !== summary.slug)
        .slice(0, 3)
    : [];
  return { ...summary, contentMd, faq: mapFaq(value.faq), related };
}

export function mapListPage(value: unknown, mediaBase: string | null): BlogListPage | null {
  if (!isObject(value) || !Array.isArray(value.items)) return null;
  const page = typeof value.page === "number" && Number.isInteger(value.page) && value.page >= 1 ? value.page : 1;
  const perPage =
    typeof value.per_page === "number" && Number.isInteger(value.per_page) && value.per_page >= 1 ? value.per_page : BLOG_PER_PAGE;
  const items = value.items.map((item) => mapPostSummary(item, mediaBase)).filter((item): item is BlogPostSummary => item !== null);
  const total = typeof value.total === "number" && Number.isInteger(value.total) && value.total >= 0 ? value.total : items.length;
  return { items, page, perPage, total: Math.max(total, (page - 1) * perPage + items.length) };
}

export function mapCategories(value: unknown): BlogCategory[] | null {
  if (!Array.isArray(value)) return null;
  const out: BlogCategory[] = [];
  for (const item of value) {
    const base = ref(item);
    if (!base || !isObject(item) || out.some((other) => other.slug === base.slug)) continue;
    out.push({ ...base, description: text(item.description, 300), postCount: count(item.post_count) });
  }
  return out;
}

export function mapTags(value: unknown): BlogTag[] | null {
  if (!Array.isArray(value)) return null;
  const out: BlogTag[] = [];
  for (const item of value) {
    const base = ref(item, 40);
    if (!base || !isObject(item) || out.some((other) => other.slug === base.slug)) continue;
    out.push({ ...base, postCount: count(item.post_count) });
  }
  return out;
}

export function mapSlugs(value: unknown): BlogSlug[] | null {
  if (!Array.isArray(value)) return null;
  const out: BlogSlug[] = [];
  for (const item of value) {
    if (!isObject(item) || !isBlogSlug(item.slug) || out.some((other) => other.slug === item.slug)) continue;
    const updatedAt = isoTime(item.updated_at);
    if (updatedAt) out.push({ slug: item.slug, updatedAt });
  }
  return out;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Slugs one POST /api/revalidate-blog may name. */
export const REVALIDATE_MAX_SLUGS = 20;

/** The revalidation request's slugs, or null unless the body is `{ "slugs": [valid slug, … at most 20] }`. */
export function parseRevalidateSlugs(body: unknown): string[] | null {
  if (!isObject(body)) return null;
  const slugs = body.slugs;
  if (!Array.isArray(slugs) || slugs.length > REVALIDATE_MAX_SLUGS || !slugs.every(isBlogSlug)) return null;
  return [...new Set(slugs)];
}

// ─── Small helpers the pages share ──────────────────────────────────────────

/** The guide pages to suggest under a post of `category`. */
export function guidesFor(category: string): readonly string[] {
  return CATEGORY_GUIDES[category] ?? DEFAULT_GUIDES;
}

/** The post changed after it was published (on a later Bangkok day — a same-day fix is not news). */
export function wasUpdated(post: Pick<BlogPostSummary, "publishedAt" | "updatedAt">): boolean {
  const day = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date(iso));
  return day(post.updatedAt) !== day(post.publishedAt);
}

/** A stable small number from a slug: seeds the generated covers so each post keeps its own. */
export function slugSeed(slug: string): number {
  let hash = 2166136261;
  for (let index = 0; index < slug.length; index++) {
    hash ^= slug.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
