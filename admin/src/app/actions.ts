"use server";

/**
 * Every call the dashboard makes. Each action checks the request's Origin
 * (on top of Next.js's own Server Action check), finds a live admin session
 * (refreshing the access token when needed) and validates its arguments
 * before anything reaches the backend — which re-checks all of it again.
 */

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { isSameOrigin } from "@/lib/origin";
import { PAID_KEYS, PLAN_KEYS } from "@/lib/plans";
import { adminApi } from "@/lib/server/api";
import { accessToken, clearSession, deleteCookie, readCookie, writeTokens } from "@/lib/server/auth";
import { ADMIN_URL, COOKIE_SECURE, PRICES_REVALIDATE_SECRET, SITE_URL } from "@/lib/server/config";
import { CHALLENGE_MAX_AGE, isAdminTokens, safeNext, spec } from "@/lib/session";
import {
  BRIEF_FIELDS, MEDIA_MAX_MB, editProblems, mediaTextProblems, parseMediaTags, validMediaKind, validPlanStatus, validRequestId,
  validSlug, validSource, validStatus,
  type AuditEntry, type BlogOverview, type BlogSettings, type Brief, type Category, type Connector, type MediaItem, type PlanItem,
  type PlanStatus, type PostEdit, type PostFull, type PostRow,
} from "@/lib/blog";
import {
  FX_BAND, validBreaker, validFxOverride, validInvoice, validMonth, validPer1M, validWalletAdjust, validWindow,
} from "@/lib/billing";
import type {
  BillingConfigView, BreakerSettings, CircuitBreaker, CostConfig, DashboardData, FxView, LimitFacts, PlanPrices,
  Reconciliation, UserDetail, Vendor, VendorQuota, WalletSummary, WindowKey,
} from "@/lib/types";

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string; signedOut?: boolean };

const GENERIC = "ทำรายการไม่สำเร็จ ลองใหม่อีกครั้ง";
const UNREACHABLE = "เชื่อมต่อระบบหลังบ้านไม่ได้ในตอนนี้";
const SESSION_ENDED = "หมดเวลาการเข้าใช้งาน กรุณาเข้าสู่ระบบใหม่";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

async function sameOrigin(): Promise<boolean> {
  return isSameOrigin(await headers(), ADMIN_URL);
}

function fail<T>(status: number, detail: string | null): ActionResult<T> {
  if (status === 401) return { ok: false, error: SESSION_ENDED, signedOut: true };
  if (status === 0) return { ok: false, error: UNREACHABLE };
  if (status === 429) return { ok: false, error: detail ?? "ทำรายการถี่เกินไป ลองใหม่ภายหลัง" };
  return { ok: false, error: detail ?? GENERIC };
}

async function authed<T>(
  path: string,
  init: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown; form?: FormData; timeoutMs?: number } = {},
): Promise<ActionResult<T>> {
  if (!(await sameOrigin())) return { ok: false, error: "คำขอไม่ได้มาจากหน้านี้" };
  const token = await accessToken();
  if (!token) return { ok: false, error: SESSION_ENDED, signedOut: true };
  const r = await adminApi<T>(path, { ...init, token });
  if (!r.ok) {
    if (r.status === 401) await clearSession();
    return fail<T>(r.status, r.detail);
  }
  return { ok: true, data: r.data };
}

function validId(id: unknown): id is number {
  return typeof id === "number" && Number.isInteger(id) && id > 0 && id < 2 ** 53;
}

// ── login ────────────────────────────────────────────────────────────────────

/** `next`: a same-site path to land on after signing in (e.g. the connector consent page). */
export type LoginState = { step: "login" | "otp"; error?: string; sentTo?: string; email?: string; notice?: string; next?: string };

function text(formData: FormData, key: string, max = 300): string {
  const v = formData.get(key);
  return typeof v === "string" ? v.slice(0, max) : "";
}

async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = text(formData, "email").trim();
  const password = text(formData, "password", 200);
  if (!(await sameOrigin())) return { step: "login", error: GENERIC, email };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { step: "login", error: "อีเมลไม่ถูกต้อง", email };
  if (!password) return { step: "login", error: "กรอกรหัสผ่าน", email };

  const device = await readCookie("device");
  const r = await adminApi<Record<string, unknown>>("/admin/auth/login", {
    method: "POST",
    body: { email, password, device_token: device || undefined },
  });
  if (!r.ok) {
    if (r.status === 401) return { step: "login", error: "อีเมลหรือรหัสผ่านไม่ถูกต้อง — หน้านี้เปิดเฉพาะบัญชีผู้ดูแลระบบ", email };
    if (r.status === 403) return { step: "login", error: "เครือข่ายนี้เข้าแผงผู้ดูแลระบบไม่ได้", email };
    if (r.status === 429) return { step: "login", error: r.detail ?? "ลองผิดหลายครั้งเกินไป กรุณารอสักครู่", email };
    if (r.status === 503) return { step: "login", error: r.detail ?? "ส่งอีเมลรหัสยืนยันไม่ได้ในตอนนี้", email };
    return { step: "login", error: r.status === 0 ? UNREACHABLE : GENERIC, email };
  }
  const next = safeNext(text(formData, "next", 300));
  if (r.data.status === "signed_in" && isAdminTokens(r.data)) {
    await writeTokens(r.data);
    redirect(next);
  }
  if (r.data.status === "otp_required" && typeof r.data.challenge_id === "string") {
    const c = spec("challenge", r.data.challenge_id, CHALLENGE_MAX_AGE, COOKIE_SECURE);
    (await cookies()).set(c.name, c.value, c.options);
    return { step: "otp", sentTo: String(r.data.sent_to ?? ""), email, next };
  }
  return { step: "login", error: GENERIC, email };
}

async function verifyAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const code = text(formData, "code", 12).replace(/\D/g, "");
  const sentTo = text(formData, "sentTo", 255);
  const next = safeNext(text(formData, "next", 300));
  if (!(await sameOrigin())) return { step: "otp", error: GENERIC, sentTo, next };
  if (code.length !== 6) return { step: "otp", error: "กรอกรหัสให้ครบ 6 หลัก", sentTo, next };
  const challenge = await readCookie("challenge");
  if (!challenge) return { step: "login", error: "รหัสหมดอายุแล้ว กรุณาเข้าสู่ระบบใหม่" };
  const r = await adminApi<unknown>("/admin/auth/verify", {
    method: "POST",
    body: { challenge_id: challenge, code, remember_device: true },
  });
  if (!r.ok) {
    if (r.status === 429) return { step: "otp", error: r.detail ?? "ลองผิดหลายครั้งเกินไป", sentTo, next };
    if (r.status === 401) return { step: "otp", error: r.detail ?? "รหัสไม่ถูกต้องหรือหมดอายุ", sentTo, next };
    return { step: "otp", error: r.status === 0 ? UNREACHABLE : GENERIC, sentTo, next };
  }
  await deleteCookie("challenge");
  await writeTokens(r.data);
  redirect(next);
}

export async function resendAction(): Promise<ActionResult<{ sentTo: string }>> {
  if (!(await sameOrigin())) return { ok: false, error: GENERIC };
  const challenge = await readCookie("challenge");
  if (!challenge) return { ok: false, error: "รหัสหมดอายุแล้ว กรุณาเข้าสู่ระบบใหม่" };
  const r = await adminApi<{ sent_to: string }>("/admin/auth/resend", { method: "POST", body: { challenge_id: challenge } });
  if (!r.ok) {
    if (r.status === 401) return { ok: false, error: "ส่งรหัสใหม่ไม่ได้แล้ว กรุณาเข้าสู่ระบบใหม่" };
    return { ok: false, error: r.status === 0 ? UNREACHABLE : (r.detail ?? GENERIC) };
  }
  return { ok: true, data: { sentTo: r.data.sent_to } };
}

async function backToLoginAction(): Promise<void> {
  if (!(await sameOrigin())) return;
  await deleteCookie("challenge");
}

/** The login screen's one form action: `intent` = login | verify | back. */
export async function authAction(prev: LoginState, formData: FormData): Promise<LoginState> {
  const intent = text(formData, "intent", 10);
  if (intent === "verify") return verifyAction(prev, formData);
  if (intent === "back") {
    await backToLoginAction();
    return { step: "login", email: prev.email, next: prev.next };
  }
  return loginAction(prev, formData);
}

/** Explicit sign-out: ends the session server-side and forgets this browser. */
export async function logoutAction(): Promise<void> {
  if (await sameOrigin()) {
    const token = await accessToken();
    const device = await readCookie("device");
    if (token) await adminApi("/admin/auth/logout", { method: "POST", token, body: { device_token: device || undefined } });
  }
  await clearSession({ forgetDevice: true });
  redirect("/login");
}

/** Idle logout: same server-side revocation, but keeps the remembered device. */
export async function idleLogoutAction(): Promise<void> {
  if (await sameOrigin()) {
    const token = await accessToken();
    if (token) await adminApi("/admin/auth/logout", { method: "POST", token, body: {} });
  }
  await clearSession();
  redirect("/login?idle=1");
}

// ── data ─────────────────────────────────────────────────────────────────────

export async function getDashboardAction(from: string, to: string): Promise<ActionResult<DashboardData>> {
  if (!DATE.test(from) || !DATE.test(to)) return { ok: false, error: "ช่วงวันที่ไม่ถูกต้อง" };
  return authed<DashboardData>(`/admin/dashboard?from=${from}&to=${to}`);
}

export async function getUserDetailAction(userId: number): Promise<ActionResult<UserDetail>> {
  if (!validId(userId)) return { ok: false, error: GENERIC };
  return authed<UserDetail>(`/admin/users/${userId}`);
}

// ── writes ───────────────────────────────────────────────────────────────────

export async function setPlanAction(userId: number, plan: string): Promise<ActionResult<unknown>> {
  if (!validId(userId) || !(PLAN_KEYS as string[]).includes(plan)) return { ok: false, error: GENERIC };
  return authed(`/admin/users/${userId}/plan`, { method: "PATCH", body: { plan } });
}

export async function resetQuotaAction(userId: number): Promise<ActionResult<unknown>> {
  if (!validId(userId)) return { ok: false, error: GENERIC };
  return authed(`/admin/users/${userId}/quota-reset`, { method: "POST" });
}

/** One window (5-hour / weekly / monthly) starts over at the user's next use. Audited by the backend. */
export async function resetWindowAction(userId: number, window: WindowKey): Promise<ActionResult<LimitFacts>> {
  if (!validId(userId) || !validWindow(window)) return { ok: false, error: GENERIC };
  return authed<LimitFacts>(`/admin/users/${userId}/window-reset`, { method: "POST", body: { window } });
}

/** Credit (positive) or debit (negative) a user's top-up balance, in satang. Audited. */
export async function walletAdjustAction(userId: number, amountSatang: number, note: string): Promise<ActionResult<WalletSummary>> {
  if (!validId(userId) || !validWalletAdjust(amountSatang, note)) {
    return { ok: false, error: "จำนวนเงินต้องไม่เป็นศูนย์ ไม่เกิน ฿100,000 และต้องมีเหตุผล" };
  }
  return authed<WalletSummary>(`/admin/users/${userId}/wallet-adjust`, {
    method: "POST",
    body: { amount_satang: amountSatang, note: note.trim().slice(0, 200) },
  });
}

export async function setActiveAction(userId: number, active: boolean): Promise<ActionResult<unknown>> {
  if (!validId(userId) || typeof active !== "boolean") return { ok: false, error: GENERIC };
  return authed(`/admin/users/${userId}/active`, { method: "PATCH", body: { active } });
}

export async function saveCostConfigAction(config: CostConfig): Promise<ActionResult<CostConfig>> {
  if (!config || typeof config !== "object") return { ok: false, error: GENERIC };
  // Shape and bounds are validated by the backend (packages/admin/cost_config.py).
  return authed<CostConfig>("/admin/cost-config", { method: "PUT", body: config });
}

async function revalidateSite(): Promise<boolean> {
  if (!SITE_URL || !PRICES_REVALIDATE_SECRET) return false;
  try {
    const r = await fetch(`${SITE_URL}/api/revalidate-prices`, {
      method: "POST",
      headers: { Authorization: `Bearer ${PRICES_REVALIDATE_SECRET}` },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function savePricesAction(prices: Record<string, number>): Promise<ActionResult<PlanPrices & { siteRefreshed: boolean }>> {
  const clean: Record<string, number> = {};
  for (const [k, v] of Object.entries(prices ?? {})) {
    if (!(PAID_KEYS as string[]).includes(k) || !Number.isInteger(v) || v < 1 || v > 100_000) {
      return { ok: false, error: "ราคาต้องเป็นจำนวนเต็ม 1–100,000 บาท" };
    }
    clean[k] = v;
  }
  if (Object.keys(clean).length === 0) return { ok: false, error: "ไม่มีราคาที่เปลี่ยน" };
  const r = await authed<PlanPrices>("/admin/plan-prices", { method: "PUT", body: { prices: clean } });
  if (!r.ok) return r;
  return { ok: true, data: { ...r.data, siteRefreshed: await revalidateSite() } };
}

// ── FX + reconciliation ─────────────────────────────────────────────────────

export async function getFxAction(): Promise<ActionResult<FxView>> {
  return authed<FxView>("/admin/fx");
}

/** `null` clears the override (back to the daily fetched rate). */
export async function setFxOverrideAction(usdThb: number | null): Promise<ActionResult<FxView>> {
  if (!validFxOverride(usdThb)) return { ok: false, error: `อัตราต้องอยู่ระหว่าง ${FX_BAND[0]}–${FX_BAND[1]} บาทต่อดอลลาร์` };
  return authed<FxView>("/admin/fx", { method: "PUT", body: { usd_thb: usdThb } });
}

export async function refreshFxAction(): Promise<ActionResult<FxView>> {
  return authed<FxView>("/admin/fx/refresh", { method: "POST" });
}

export async function getReconciliationAction(month: string): Promise<ActionResult<Reconciliation>> {
  if (!validMonth(month)) return { ok: false, error: GENERIC };
  return authed<Reconciliation>(`/admin/reconciliation?month=${month}`);
}

export async function saveInvoiceAction(
  month: string, vendor: Vendor, amountThb: number, note: string | null,
): Promise<ActionResult<Reconciliation>> {
  if (!validMonth(month) || !validInvoice(vendor, amountThb)) return { ok: false, error: "ยอดใบแจ้งหนี้ไม่ถูกต้อง" };
  const cleanNote = typeof note === "string" && note.trim() ? note.trim().slice(0, 200) : null;
  return authed<Reconciliation>(`/admin/reconciliation/${month}`, {
    method: "PUT",
    body: { vendor, amount_thb: amountThb, note: cleanNote },
  });
}

// ── billing config + circuit breaker ───────────────────────────────────────

/** Reference cost and sell price per 1M — display/margin only; charges come from code. */
export async function saveBillingConfigAction(referenceThb: number, sellThb: number): Promise<ActionResult<BillingConfigView>> {
  if (!validPer1M(referenceThb) || !validPer1M(sellThb)) return { ok: false, error: "ราคาต่อ 1 ล้านโทเค็นต้องมากกว่า 0 และไม่เกิน ฿10,000" };
  return authed<BillingConfigView>("/admin/billing-config", {
    method: "PUT",
    body: { reference_thb_per_1m: referenceThb, sell_thb_per_1m: sellThb },
  });
}

export async function getCircuitBreakerAction(): Promise<ActionResult<CircuitBreaker>> {
  return authed<CircuitBreaker>("/admin/circuit-breaker");
}

export async function getVendorQuotaAction(): Promise<ActionResult<VendorQuota>> {
  return authed<VendorQuota>("/admin/vendor-quota");
}

export async function saveCircuitBreakerAction(b: BreakerSettings): Promise<ActionResult<CircuitBreaker>> {
  if (!validBreaker(b)) return { ok: false, error: "ค่าเพดานไม่ถูกต้อง — เพดาน 0–10,000,000 บาท ตัวคูณหยุดทันที 1–10" };
  const email = typeof b.alert_email === "string" && b.alert_email.trim() ? b.alert_email.trim() : null;
  return authed<CircuitBreaker>("/admin/circuit-breaker", {
    method: "PUT",
    body: { enabled: b.enabled, daily_cap_thb: b.daily_cap_thb, hard_stop_ratio: b.hard_stop_ratio, alert_email: email },
  });
}

// ── blog moderation + MCP connectors ─────────────────────────────────────────

export async function getBlogOverviewAction(status: string, source: string): Promise<ActionResult<BlogOverview>> {
  if (!validStatus(status) || !validSource(source)) return { ok: false, error: GENERIC };
  const q = new URLSearchParams({ limit: "200" });
  if (status) q.set("status", status);
  if (source) q.set("source", source);
  const [posts, settings, connectors, audit, categories] = await Promise.all([
    authed<{ items: PostRow[]; total: number }>(`/admin/blog/posts?${q}`),
    authed<BlogSettings>("/admin/blog/settings"),
    authed<Connector[]>("/admin/blog/connectors"),
    authed<AuditEntry[]>("/admin/blog/audit?limit=100"),
    authed<Category[]>("/admin/blog/categories"),
  ]);
  if (!posts.ok) return posts;
  if (!settings.ok) return settings;
  if (!connectors.ok) return connectors;
  if (!audit.ok) return audit;
  if (!categories.ok) return categories;
  return {
    ok: true,
    data: {
      posts: posts.data.items, total: posts.data.total, settings: settings.data,
      connectors: connectors.data, audit: audit.data, categories: categories.data,
    },
  };
}

export async function getBlogPostAction(slug: string): Promise<ActionResult<PostFull>> {
  if (!validSlug(slug)) return { ok: false, error: GENERIC };
  return authed<PostFull>(`/admin/blog/posts/${slug}`);
}

/** Saving marks the post as the owner's (source = human): MCP can no longer change it. */
export async function saveBlogPostAction(slug: string, edit: PostEdit): Promise<ActionResult<PostFull>> {
  if (!validSlug(slug) || !edit || typeof edit !== "object") return { ok: false, error: GENERIC };
  const problems = editProblems(edit);
  if (problems.length) return { ok: false, error: problems.join(" · ") };
  const body: Record<string, unknown> = {
    title: edit.title.trim(),
    meta_title: edit.meta_title.trim(),
    meta_description: edit.meta_description.trim(),
    excerpt: edit.excerpt.trim(),
    content_md: edit.content_md,
    cover_image_url: edit.cover_image_url?.trim() || null,
    cover_alt: edit.cover_alt?.trim() || null,
    category: edit.category,
    tags: edit.tags.map((t) => ({ slug: t.slug, name: t.name })),
    faq: edit.faq.map((f) => ({ question: f.question.trim(), answer: f.answer.trim() })),
  };
  if (edit.new_slug && edit.new_slug !== slug) body.new_slug = edit.new_slug;
  return authed<PostFull>(`/admin/blog/posts/${slug}`, { method: "PUT", body });
}

export async function publishBlogPostAction(slug: string, publish: boolean): Promise<ActionResult<{ post: PostFull }>> {
  if (!validSlug(slug) || typeof publish !== "boolean") return { ok: false, error: GENERIC };
  return authed<{ post: PostFull }>(`/admin/blog/posts/${slug}/${publish ? "publish" : "unpublish"}`, { method: "POST" });
}

/** `null` = follow the server's env value again. */
export async function saveBlogSettingsAction(autoPublish: boolean | null, maxPerDay: number | null): Promise<ActionResult<BlogSettings>> {
  if (autoPublish !== null && typeof autoPublish !== "boolean") return { ok: false, error: GENERIC };
  if (maxPerDay !== null && (!Number.isInteger(maxPerDay) || maxPerDay < 0 || maxPerDay > 50)) {
    return { ok: false, error: "เพดานต่อวันต้องเป็นจำนวนเต็ม 0–50" };
  }
  return authed<BlogSettings>("/admin/blog/settings", { method: "PUT", body: { auto_publish: autoPublish, max_per_day: maxPerDay } });
}

export async function revokeConnectorAction(grantId: number): Promise<ActionResult<{ revoked: boolean }>> {
  if (!validId(grantId)) return { ok: false, error: GENERIC };
  return authed<{ revoked: boolean }>(`/admin/blog/connectors/${grantId}/revoke`, { method: "POST" });
}

/** The consent screen's decision → where to send the browser back to (the connector's callback). */
export async function decideConnectAction(requestId: string, approve: boolean): Promise<ActionResult<{ redirect_to: string }>> {
  if (!validRequestId(requestId) || typeof approve !== "boolean") return { ok: false, error: GENERIC };
  const r = await authed<{ redirect_to: string }>(`/admin/blog/oauth/requests/${requestId}/${approve ? "approve" : "deny"}`, { method: "POST" });
  // The backend only ever answers with the client's registered (allow-listed)
  // callback; refuse anything that is not an https or loopback URL anyway.
  if (r.ok && !/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(r.data.redirect_to)) return { ok: false, error: GENERIC };
  return r;
}

// ── media library (คลังสื่อ) ─────────────────────────────────────────────────

export async function getMediaAction(kind: string, archived: boolean): Promise<ActionResult<{ items: MediaItem[]; total: number }>> {
  if (!validMediaKind(kind) || typeof archived !== "boolean") return { ok: false, error: GENERIC };
  const q = new URLSearchParams({ limit: "200" });
  if (kind) q.set("kind", kind);
  if (archived) q.set("archived", "true");
  return authed<{ items: MediaItem[]; total: number }>(`/admin/blog/media?${q}`);
}

/** One upload: the file plus kind / alt / description / tags, re-checked by the backend (bytes, size, kind). */
export async function uploadMediaAction(formData: FormData): Promise<ActionResult<MediaItem>> {
  if (!(formData instanceof FormData)) return { ok: false, error: GENERIC };
  const file = formData.get("file");
  const kind = formData.get("kind");
  const alt = String(formData.get("alt") ?? "");
  const description = String(formData.get("description") ?? "");
  const tags = parseMediaTags(String(formData.get("tags") ?? ""));
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "เลือกไฟล์ก่อน" };
  if (!validMediaKind(kind) || !kind) return { ok: false, error: "เลือกประเภทสื่อ" };
  if (file.size > MEDIA_MAX_MB[kind] * 1024 * 1024) return { ok: false, error: `ไฟล์ใหญ่เกิน ${MEDIA_MAX_MB[kind]} MB` };
  const problems = mediaTextProblems(alt, description);
  if (problems.length) return { ok: false, error: problems.join(" · ") };
  const form = new FormData();
  form.set("file", file, file.name.slice(0, 200) || "upload");
  form.set("kind", kind);
  form.set("alt", alt.trim());
  form.set("description", description.trim());
  form.set("tags", tags.join(","));
  return authed<MediaItem>("/admin/blog/media", { method: "POST", form, timeoutMs: 180_000 });
}

export async function updateMediaAction(
  id: number,
  changes: { alt?: string; description?: string; tags?: string[]; archived?: boolean },
): Promise<ActionResult<MediaItem>> {
  if (!validId(id) || !changes || typeof changes !== "object") return { ok: false, error: GENERIC };
  const body: Record<string, unknown> = {};
  if (typeof changes.alt === "string") body.alt = changes.alt.trim();
  if (typeof changes.description === "string") body.description = changes.description.trim();
  if (Array.isArray(changes.tags)) body.tags = parseMediaTags(changes.tags.join(","));
  if (typeof changes.archived === "boolean") body.archived = changes.archived;
  if (body.alt !== undefined || body.description !== undefined) {
    const problems = mediaTextProblems(String(body.alt ?? "ok-alt"), String(body.description ?? ""));
    if (problems.length) return { ok: false, error: problems.join(" · ") };
  }
  return authed<MediaItem>(`/admin/blog/media/${id}`, { method: "PATCH", body });
}

// ── writing brief + content plan ─────────────────────────────────────────────

export async function getPlanningAction(): Promise<ActionResult<{ brief: Brief; plan: PlanItem[] }>> {
  const [brief, plan] = await Promise.all([authed<Brief>("/admin/blog/brief"), authed<PlanItem[]>("/admin/blog/plan")]);
  if (!brief.ok) return brief;
  if (!plan.ok) return plan;
  return { ok: true, data: { brief: brief.data, plan: plan.data } };
}

export async function saveBriefAction(brief: Omit<Brief, "updated_at">): Promise<ActionResult<Brief>> {
  if (!brief || typeof brief !== "object") return { ok: false, error: GENERIC };
  const body: Record<string, string> = {};
  for (const f of BRIEF_FIELDS) {
    const v = brief[f.key];
    if (typeof v !== "string") return { ok: false, error: GENERIC };
    if (v.length > f.max) return { ok: false, error: `${f.label}ยาวเกิน ${f.max} ตัวอักษร` };
    body[f.key] = v;
  }
  return authed<Brief>("/admin/blog/brief", { method: "PUT", body });
}

export async function addTopicAction(topic: string, notes: string): Promise<ActionResult<PlanItem>> {
  if (typeof topic !== "string" || typeof notes !== "string") return { ok: false, error: GENERIC };
  if (topic.trim().length < 3 || topic.length > 200) return { ok: false, error: "หัวข้อต้องยาว 3–200 ตัวอักษร" };
  if (notes.length > 1000) return { ok: false, error: "หมายเหตุยาวได้ไม่เกิน 1000 ตัวอักษร" };
  return authed<PlanItem>("/admin/blog/plan", { method: "POST", body: { topic: topic.trim(), notes: notes.trim() } });
}

export async function updateTopicAction(
  id: number,
  changes: { topic?: string; notes?: string; status?: PlanStatus; post_slug?: string | null },
): Promise<ActionResult<PlanItem>> {
  if (!validId(id) || !changes || typeof changes !== "object") return { ok: false, error: GENERIC };
  const body: Record<string, unknown> = {};
  if (typeof changes.topic === "string") body.topic = changes.topic.trim();
  if (typeof changes.notes === "string") body.notes = changes.notes.trim();
  if (changes.status !== undefined) {
    if (!validPlanStatus(changes.status)) return { ok: false, error: GENERIC };
    body.status = changes.status;
  }
  if (changes.post_slug === null) body.clear_post = true;
  else if (typeof changes.post_slug === "string" && changes.post_slug) {
    if (!validSlug(changes.post_slug)) return { ok: false, error: "slug ใช้ได้เฉพาะ a-z 0-9 และขีดกลาง" };
    body.post_slug = changes.post_slug;
  }
  return authed<PlanItem>(`/admin/blog/plan/${id}`, { method: "PATCH", body });
}

export async function deleteTopicAction(id: number): Promise<ActionResult<{ deleted: number }>> {
  if (!validId(id)) return { ok: false, error: GENERIC };
  return authed<{ deleted: number }>(`/admin/blog/plan/${id}`, { method: "DELETE" });
}

export async function reorderPlanAction(ids: number[]): Promise<ActionResult<PlanItem[]>> {
  if (!Array.isArray(ids) || ids.length > 200 || !ids.every(validId) || new Set(ids).size !== ids.length) return { ok: false, error: GENERIC };
  return authed<PlanItem[]>("/admin/blog/plan/order", { method: "PUT", body: { ids } });
}
