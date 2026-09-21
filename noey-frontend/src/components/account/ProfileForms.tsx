"use client";

import { useActionState, useEffect, useRef } from "react";
import { changeEmailAction, changePasswordAction, updateProfileAction } from "@/app/actions/account";
import { notifyAuthChanged } from "@/lib/client/auth-hint";
import type { ActionState } from "@/lib/messages";

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

/** Display name -> PATCH /auth/me. */
export function ProfileForm({ name }: { name: string }) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(updateProfileAction, undefined);
  const errors = state?.fieldErrors ?? {};

  // The header greeting reads a cookie the action just rewrote.
  useEffect(() => {
    if (state?.ok) notifyAuthChanged();
  }, [state]);

  return (
    <form action={action} className="stack" style={{ marginTop: 14 }}>
      <div className="field">
        <label htmlFor="a-name">ชื่อ</label>
        <input
          id="a-name"
          name="name"
          className="input"
          type="text"
          autoComplete="name"
          maxLength={60}
          required
          defaultValue={state?.values?.name ?? name}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={errors.name ? "a-name-error" : undefined}
        />
        {errors.name ? <p className="field-error" id="a-name-error">{errors.name}</p> : null}
      </div>
      <button type="submit" className="btn btn-primary" style={{ fontSize: 14, alignSelf: "flex-start" }} disabled={pending}>
        {pending ? "กำลังบันทึก…" : "บันทึกการแก้ไข"}
      </button>
      <Feedback state={state} />
    </form>
  );
}

/**
 * Email -> POST /auth/change-email {new_email, current_password}. The address
 * changes only after the link sent to the new address is opened.
 */
export function EmailForm({ email }: { email: string }) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(changeEmailAction, undefined);
  const errors = state?.fieldErrors ?? {};
  return (
    <form action={action} className="stack" style={{ marginTop: 16 }}>
      <input type="hidden" name="current_email" value={email} />
      <div className="field">
        <label htmlFor="a-email">อีเมล</label>
        <input
          id="a-email"
          name="new_email"
          className="input"
          type="email"
          autoComplete="email"
          required
          defaultValue={state?.values?.new_email ?? email}
          aria-invalid={errors.new_email ? true : undefined}
          aria-describedby={errors.new_email ? "a-email-error" : "a-email-hint"}
        />
        {errors.new_email ? (
          <p className="field-error" id="a-email-error">{errors.new_email}</p>
        ) : (
          <p className="field-hint" id="a-email-hint">เปลี่ยนอีเมลแล้ว เราจะส่งลิงก์ยืนยันไปที่อีเมลใหม่ก่อนใช้งานจริง</p>
        )}
      </div>
      <div className="field">
        <label htmlFor="a-email-pass">รหัสผ่านปัจจุบัน</label>
        <input
          id="a-email-pass"
          name="current_password"
          className="input"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={errors.current_password ? true : undefined}
          aria-describedby={errors.current_password ? "a-email-pass-error" : undefined}
        />
        {errors.current_password ? <p className="field-error" id="a-email-pass-error">{errors.current_password}</p> : null}
      </div>
      <button type="submit" className="btn btn-secondary" style={{ fontSize: 14, alignSelf: "flex-start" }} disabled={pending}>
        {pending ? "กำลังส่ง…" : "เปลี่ยนอีเมล"}
      </button>
      <Feedback state={state} />
    </form>
  );
}

export function PasswordForm() {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(changePasswordAction, undefined);
  const formRef = useRef<HTMLFormElement>(null);
  const errors = state?.fieldErrors ?? {};

  return (
    <form ref={formRef} action={action} className="stack" style={{ marginTop: 14 }}>
      {/* Lets password managers attach the change to the right account. */}
      <input type="text" name="username" autoComplete="username" hidden readOnly />
      <div className="field">
        <label htmlFor="a-old">รหัสผ่านเดิม</label>
        <input
          id="a-old"
          name="current_password"
          className="input"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={errors.current_password ? true : undefined}
          aria-describedby={errors.current_password ? "a-old-error" : undefined}
        />
        {errors.current_password ? <p className="field-error" id="a-old-error">{errors.current_password}</p> : null}
      </div>
      <div className="field">
        <label htmlFor="a-new">รหัสผ่านใหม่</label>
        <input
          id="a-new"
          name="new_password"
          className="input"
          type="password"
          placeholder="อย่างน้อย 8 ตัวอักษร"
          autoComplete="new-password"
          minLength={8}
          required
          aria-invalid={errors.new_password ? true : undefined}
          aria-describedby={errors.new_password ? "a-new-error" : undefined}
        />
        {errors.new_password ? <p className="field-error" id="a-new-error">{errors.new_password}</p> : null}
      </div>
      <button type="submit" className="btn btn-primary" style={{ fontSize: 14, alignSelf: "flex-start" }} disabled={pending}>
        {pending ? "กำลังเปลี่ยน…" : "เปลี่ยนรหัสผ่าน"}
      </button>
      <Feedback state={state} />
    </form>
  );
}
