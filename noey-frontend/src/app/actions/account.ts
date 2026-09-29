"use server";

import { refresh } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { REAUTH_COOKIE, REAUTH_COOKIE_PATH, apiErrorInfo, deleteAccountMessage } from "@/lib/google-auth";
import { COOKIE_SECURE } from "@/lib/server/config";
import { MSG, type ActionState } from "@/lib/messages";
import { passwordProblem } from "@/lib/password";
import type { MeOut } from "@/lib/server/api";
import { authedApi, clearSession, writeDisplayName, writeSession } from "@/lib/server/session";
import { isTokenPair, loginPathFor, sanitizeDisplayName } from "@/lib/session";

const EMAIL_PATTERN = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/** PATCH /auth/me { display_name } */
export async function updateProfileAction(_previous: ActionState | undefined, formData: FormData): Promise<ActionState> {
  const name = sanitizeDisplayName(text(formData, "name"));
  const values = { name };
  if (!name) return { fieldErrors: { name: "กรอกชื่อที่อยากให้แสดง" }, values };

  const outcome = await authedApi<MeOut>("/auth/me", { method: "PATCH", body: { display_name: name } }, { mutable: true });
  if (outcome.kind === "unauthenticated") redirect(loginPathFor("/account/profile"));
  if (outcome.kind !== "ok") return { error: MSG.generic, values };
  const result = outcome.result;
  if (result.ok) {
    const saved = sanitizeDisplayName(result.data?.display_name ?? name);
    await writeDisplayName(saved);
    refresh();
    return { ok: true, success: "บันทึกชื่อแล้ว", values: { name: saved } };
  }
  if (result.status === 422) return { fieldErrors: { name: "ชื่อนี้ใช้ไม่ได้ ลองชื่ออื่นที่สั้นลง" }, values };
  if (result.status === 429) return { error: MSG.rateLimited, values };
  return { error: MSG.generic, values };
}

/**
 * POST /auth/change-password -> 200 TokenOut. The backend revokes every other
 * session, so this browser's cookies are replaced with the new pair.
 */
export async function changePasswordAction(_previous: ActionState | undefined, formData: FormData): Promise<ActionState> {
  const current = text(formData, "current_password");
  const next = text(formData, "new_password");

  const fieldErrors: Record<string, string> = {};
  if (!current) fieldErrors.current_password = "กรอกรหัสผ่านเดิม";
  const passwordError = passwordProblem(next);
  if (passwordError) fieldErrors.new_password = passwordError;
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const outcome = await authedApi<unknown>(
    "/auth/change-password",
    { method: "POST", body: { current_password: current, new_password: next } },
    { mutable: true },
  );
  if (outcome.kind === "unauthenticated") redirect(loginPathFor("/account/profile"));
  if (outcome.kind !== "ok") return { error: MSG.generic };
  const result = outcome.result;
  if (result.ok) {
    if (isTokenPair(result.data)) await writeSession(result.data);
    return { ok: true, success: "เปลี่ยนรหัสผ่านแล้ว อุปกรณ์อื่นที่เคยเข้าสู่ระบบไว้จะต้องเข้าสู่ระบบใหม่" };
  }
  if (result.status === 400) return { fieldErrors: { current_password: "รหัสผ่านเดิมไม่ถูกต้อง" } };
  if (result.status === 422) return { fieldErrors: { new_password: MSG.passwordRule } };
  if (result.status === 429) return { error: MSG.rateLimited };
  return { error: MSG.generic };
}

/**
 * POST /auth/change-email {new_email, current_password} -> 202. The address
 * changes only after the link sent to the NEW address is opened
 * (/verify-email, purpose "change_email").
 */
export async function changeEmailAction(_previous: ActionState | undefined, formData: FormData): Promise<ActionState> {
  const newEmail = text(formData, "new_email").trim();
  const current = text(formData, "current_password");
  const values = { new_email: newEmail };

  const fieldErrors: Record<string, string> = {};
  if (!EMAIL_PATTERN.test(newEmail)) fieldErrors.new_email = "กรอกอีเมลใหม่ให้ถูกต้อง";
  else if (newEmail.toLowerCase() === text(formData, "current_email").trim().toLowerCase()) fieldErrors.new_email = "นี่คืออีเมลที่ใช้อยู่แล้ว";
  if (!current) fieldErrors.current_password = "กรอกรหัสผ่านปัจจุบันเพื่อยืนยันว่าเป็นคุณ";
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors, values };

  const outcome = await authedApi<unknown>(
    "/auth/change-email",
    { method: "POST", body: { new_email: newEmail, current_password: current } },
    { mutable: true },
  );
  if (outcome.kind === "unauthenticated") redirect(loginPathFor("/account/profile"));
  if (outcome.kind !== "ok") return { error: MSG.generic, values };
  const result = outcome.result;
  if (result.ok) return { ok: true, success: "ส่งลิงก์ยืนยันไปที่อีเมลใหม่แล้ว อีเมลจะเปลี่ยนหลังกดลิงก์ในอีเมลนั้น" };
  switch (result.status) {
    case 400:
      return { fieldErrors: { current_password: "รหัสผ่านปัจจุบันไม่ถูกต้อง" }, values };
    case 409:
      return { fieldErrors: { new_email: "อีเมลนี้ถูกใช้กับบัญชีอื่นแล้ว" }, values };
    case 422:
      return { fieldErrors: { new_email: "กรอกอีเมลใหม่ให้ถูกต้อง" }, values };
    case 429:
      return { error: MSG.rateLimited, values };
    case 503:
      return { error: MSG.emailUnavailable, values };
    default:
      return { error: MSG.generic, values };
  }
}

/** POST /auth/resend-verification -> 202 / 409 already verified / 429 / 503. */
export async function resendVerificationAction(): Promise<ActionState> {
  const outcome = await authedApi<unknown>("/auth/resend-verification", { method: "POST" }, { mutable: true });
  if (outcome.kind === "unauthenticated") redirect(loginPathFor("/account"));
  if (outcome.kind !== "ok") return { error: MSG.generic };
  const result = outcome.result;
  if (result.ok) return { ok: true, success: "ส่งลิงก์ยืนยันใหม่แล้ว ตรวจกล่องอีเมล (และโฟลเดอร์สแปม) ได้เลย" };
  if (result.status === 409) {
    // Already verified (e.g. in another tab): re-render so the banner disappears.
    refresh();
    return { ok: true, success: "อีเมลนี้ยืนยันเรียบร้อยแล้ว" };
  }
  if (result.status === 429) return { error: MSG.rateLimited };
  if (result.status === 503) return { error: MSG.emailUnavailable };
  return { error: MSG.generic };
}

/** State of the delete-account dialog between submits. */
export interface DeleteAccountState extends ActionState {
  /** 409 wallet_balance: the prepaid balance (satang) the person must agree to forfeit. */
  walletBalanceSatang?: number;
  /** The Google re-auth proof was missing or expired: start that step again. */
  reauthAgain?: boolean;
}

async function dropReauthProof(): Promise<void> {
  (await cookies()).set(REAUTH_COOKIE, "", { path: REAUTH_COOKIE_PATH, maxAge: 0, httpOnly: true, secure: COOKIE_SECURE, sameSite: "lax" });
}

/**
 * POST /auth/delete-account (PDPA self-service deletion).
 *
 * Re-authentication is required: the current password, or — for an account
 * without one — the 5-minute Google proof that /auth/google/callback parked
 * in an HttpOnly cookie. 204 means every token is already dead server-side,
 * so the cookies are dropped and the visitor lands on the goodbye page.
 * Any other answer leaves the account intact; the dialog says why.
 */
export async function deleteAccountAction(_previous: DeleteAccountState | undefined, formData: FormData): Promise<DeleteAccountState> {
  const password = text(formData, "password");
  const method = text(formData, "method") === "google" ? "google" : "password";
  const forfeit = text(formData, "forfeit_wallet_balance") === "yes";
  if (text(formData, "understand") !== "yes") {
    return { fieldErrors: { understand: "ติ๊กยืนยันว่าเข้าใจว่าการลบบัญชีกู้คืนไม่ได้" } };
  }

  let reauthToken: string | undefined;
  if (method === "google") {
    reauthToken = (await cookies()).get(REAUTH_COOKIE)?.value || undefined;
    if (!reauthToken) return { error: deleteAccountMessage(400, "reauth_invalid"), reauthAgain: true };
  } else if (!password) {
    return { fieldErrors: { password: "กรอกรหัสผ่านปัจจุบันเพื่อยืนยันว่าเป็นคุณ" } };
  }

  const outcome = await authedApi<unknown>(
    "/auth/delete-account",
    {
      method: "POST",
      body: {
        password: method === "password" ? password : undefined,
        reauth_token: reauthToken,
        forfeit_wallet_balance: forfeit,
      },
      // Deletion walks every project and file; give it longer than a normal call.
      timeoutMs: 60_000,
    },
    { mutable: true },
  );
  if (outcome.kind === "unauthenticated") redirect(loginPathFor("/account/profile"));
  if (outcome.kind !== "ok") return { error: deleteAccountMessage(0, null) };
  const result = outcome.result;

  if (result.ok) {
    await dropReauthProof();
    await clearSession();
    redirect("/account-deleted");
  }

  const { code, balanceSatang } = apiErrorInfo(result.data);
  if (code === "wallet_balance") {
    return { walletBalanceSatang: balanceSatang ?? 0, error: deleteAccountMessage(result.status, code) };
  }
  if (code === "wrong_password") return { fieldErrors: { password: deleteAccountMessage(result.status, code) } };
  if (code === "reauth_invalid" || code === "reauth_required") {
    await dropReauthProof();
    return { error: deleteAccountMessage(result.status, code), reauthAgain: method === "google" };
  }
  return { error: deleteAccountMessage(result.status, code) };
}

/** DELETE /auth/google — refused (409) while the account has no password. */
export async function unlinkGoogleAction(): Promise<ActionState> {
  const outcome = await authedApi<unknown>("/auth/google", { method: "DELETE" }, { mutable: true });
  if (outcome.kind === "unauthenticated") redirect(loginPathFor("/account/profile"));
  if (outcome.kind !== "ok") return { error: MSG.generic };
  const result = outcome.result;
  if (result.ok || result.status === 404) {
    refresh();
    return { ok: true, success: "ยกเลิกการเชื่อมต่อบัญชี Google แล้ว" };
  }
  const { code } = apiErrorInfo(result.data);
  if (code === "password_required") {
    return { error: "กรุณาตั้งรหัสผ่านก่อนยกเลิกการเชื่อมต่อ Google (ใช้ “ลืมรหัสผ่าน”) ไม่อย่างนั้นจะเข้าสู่ระบบไม่ได้อีก" };
  }
  if (result.status === 429) return { error: MSG.rateLimited };
  return { error: MSG.generic };
}
