"use client";

import Link from "next/link";
import { useActionState } from "react";
import { resetPasswordAction } from "@/app/actions/auth";
import type { ActionState } from "@/lib/messages";

/** New password + confirmation -> POST /auth/reset-password (via a Server Action). */
export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(resetPasswordAction, undefined);
  const errors = state?.fieldErrors ?? {};

  return (
    <form action={action} className="stack">
      {/* The token only travels back to our own server; the action never logs or echoes it. */}
      <input type="hidden" name="token" value={token} />
      <input type="text" name="username" autoComplete="username" hidden readOnly />
      <div className="field">
        <label htmlFor="r-new">รหัสผ่านใหม่</label>
        <input
          id="r-new"
          name="new_password"
          className="input"
          type="password"
          placeholder="อย่างน้อย 8 ตัวอักษร"
          autoComplete="new-password"
          minLength={8}
          required
          aria-invalid={errors.new_password ? true : undefined}
          aria-describedby={errors.new_password ? "r-new-error" : undefined}
        />
        {errors.new_password ? <p className="field-error" id="r-new-error">{errors.new_password}</p> : null}
      </div>
      <div className="field">
        <label htmlFor="r-confirm">ยืนยันรหัสผ่านใหม่</label>
        <input
          id="r-confirm"
          name="confirm_password"
          className="input"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          aria-invalid={errors.confirm_password ? true : undefined}
          aria-describedby={errors.confirm_password ? "r-confirm-error" : undefined}
        />
        {errors.confirm_password ? <p className="field-error" id="r-confirm-error">{errors.confirm_password}</p> : null}
      </div>
      {state?.error ? (
        <div role="alert">
          <p className="form-error">{state.error}</p>
          {state.expired ? (
            <p className="form-error" style={{ marginTop: 4 }}>
              <Link href="/login?forgot=1">ขอลิงก์ตั้งรหัสผ่านใหม่อีกครั้ง</Link>
            </p>
          ) : null}
        </div>
      ) : null}
      <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={pending} aria-busy={pending || undefined}>
        {pending ? "กำลังบันทึก…" : "ตั้งรหัสผ่านใหม่"}
      </button>
    </form>
  );
}
