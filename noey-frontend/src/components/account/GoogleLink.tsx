"use client";

import { useActionState } from "react";
import { forgotPasswordAction } from "@/app/actions/auth";
import { unlinkGoogleAction } from "@/app/actions/account";
import type { ActionState } from "@/lib/messages";
import { GoogleButton } from "../auth/GoogleButton";
import { keepThai } from "../ds/ThaiText";
import { TURNSTILE_SITE_KEY, TurnstileWidget } from "../forms/TurnstileWidget";

function Feedback({ state }: { state: ActionState | undefined }) {
  return (
    <div aria-live="polite">
      {state?.error ? (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      ) : null}
      {state?.success ? (
        <p className="form-success" role="status">
          {state.success}
        </p>
      ) : null}
    </div>
  );
}

/**
 * "บัญชี Google" on the profile page.
 *  - Not linked: "เชื่อมต่อกับ Google" (intent link: a plain form POST, Google
 *    always asks which account and for consent).
 *  - Linked: the Google address plus "ยกเลิกการเชื่อมต่อ" (DELETE /auth/google),
 *    which the backend refuses while the account has no password.
 */
export function GoogleLinkPanel({
  linked,
  googleEmail,
  hasPassword,
  notice,
}: {
  linked: boolean;
  googleEmail: string | null;
  hasPassword: boolean;
  /** Result of a flow that just came back (?google=<code>), already mapped to Thai. */
  notice: { text: string; ok: boolean } | null;
}) {
  const [state, action, pending] = useActionState<ActionState | undefined>(unlinkGoogleAction, undefined);
  const noticeView = notice && !state ? (
    <p className={notice.ok ? "form-success" : "form-error"} role={notice.ok ? "status" : "alert"}>
      {notice.text}
    </p>
  ) : null;

  if (!linked || state?.ok) {
    return (
      <form method="post" action="/api/auth/google/start" className="stack acct-form acct-form--tight">
        <input type="hidden" name="intent" value="link" />
        <p className="field-hint field-hint--flush">
          {keepThai("เชื่อมต่อแล้วจะเข้าสู่ระบบด้วยปุ่ม “เข้าสู่ระบบด้วย Google” ได้ โดยไม่ต้องพิมพ์รหัสผ่าน")}
        </p>
        <div>
          <GoogleButton label="เชื่อมต่อกับ Google" />
        </div>
        {noticeView}
        <Feedback state={state} />
      </form>
    );
  }

  return (
    <form action={action} className="stack acct-form acct-form--tight">
      <p className="acct-form__line">
        เชื่อมต่ออยู่กับ <strong>{googleEmail || "บัญชี Google"}</strong>
      </p>
      {!hasPassword ? (
        <p className="field-hint field-hint--flush">
          {keepThai("บัญชีนี้ยังไม่มีรหัสผ่าน ตั้งรหัสผ่านก่อนจึงจะยกเลิกการเชื่อมต่อได้ ไม่อย่างนั้นจะเข้าสู่ระบบไม่ได้อีก")}
        </p>
      ) : null}
      <button type="submit" className="btn btn-secondary acct-form__submit" disabled={pending || !hasPassword}>
        {pending ? "กำลังยกเลิก…" : "ยกเลิกการเชื่อมต่อ"}
      </button>
      {noticeView}
      <Feedback state={state} />
    </form>
  );
}

/**
 * A Google-only account has no password, so "change password" (which needs
 * the current one) cannot apply. It sets one through the ordinary reset
 * email instead — proof of the mailbox, same as "ลืมรหัสผ่าน".
 */
export function SetPasswordByEmail({ email }: { email: string }) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(forgotPasswordAction, undefined);
  return (
    <form action={action} className="stack acct-form">
      <input type="hidden" name="email" value={email} />
      <p className="acct-form__line">
        บัญชีนี้เข้าสู่ระบบด้วย Google และยังไม่มีรหัสผ่าน ถ้าต้องการเข้าสู่ระบบด้วยอีเมลได้ด้วย ให้ขอลิงก์ตั้งรหัสผ่านทางอีเมล{" "}
        <strong>{email}</strong>
      </p>
      <TurnstileWidget siteKey={TURNSTILE_SITE_KEY} resetKey={state} />
      <button type="submit" className="btn btn-primary acct-form__submit" disabled={pending || !!state?.ok}>
        {pending ? "กำลังส่ง…" : "ส่งลิงก์ตั้งรหัสผ่าน"}
      </button>
      <Feedback state={state} />
    </form>
  );
}
