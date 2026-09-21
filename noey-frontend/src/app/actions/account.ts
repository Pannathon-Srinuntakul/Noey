"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { MSG, type ActionState } from "@/lib/messages";
import { passwordProblem } from "@/lib/password";
import type { MeOut } from "@/lib/server/api";
import { authedApi, writeDisplayName, writeSession } from "@/lib/server/session";
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
