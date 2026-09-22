"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { signupAction } from "@/app/actions/auth";
import type { ActionState } from "@/lib/messages";
import { PLAN_COPY, isPaidTier } from "@/lib/plans";
import { SearchParam } from "./SearchParam";
import { TURNSTILE_SITE_KEY, TurnstileWidget } from "./TurnstileWidget";

export function SignupForm() {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(signupAction, undefined);

  const errors = state?.fieldErrors ?? {};
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
      <form action={action} className="stack">
        <SearchParam name="plan" render={(plan) => <input type="hidden" name="plan" value={isPaidTier(plan) ? plan : ""} />} />
        <label className="agree">
          <input
            type="checkbox"
            name="agree"
            value="yes"
            className="agree__box"
            checked={agreed}
            onChange={(event) => setAgreed(event.target.checked)}
            required
            aria-describedby={errors.agree ? "s-agree-error" : undefined}
          />
          <span className="agree__text">
            ฉันได้อ่านและยอมรับ <Link href="/terms">เงื่อนไขการใช้งาน</Link> และ <Link href="/privacy">นโยบายความเป็นส่วนตัว</Link>{" "}
            รวมถึงการเก็บและประมวลผลไฟล์ที่ฉันนำเข้ามาเพื่อให้บริการ
          </span>
        </label>
        {errors.agree ? (
          <p className="field-error" id="s-agree-error" style={{ marginTop: -8 }}>
            {errors.agree}
          </p>
        ) : null}
        <div className="field">
          <label htmlFor="s-name">ชื่อ</label>
          <input
            id="s-name"
            name="name"
            className="input"
            type="text"
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
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={errors.email ? "s-email-error" : undefined}
          />
          {errors.email ? (
            <p className="field-error" id="s-email-error">
              {errors.email}
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
            placeholder="อย่างน้อย 8 ตัวอักษร"
            autoComplete="new-password"
            minLength={8}
            required
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={errors.password ? "s-pass-error" : undefined}
          />
          {errors.password ? (
            <p className="field-error" id="s-pass-error">
              {errors.password}
            </p>
          ) : null}
        </div>
        {/* Turnstile loads only when a site key is configured; eager here so the slot is reserved from the start. */}
        <TurnstileWidget siteKey={TURNSTILE_SITE_KEY} resetKey={state} />
        {state?.error ? (
          <p className="form-error" role="alert">
            {state.error}
          </p>
        ) : null}
        <button
          type="submit"
          className="btn btn-primary btn-block btn-lg"
          disabled={pending || !agreed}
          aria-busy={pending || undefined}
        >
          {pending ? "กำลังสมัคร…" : "สมัครและเริ่มใช้งาน"}
        </button>
        <p className="legal-line">
          {agreed ? "ยังไม่ต้องกรอกบัตรในขั้นนี้ เริ่มที่แพลนฟรีได้เลย" : "ติ๊กยอมรับเงื่อนไขก่อนจึงจะสมัครได้"}
        </p>
      </form>
    </>
  );
}
