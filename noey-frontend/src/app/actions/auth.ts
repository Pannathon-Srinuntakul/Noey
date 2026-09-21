"use server";

import { redirect } from "next/navigation";
import { decidePlanAction, normalizeBillingMe } from "@/lib/billing";
import { TURNSTILE_FIELD } from "@/lib/contact";
import { MSG, type ActionState } from "@/lib/messages";
import { passwordProblem } from "@/lib/password";
import { isPaidTier, lookupKeyFor } from "@/lib/plans";
import { isSafeExternalRedirect } from "@/lib/redirect-url";
import { apiRequest, type MeOut } from "@/lib/server/api";
import { getPriceTable } from "@/lib/server/prices";
import { authedApi, clearSession, writeSession } from "@/lib/server/session";
import { isTokenPair, sanitizeDisplayName, sanitizeNextPath, type TokenPair } from "@/lib/session";

const EMAIL_PATTERN = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;
const NAME_MAX = 60;

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/** Cookies for a fresh token pair, greeting the user by their /auth/me name. */
async function startSession(tokens: TokenPair, displayName?: string | null): Promise<void> {
  if (displayName === undefined) {
    const me = await apiRequest<MeOut>("/auth/me", { token: tokens.access_token });
    displayName = me.ok ? (me.data.display_name ?? null) : null;
  }
  await writeSession(tokens, displayName);
}

export async function loginAction(_previous: ActionState | undefined, formData: FormData): Promise<ActionState> {
  const email = text(formData, "email").trim();
  const password = text(formData, "password");
  const next = sanitizeNextPath(text(formData, "next"));
  const values = { email };

  if (!email || !password) return { error: "กรอกอีเมลและรหัสผ่านให้ครบ", values };

  const login = await apiRequest<unknown>("/auth/login", { method: "POST", body: { email, password } });
  if (!login.ok) {
    if (login.status === 401) return { error: "อีเมลหรือรหัสผ่านไม่ถูกต้อง", values };
    if (login.status === 403) return { error: "บัญชีนี้ยังเข้าใช้งานไม่ได้ ติดต่อทีมงานได้ที่หน้าเกี่ยวกับเรา", values };
    if (login.status === 422) return { error: "ตรวจสอบอีเมลและรหัสผ่านอีกครั้ง", values };
    if (login.status === 429) return { error: MSG.rateLimited, values };
    return { error: MSG.generic, values };
  }
  if (!isTokenPair(login.data)) return { error: MSG.generic, values };
  await startSession(login.data);
  redirect(next);
}

/**
 * Sign-up. On success: cookies, then /account (which shows the "verify your
 * email" banner) — or, when the visitor came from a paid-plan button
 * (/signup?plan=pro), straight on to Checkout for it.
 */
export async function signupAction(_previous: ActionState | undefined, formData: FormData): Promise<ActionState> {
  const name = sanitizeDisplayName(text(formData, "name"));
  const email = text(formData, "email").trim();
  const password = text(formData, "password");
  const plan = text(formData, "plan");
  const turnstileToken = text(formData, TURNSTILE_FIELD);
  const values = { name, email };

  const fieldErrors: Record<string, string> = {};
  if (name.length > NAME_MAX) fieldErrors.name = `ชื่อยาวได้ไม่เกิน ${NAME_MAX} ตัวอักษร`;
  if (!EMAIL_PATTERN.test(email)) fieldErrors.email = "กรอกอีเมลให้ถูกต้อง";
  const passwordError = passwordProblem(password);
  if (passwordError) fieldErrors.password = passwordError;
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors, values };

  const register = await apiRequest<unknown>("/auth/register", {
    method: "POST",
    body: {
      email,
      password,
      display_name: name || undefined,
      turnstile_token: turnstileToken || undefined,
    },
  });

  if (!register.ok) {
    switch (register.status) {
      case 403:
      case 501: // today's backend answers 501 while registration is switched on but not built
        return { error: MSG.registrationClosed, values };
      case 409:
        return { error: "อีเมลนี้มีบัญชีอยู่แล้ว เข้าสู่ระบบด้วยอีเมลนี้ได้เลย", fieldErrors: { email: "อีเมลนี้มีบัญชีอยู่แล้ว" }, values };
      case 422:
        return { error: "ตรวจสอบอีเมล และตั้งรหัสผ่านอย่างน้อย 8 ตัวอักษร", values };
      case 400:
        return { error: MSG.captchaFailed, values };
      case 429:
        return { error: MSG.rateLimited, values };
      default:
        return { error: MSG.generic, values };
    }
  }
  if (!isTokenPair(register.data)) return { error: MSG.generic, values };
  await startSession(register.data, name || null);

  if (isPaidTier(plan)) {
    const table = await getPriceTable({ fallbackOnError: true });
    const lookupKey = lookupKeyFor(table, plan);
    const billing = await authedApi<unknown>("/billing/me", {}, { mutable: true });
    const decision = decidePlanAction({
      tier: plan,
      lookupKey,
      signedIn: true,
      billing: billing.kind === "ok" && billing.result.ok ? normalizeBillingMe(billing.result.data) : null,
    });
    if (decision.kind === "checkout") {
      const checkout = await authedApi<{ url?: unknown }>(
        "/billing/checkout",
        { method: "POST", body: { lookup_key: lookupKey } },
        { mutable: true },
      );
      if (checkout.kind === "ok" && checkout.result.ok && isSafeExternalRedirect(checkout.result.data?.url)) {
        redirect(checkout.result.data.url as string);
      }
    }
    // Account exists either way; the billing page explains what happened and keeps the plan picked.
    redirect(`/account/billing?plan=${plan}&from=signup`);
  }
  redirect("/account");
}

export async function signOutAction(): Promise<void> {
  // Ends this browser's session. (Password changes revoke the other sessions server-side.)
  await clearSession();
  redirect("/");
}

/**
 * POST /auth/forgot-password — always answered 202 by the backend, whether or
 * not an account exists, so the message is deliberately neutral.
 */
export async function forgotPasswordAction(_previous: ActionState | undefined, formData: FormData): Promise<ActionState> {
  const email = text(formData, "email").trim();
  const values = { email };
  if (!EMAIL_PATTERN.test(email)) return { fieldErrors: { email: "กรอกอีเมลที่ใช้สมัครให้ถูกต้อง" }, values };
  const turnstileToken = text(formData, TURNSTILE_FIELD);

  const result = await apiRequest("/auth/forgot-password", {
    method: "POST",
    body: { email, turnstile_token: turnstileToken || undefined },
  });
  if (result.ok) return { ok: true, success: MSG.forgotSent, values };
  if (result.status === 429) return { error: MSG.rateLimited, values };
  if (result.status === 400) return { error: MSG.captchaFailed, values };
  if (result.status === 422) return { fieldErrors: { email: "กรอกอีเมลที่ใช้สมัครให้ถูกต้อง" }, values };
  if (result.status === 503) return { error: MSG.emailUnavailable, values };
  return { error: MSG.generic, values };
}

/**
 * POST /auth/reset-password {token, new_password} -> 200 TokenOut. The user is
 * signed in with the new tokens and sent to /account with a success notice.
 * The token arrives as a hidden field from /reset-password?token=… and is
 * never logged or echoed back.
 */
export async function resetPasswordAction(_previous: ActionState | undefined, formData: FormData): Promise<ActionState> {
  const token = text(formData, "token");
  const password = text(formData, "new_password");
  const confirm = text(formData, "confirm_password");

  if (!token) return { error: MSG.linkExpired, expired: true };
  const fieldErrors: Record<string, string> = {};
  const passwordError = passwordProblem(password);
  if (passwordError) fieldErrors.new_password = passwordError;
  else if (password !== confirm) fieldErrors.confirm_password = "รหัสผ่านทั้งสองช่องไม่ตรงกัน";
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const result = await apiRequest<unknown>("/auth/reset-password", { method: "POST", body: { token, new_password: password } });
  if (result.ok && isTokenPair(result.data)) {
    await startSession(result.data);
    redirect("/account?notice=password-reset");
  }
  if (result.status === 400) return { error: MSG.linkExpired, expired: true };
  if (result.status === 422) return { fieldErrors: { new_password: MSG.passwordRule } };
  if (result.status === 429) return { error: MSG.rateLimited };
  return { error: MSG.generic };
}
