"use client";

import Link from "next/link";
import { googleMessage, type GoogleFrom } from "@/lib/google-auth";
import { isPaidTier } from "@/lib/plans";
import { SearchParam } from "../forms/SearchParam";
import { TURNSTILE_SITE_KEY, TurnstileWidget } from "../forms/TurnstileWidget";
import { GoogleButton } from "./GoogleButton";
import "../../styles/parts/google.css";

const CAPTCHA_CODES = new Set(["captcha_required", "captcha_failed"]);

/**
 * "เข้าสู่ระบบด้วย Google" / "สมัครด้วย Google" on /login and /signup.
 *
 * A plain form POST to /api/auth/google/start (works before JavaScript
 * loads); that handler 303s the top window to Google. Rendered only when the
 * backend reports Google sign-in as enabled.
 *
 * Turnstile: a returning user needs none. Only a Google sign-UP needs a
 * token while the backend has TURNSTILE_SECRET_KEY set; the backend then
 * answers `captcha_required`, the visitor lands back here with
 * `?google=captcha_required`, and this form shows the widget for the retry.
 */
export function GoogleSignInForm({ from, agreed = true, enabled = true }: { from: GoogleFrom; agreed?: boolean; enabled?: boolean }) {
  const label = from === "signup" ? "สมัครด้วย Google" : "เข้าสู่ระบบด้วย Google";

  // Switched off since this page was built: still explain where the visitor came back from.
  if (!enabled) {
    return (
      <SearchParam
        name="google"
        render={(code) => {
          const message = googleMessage(code);
          return message ? (
            <p className="form-error" role="alert" style={{ marginBottom: 16 }}>
              {message.text}
            </p>
          ) : null;
        }}
      />
    );
  }

  // Only the parts that read the query string sit in SearchParam's client-side
  // subtree; the button and the note are plain server HTML, so they paint with
  // the page instead of being swapped in after hydration.
  return (
    <form method="post" action="/api/auth/google/start" className="google-signin">
      <input type="hidden" name="intent" value="signin" />
      <input type="hidden" name="from" value={from} />
      {from === "signup" ? (
        <>
          <input type="hidden" name="agree" value={agreed ? "yes" : ""} />
          <SearchParam name="plan" render={(plan) => <input type="hidden" name="plan" value={isPaidTier(plan) ? plan : ""} />} />
        </>
      ) : (
        <SearchParam name="next" render={(next) => <input type="hidden" name="next" value={next ?? ""} />} />
      )}
      <SearchParam
        name="google"
        render={(code) => {
          const message = googleMessage(code);
          const needsCaptcha = !!code && CAPTCHA_CODES.has(code);
          return (
            <>
              {message ? (
                <p className={message.ok ? "form-success" : "form-error"} role={message.ok ? "status" : "alert"}>
                  {message.text}
                </p>
              ) : null}
              {needsCaptcha ? <TurnstileWidget siteKey={TURNSTILE_SITE_KEY} /> : null}
            </>
          );
        }}
      />
      <GoogleButton label={label} block disabled={!agreed} aria-describedby={from === "login" ? "google-new-account-note" : undefined} />
      {from === "login" ? (
        <p className="fine google-signin__note" id="google-new-account-note">
          ถ้ายังไม่มีบัญชี ระบบจะสร้างบัญชีใหม่ให้ ซึ่งถือว่าคุณยอมรับ <Link href="/terms">เงื่อนไขการใช้งาน</Link> และ{" "}
          <Link href="/privacy">นโยบายความเป็นส่วนตัว</Link>
        </p>
      ) : null}
    </form>
  );
}

/** "หรือ" rule between the Google button and the email form. */
export function OrDivider({ label = "หรือใช้อีเมล" }: { label?: string }) {
  return (
    <div className="or-divider" role="separator" aria-label={label}>
      <span>{label}</span>
    </div>
  );
}
