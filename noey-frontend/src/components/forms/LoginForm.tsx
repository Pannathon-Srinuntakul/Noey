"use client";

import { useActionState, useState } from "react";
import { forgotPasswordAction, loginAction } from "@/app/actions/auth";
import type { ActionState } from "@/lib/messages";
import { Dialog } from "../ui/Dialog";
import { PendingButton } from "../ui/PendingButton";
import { submitKeepingValues } from "./keepValues";
import { SearchParam } from "./SearchParam";
import { TURNSTILE_SITE_KEY, TurnstileWidget } from "./TurnstileWidget";

/** The "ลืมรหัสผ่าน" dialog -> POST /auth/forgot-password (it only emails a link; the new password is set on /reset-password). */
function ForgotPasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(forgotPasswordAction, undefined);
  const errors = state?.fieldErrors ?? {};
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="ลืมรหัสผ่าน"
      maxWidth={440}
      description={<p style={{ margin: 0 }}>กรอกอีเมลที่ใช้สมัคร เราจะส่งลิงก์ตั้งรหัสผ่านใหม่ไปให้</p>}
    >
      <form action={action} onSubmit={submitKeepingValues(action)} noValidate>
        <div className="field">
          <label htmlFor="f-email">อีเมล</label>
          <input
            id="f-email"
            name="email"
            className="input"
            type="email"
            placeholder="you@email.com"
            autoComplete="email"
            required
            defaultValue={state?.values?.email}
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={errors.email ? "f-email-error" : undefined}
            data-autofocus=""
          />
          {errors.email ? <p className="field-error" id="f-email-error">{errors.email}</p> : null}
        </div>
        <div style={{ marginTop: 12 }}>
          <TurnstileWidget siteKey={TURNSTILE_SITE_KEY} resetKey={state} lazy />
        </div>
        <div aria-live="polite">
          {/* Deliberately neutral: the backend answers 202 whether or not the account exists. */}
          {state?.success ? <p className="form-success" role="status">{state.success}</p> : null}
          {state?.error ? <p className="form-error" role="alert">{state.error}</p> : null}
        </div>
        {/* One action: the dialog closes with its ✕ or Escape. */}
        <div className="dialog-actions" style={{ marginTop: 22 }}>
          <PendingButton className="btn btn-primary" disabled={pending} busy={pending} busyLabel="กำลังส่ง…">
            ส่งลิงก์
          </PendingButton>
        </div>
      </form>
    </Dialog>
  );
}

export function LoginForm() {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(loginAction, undefined);
  // "unset" lets /login?forgot=1 (the "request a new link" path from /reset-password) open the dialog.
  const [forgot, setForgot] = useState<"unset" | "open" | "closed">("unset");

  return (
    <>
      {/* Checked by the server action ("กรอกอีเมลและรหัสผ่านให้ครบ"), not by the browser's English bubbles. */}
      <form action={action} onSubmit={submitKeepingValues(action)} className="stack" noValidate>
        {/* `?next=` goes back to the Server Action, which re-validates it (never trusted as-is). */}
        <SearchParam name="next" render={(next) => <input type="hidden" name="next" value={next ?? ""} />} />
        <div className="field">
          <label htmlFor="l-email">อีเมล</label>
          <input
            id="l-email"
            name="email"
            className="input"
            type="email"
            placeholder="you@email.com"
            autoComplete="email"
            required
            defaultValue={state?.values?.email}
            aria-invalid={state?.error ? true : undefined}
            aria-describedby={state?.error ? "l-error" : undefined}
          />
        </div>
        <div className="field">
          <label htmlFor="l-pass">รหัสผ่าน</label>
          <input
            id="l-pass"
            name="password"
            className="input"
            type="password"
            placeholder="รหัสผ่านของคุณ"
            autoComplete="current-password"
            required
            aria-invalid={state?.error ? true : undefined}
            aria-describedby={state?.error ? "l-error" : undefined}
          />
          <div className="forgot">
            {/* Without JS this lands on /login?forgot=1 (same dialog once scripts run). */}
            <a
              href="/login?forgot=1"
              onClick={(event) => {
                event.preventDefault();
                setForgot("open");
              }}
            >
              ลืมรหัสผ่าน
            </a>
          </div>
        </div>
        {/* A strip like the status cards' (a light and the state), over the button it answers. */}
        {state?.error ? (
          <p className="form-alert" role="alert" id="l-error">
            <span className="form-alert__dot" aria-hidden="true" />
            <span>{state.error}</span>
          </p>
        ) : null}
        <PendingButton className="btn btn-primary btn-block btn-lg" disabled={pending} busy={pending} busyLabel="กำลังเข้าสู่ระบบ…">
          เข้าสู่ระบบ
        </PendingButton>
      </form>

      <SearchParam
        name="forgot"
        render={(value) => (
          <ForgotPasswordDialog open={forgot === "open" || (forgot === "unset" && value === "1")} onClose={() => setForgot("closed")} />
        )}
      />
    </>
  );
}
