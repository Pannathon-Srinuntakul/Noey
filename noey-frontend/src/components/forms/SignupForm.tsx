"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { signupAction } from "@/app/actions/auth";
import type { ActionState } from "@/lib/messages";
import { PLAN_COPY, isPaidTier } from "@/lib/plans";
import { GoogleSignInForm, OrDivider } from "../auth/GoogleSignInForm";
import { submitKeepingValues } from "./keepValues";
import { SearchParam } from "./SearchParam";
import { PendingButton } from "../ui/PendingButton";
import { TURNSTILE_SITE_KEY, TurnstileWidget } from "./TurnstileWidget";
import { keepThai } from "../ds/ThaiText";

export function SignupForm({ googleEnabled = false }: { googleEnabled?: boolean }) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(signupAction, undefined);

  const errors = state?.fieldErrors ?? {};
  // A taken email comes back twice (under the field, and as the form's
  // message with what to do next): said once, in full, under the field.
  const emailTaken = !!errors.email && !!state?.error?.startsWith(errors.email);
  const emailError = emailTaken ? state?.error : errors.email;
  const formError = emailTaken ? undefined : state?.error;
  // The design gates sign-up on an explicit tick of the terms and privacy
  // notice; the server action checks the same field.
  const [agreed, setAgreed] = useState(false);

  return (
    <>
      {/* `?plan=` from a paid-plan button, read on the client so /signup stays static. */}
      <SearchParam
        name="plan"
        render={(plan) => (
          <span className="tag tag-accent" style={{ gap: 4 }}>
            {isPaidTier(plan) ? `แพลนที่เลือก: ${PLAN_COPY[plan].name}` : "เริ่มที่แพลนฟรี"}
          </span>
        )}
      />
      <h1>สมัครใช้งาน</h1>
      <p className="auth-page__switch">
        มีบัญชีอยู่แล้ว <Link href="/login">เข้าสู่ระบบ</Link>
      </p>
      {/* Outside both forms (bound to the email form by `form=`) because the
          Google button honours the same tick: no account is created without it. */}
      <label className="agree">
        <input
          type="checkbox"
          name="agree"
          value="yes"
          className="agree__box"
          checked={agreed}
          onChange={(event) => setAgreed(event.target.checked)}
          required
          form="signup-form"
          aria-describedby={errors.agree ? "s-agree-error" : undefined}
        />
        {/* The documents are read in passing, not navigated to: no prefetch of
            them while the form loads (it competes with the form on a phone). */}
        <span className="agree__text">
          ฉันได้อ่านและยอมรับ{" "}
          <Link href="/terms" prefetch={false}>
            เงื่อนไขการใช้งาน
          </Link>{" "}
          และ{" "}
          <Link href="/privacy" prefetch={false}>
            นโยบายความเป็นส่วนตัว
          </Link>{" "}
          {keepThai("รวมถึงการเก็บและประมวลผลไฟล์ที่ฉันนำเข้ามาเพื่อให้บริการ")}
        </span>
      </label>
      {errors.agree ? (
        <p className="field-error" id="s-agree-error" style={{ marginTop: -8 }}>
          {errors.agree}
        </p>
      ) : null}
      <GoogleSignInForm from="signup" agreed={agreed} enabled={googleEnabled} />
      {googleEnabled ? <OrDivider label="หรือสมัครด้วยอีเมล" /> : null}
      {/* Checked by the server action, whose messages are Thai and shown under each field. */}
      <form id="signup-form" action={action} onSubmit={submitKeepingValues(action)} className="stack" noValidate>
        <SearchParam name="plan" render={(plan) => <input type="hidden" name="plan" value={isPaidTier(plan) ? plan : ""} />} />
        <div className="field">
          <label htmlFor="s-name">ชื่อ</label>
          <input
            id="s-name"
            name="name"
            className="input"
            type="text"
            placeholder="ชื่อที่ให้เราเรียก"
            autoComplete="name"
            maxLength={60}
            defaultValue={state?.values?.name}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? "s-name-error" : undefined}
          />
          {errors.name ? (
            <p className="field-error" id="s-name-error">
              {errors.name}
            </p>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor="s-email">อีเมล</label>
          <input
            id="s-email"
            name="email"
            className="input"
            type="email"
            placeholder="you@email.com"
            autoComplete="email"
            required
            defaultValue={state?.values?.email}
            aria-invalid={emailError ? true : undefined}
            aria-describedby={emailError ? "s-email-error" : undefined}
          />
          {emailError ? (
            <p className="field-error" id="s-email-error">
              {emailTaken && emailError.includes("เข้าสู่ระบบ") ? (
                <>
                  {emailError.slice(0, emailError.indexOf("เข้าสู่ระบบ"))}
                  <Link href="/login">เข้าสู่ระบบ</Link>
                  {emailError.slice(emailError.indexOf("เข้าสู่ระบบ") + "เข้าสู่ระบบ".length)}
                </>
              ) : (
                emailError
              )}
            </p>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor="s-pass">ตั้งรหัสผ่าน</label>
          <input
            id="s-pass"
            name="password"
            className="input"
            type="password"
            placeholder="รหัสผ่านที่จะใช้เข้าสู่ระบบ"
            autoComplete="new-password"
            minLength={8}
            required
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={errors.password ? "s-pass-error" : "s-pass-hint"}
          />
          {/* The rule, or — when it was broken — the error that says it. */}
          {errors.password ? (
            <p className="field-error" id="s-pass-error">
              {errors.password}
            </p>
          ) : (
            <p className="field-hint" id="s-pass-hint">
              อย่างน้อย 8 ตัวอักษร
            </p>
          )}
        </div>
        {/* Turnstile loads only when a site key is configured; eager here so the slot is reserved from the start. */}
        <TurnstileWidget siteKey={TURNSTILE_SITE_KEY} resetKey={state} />
        {formError ? (
          <p className="form-error" role="alert">
            {formError}
          </p>
        ) : null}
        <PendingButton
          className="btn btn-primary btn-block btn-lg"
          disabled={pending || !agreed}
          busy={pending}
          busyLabel="กำลังสมัคร…"
        >
          สมัครและเริ่มใช้งาน
        </PendingButton>
        {agreed ? <p className="legal-line">ยังไม่ต้องกรอกบัตรในขั้นนี้ เริ่มที่แพลนฟรีได้เลย</p> : null}
      </form>
    </>
  );
}
