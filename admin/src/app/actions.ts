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
import { CHALLENGE_MAX_AGE, isAdminTokens, spec } from "@/lib/session";
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

async function authed<T>(path: string, init: { method?: "GET" | "POST" | "PUT" | "PATCH"; body?: unknown } = {}): Promise<ActionResult<T>> {
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

export type LoginState = { step: "login" | "otp"; error?: string; sentTo?: string; email?: string; notice?: string };

function text(formData: FormData, key: string, max = 300): string {
  const v = formData.get(key);
  return typeof v === "string" ? v.slice(0, max) : "";
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
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
  if (r.data.status === "signed_in" && isAdminTokens(r.data)) {
    await writeTokens(r.data);
    redirect("/");
  }
  if (r.data.status === "otp_required" && typeof r.data.challenge_id === "string") {
    const c = spec("challenge", r.data.challenge_id, CHALLENGE_MAX_AGE, COOKIE_SECURE);
    (await cookies()).set(c.name, c.value, c.options);
    return { step: "otp", sentTo: String(r.data.sent_to ?? ""), email };
  }
  return { step: "login", error: GENERIC, email };
}

export async function verifyAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const code = text(formData, "code", 12).replace(/\D/g, "");
  const sentTo = text(formData, "sentTo", 255);
  if (!(await sameOrigin())) return { step: "otp", error: GENERIC, sentTo };
  if (code.length !== 6) return { step: "otp", error: "กรอกรหัสให้ครบ 6 หลัก", sentTo };
  const challenge = await readCookie("challenge");
  if (!challenge) return { step: "login", error: "รหัสหมดอายุแล้ว กรุณาเข้าสู่ระบบใหม่" };
  const r = await adminApi<unknown>("/admin/auth/verify", {
    method: "POST",
    body: { challenge_id: challenge, code, remember_device: true },
  });
  if (!r.ok) {
    if (r.status === 429) return { step: "otp", error: r.detail ?? "ลองผิดหลายครั้งเกินไป", sentTo };
    if (r.status === 401) return { step: "otp", error: r.detail ?? "รหัสไม่ถูกต้องหรือหมดอายุ", sentTo };
    return { step: "otp", error: r.status === 0 ? UNREACHABLE : GENERIC, sentTo };
  }
  await deleteCookie("challenge");
  await writeTokens(r.data);
  redirect("/");
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

export async function backToLoginAction(): Promise<void> {
  if (!(await sameOrigin())) return;
  await deleteCookie("challenge");
}

/** The login screen's one form action: `intent` = login | verify | back. */
export async function authAction(prev: LoginState, formData: FormData): Promise<LoginState> {
  const intent = text(formData, "intent", 10);
  if (intent === "verify") return verifyAction(prev, formData);
  if (intent === "back") {
    await backToLoginAction();
    return { step: "login", email: prev.email };
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
