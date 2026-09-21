"use client";

import { useActionState } from "react";
import { resendVerificationAction } from "@/app/actions/account";
import type { ActionState } from "@/lib/messages";

/** POST /auth/resend-verification: 202 sent / 409 already verified / 429 / 503. */
export function ResendVerificationButton({ variant = "secondary" }: { variant?: "secondary" | "primary" }) {
  const [state, action, pending] = useActionState<ActionState | undefined>(resendVerificationAction, undefined);
  return (
    <form action={action} style={{ margin: 0 }}>
      <button type="submit" className={`btn btn-${variant}`} style={{ fontSize: 14 }} disabled={pending || !!state?.ok} aria-busy={pending || undefined}>
        {pending ? "กำลังส่ง…" : "ส่งลิงก์ยืนยันอีกครั้ง"}
      </button>
      <div aria-live="polite">
        {state?.success ? <p className="form-success" role="status">{state.success}</p> : null}
        {state?.error ? <p className="form-error" role="alert">{state.error}</p> : null}
      </div>
    </form>
  );
}

/**
 * Shown across the account area while `GET /auth/me` says email_verified is
 * false (e.g. right after sign-up). Informational only: the backend is what
 * gates AI work in the app; nothing on this site is blocked.
 */
export function VerifyEmailBanner({ email }: { email: string }) {
  return (
    <div className="notice verify-banner" role="status">
      <p>
        ยืนยันอีเมลเพื่อเริ่มใช้งาน AI — เราส่งลิงก์ไปที่ <strong>{email}</strong> แล้ว
      </p>
      <p className="verify-banner__hint">ไม่เจออีเมล ลองดูในโฟลเดอร์สแปม หรือขอลิงก์ใหม่</p>
      <div style={{ marginTop: 10 }}>
        <ResendVerificationButton />
      </div>
    </div>
  );
}
