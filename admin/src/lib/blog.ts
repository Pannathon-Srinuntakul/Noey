/**
 * Blog moderation: the shapes /admin/blog/* returns, input checks the Server
 * Actions run before anything reaches the backend (which re-checks all of it),
 * and a tiny Markdown → blocks parser for the preview. Pure — unit-tested in
 * blog.test.ts. The preview renders React elements from these blocks; it never
 * injects HTML.
 */

export type PostStatus = "draft" | "published" | "unpublished";
export type PostSource = "ai" | "human";

export interface Named {
  slug: string;
  name: string;
}

export interface PostRow {
  slug: string;
  title: string;
  status: PostStatus;
  source: PostSource;
  category: Named;
  tags: Named[];
  published_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  created_by: string;
}

export interface FaqItem {
  question: string;
  answer: string;
}

export interface PostFull {
  slug: string;
  title: string;
  meta_title: string;
  meta_description: string;
  excerpt: string;
  content_md: string;
  cover_image_url: string | null;
  cover_alt: string | null;
  cover_width: number | null;
  cover_height: number | null;
  category: Named;
  tags: Named[];
  faq: FaqItem[];
  author: string;
  source: PostSource;
  reading_minutes: number;
  published_at: string | null;
  updated_at: string | null;
  status: PostStatus;
  created_at: string | null;
  created_by: string;
  slug_locked: boolean;
}

export interface BlogSettings {
  auto_publish: boolean;
  max_per_day: number;
  auto_publish_source: "admin" | "env";
  max_per_day_source: "admin" | "env";
  published_today_via_mcp: number;
  next_reset_at: string | null;
}

export interface AuditEntry {
  id: number;
  at: string | null;
  actor: string;
  action: string;
  slug: string | null;
  ok: boolean;
  detail: Record<string, unknown> | null;
}

export interface Connector {
  grant_id: number;
  client_id: string;
  client_name: string;
  redirect_hosts: string[];
  approved_by: string;
  scopes: string;
  created_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  active: boolean;
}

export interface Category {
  slug: string;
  name: string;
  description: string;
  post_count: number;
}

export interface BlogOverview {
  posts: PostRow[];
  total: number;
  settings: BlogSettings;
  connectors: Connector[];
  audit: AuditEntry[];
  categories: Category[];
}

export interface ConsentRequest {
  request_id: string;
  client_id: string;
  client_name: string;
  redirect_uri: string;
  redirect_host: string;
  loopback: boolean;
  scopes: string[];
  resource: string | null;
  expires_at: string | null;
}

export const STATUS_LABEL: Record<PostStatus, string> = {
  draft: "ฉบับร่าง",
  published: "เผยแพร่แล้ว",
  unpublished: "ถอนแล้ว",
};

export const SOURCE_LABEL: Record<PostSource, string> = { ai: "AI เขียน", human: "เจ้าของแก้" };

export const ACTION_LABEL: Record<string, string> = {
  create_post: "AI สร้างร่าง",
  update_post: "AI แก้บทความ",
  publish_post: "AI เผยแพร่",
  unpublish_post: "AI ถอนบทความ",
  upload_image: "อัปโหลดรูป",
  admin_update: "แก้ในแผงผู้ดูแล",
  admin_publish: "เผยแพร่โดยเจ้าของ",
  admin_unpublish: "ถอนโดยเจ้าของ",
  admin_settings: "เปลี่ยนการตั้งค่า",
  oauth_register: "ตัวเชื่อมต่อลงทะเบียน",
  oauth_authorize: "ขออนุญาตเชื่อมต่อ",
  oauth_approve: "อนุญาตตัวเชื่อมต่อ",
  oauth_deny: "ปฏิเสธตัวเชื่อมต่อ",
  oauth_token: "ออกโทเค็น",
  oauth_revoke: "ยกเลิกตัวเชื่อมต่อ",
};

export const REVOKE_REASON: Record<string, string> = {
  admin_revoke: "ผู้ดูแลยกเลิก",
  refresh_reuse: "ตรวจพบโทเค็นถูกใช้ซ้ำ",
  code_reuse: "ตรวจพบรหัสถูกใช้ซ้ำ",
  client_revoke: "ตัวเชื่อมต่อยกเลิกเอง",
};

export const LIMITS = { title: 200, meta_title: 60, meta_description: 160, excerpt: 300, alt: 300, content: 60_000, faqMax: 6 } as const;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{20,64}$/;

export function validSlug(slug: unknown): slug is string {
  return typeof slug === "string" && slug.length > 0 && slug.length <= 80 && SLUG.test(slug);
}

export function validRequestId(id: unknown): id is string {
  return typeof id === "string" && REQUEST_ID.test(id);
}

export function validStatus(v: unknown): v is PostStatus | "" {
  return v === "" || v === "draft" || v === "published" || v === "unpublished";
}

export function validSource(v: unknown): v is PostSource | "" {
  return v === "" || v === "ai" || v === "human";
}

export interface PostEdit {
  title: string;
  meta_title: string;
  meta_description: string;
  excerpt: string;
  content_md: string;
  cover_image_url: string | null;
  cover_alt: string | null;
  category: string;
  tags: { slug: string; name: string | null }[];
  faq: FaqItem[];
  new_slug?: string;
}

/** Problems with an edit, in Thai, before it is sent. Empty = OK. */
export function editProblems(e: PostEdit): string[] {
  const out: string[] = [];
  const len = (label: string, v: string, max: number, min = 1) => {
    if (v.trim().length < min) out.push(`${label}ต้องไม่ว่าง`);
    else if (v.length > max) out.push(`${label}ยาว ${v.length} ตัวอักษร เกินกำหนด ${max}`);
  };
  len("ชื่อบทความ", e.title, LIMITS.title);
  len("Meta title ", e.meta_title, LIMITS.meta_title);
  len("Meta description ", e.meta_description, LIMITS.meta_description);
  len("บทคัดย่อ", e.excerpt, LIMITS.excerpt);
  len("เนื้อหา", e.content_md, LIMITS.content);
  if (!validSlug(e.category)) out.push("เลือกหมวดหมู่");
  if (e.cover_image_url && !(e.cover_alt ?? "").trim()) out.push("รูปปกต้องมีคำอธิบายรูป (alt)");
  if (e.new_slug !== undefined && e.new_slug !== "" && !validSlug(e.new_slug)) out.push("slug ใช้ได้เฉพาะ a-z 0-9 และขีดกลาง");
  if (e.faq.length > LIMITS.faqMax) out.push(`คำถามที่พบบ่อยได้ไม่เกิน ${LIMITS.faqMax} ข้อ`);
  e.faq.forEach((f, i) => {
    if (!f.question.trim() || !f.answer.trim()) out.push(`คำถามข้อ ${i + 1} ต้องมีทั้งคำถามและคำตอบ`);
  });
  if (e.tags.length > 8) out.push("แท็กได้ไม่เกิน 8 แท็ก");
  e.tags.forEach((t) => {
    if (!validSlug(t.slug)) out.push(`แท็ก "${t.slug}" ใช้ได้เฉพาะ a-z 0-9 และขีดกลาง`);
  });
  return out;
}

/** "subtitles:ซับไทย, tips" → [{slug: "subtitles", name: "ซับไทย"}, {slug: "tips", name: null}] */
export function parseTags(raw: string): { slug: string; name: string | null }[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [slug, ...rest] = part.split(":");
      const name = rest.join(":").trim();
      return { slug: slug.trim().toLowerCase(), name: name || null };
    });
}

export function formatTags(tags: Named[]): string {
  return tags.map((t) => (t.name && t.name !== t.slug ? `${t.slug}:${t.name}` : t.slug)).join(", ");
}

// ── Markdown preview ─────────────────────────────────────────────────────────

export type Inline = { kind: "text"; text: string } | { kind: "strong"; text: string } | { kind: "code"; text: string } | { kind: "link"; text: string; href: string };

export type Block =
  | { kind: "h2" | "h3" | "h4"; inline: Inline[] }
  | { kind: "p"; inline: Inline[] }
  | { kind: "ul" | "ol"; items: Inline[][] }
  | { kind: "quote"; inline: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "img"; alt: string; src: string };

/** Only http(s) and site-relative links/images ever become href/src. */
export function safeHref(href: string): string | null {
  const h = href.trim();
  if (h.startsWith("/") && !h.startsWith("//")) return h;
  try {
    const u = new URL(h);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    if (m[1] !== undefined) {
      const href = safeHref(m[2]);
      out.push(href ? { kind: "link", text: m[1], href } : { kind: "text", text: m[1] });
    } else if (m[3] !== undefined) out.push({ kind: "strong", text: m[3] });
    else out.push({ kind: "code", text: m[4] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "p", inline: parseInline(para.join(" ")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith("```"); i++) code.push(lines[i]);
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    if (!trimmed) {
      flush();
      continue;
    }
    const heading = /^(#{2,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flush();
      const kind = (["h2", "h3", "h4"] as const)[heading[1].length - 2];
      blocks.push({ kind, inline: parseInline(heading[2]) });
      continue;
    }
    const image = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(trimmed);
    if (image) {
      flush();
      const src = safeHref(image[2]);
      if (src) blocks.push({ kind: "img", alt: image[1], src });
      continue;
    }
    if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      flush();
      const ordered = /^\d+\./.test(trimmed);
      const items: Inline[][] = [];
      for (; i < lines.length && (ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/).test(lines[i]); i++) {
        items.push(parseInline(lines[i].trim().replace(/^([-*]|\d+\.)\s+/, "")));
      }
      i--;
      blocks.push({ kind: ordered ? "ol" : "ul", items });
      continue;
    }
    if (trimmed.startsWith(">")) {
      flush();
      blocks.push({ kind: "quote", inline: parseInline(trimmed.replace(/^>\s?/, "")) });
      continue;
    }
    para.push(trimmed);
  }
  flush();
  return blocks;
}

export function thaiDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}
