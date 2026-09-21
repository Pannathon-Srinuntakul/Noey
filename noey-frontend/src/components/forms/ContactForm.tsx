"use client";

import { useState, type FormEvent } from "react";
import { CONTACT_LIMITS, HONEYPOT_FIELD, type ContactFieldErrors } from "@/lib/contact";
import { MSG } from "@/lib/messages";
import { SearchParam } from "./SearchParam";
import { TURNSTILE_SITE_KEY, TurnstileWidget } from "./TurnstileWidget";

type Outcome = "sent" | "invalid" | "rate-limited" | "unavailable" | "captcha" | "error";
type Status = { kind: "idle" } | { kind: "sending" } | { kind: "done"; outcome: Outcome; errors?: ContactFieldErrors };

const FAILED = "ส่งข้อความไม่สำเร็จ ลองอีกครั้ง หรืออีเมลหาเราโดยตรงตามที่อยู่ด้านล่าง";

function isOutcome(value: unknown): value is Outcome {
  return ["sent", "invalid", "rate-limited", "unavailable", "captcha", "error"].includes(String(value));
}

function OutcomeMessage({ outcome, contactEmail }: { outcome: Outcome; contactEmail: string }) {
  switch (outcome) {
    case "sent":
      return (
        <p className="form-success" role="status">
          ส่งข้อความแล้ว ขอบคุณที่ทักมา เราจะตอบกลับทางอีเมลที่ให้ไว้
        </p>
      );
    case "invalid":
      return (
        <p className="form-error" role="alert">
          ตรวจสอบข้อมูลที่กรอกอีกครั้ง
        </p>
      );
    case "rate-limited":
      return (
        <p className="form-error" role="alert">
          {MSG.rateLimited}
        </p>
      );
    case "captcha":
      return (
        <p className="form-error" role="alert">
          {MSG.captchaFailed}
        </p>
      );
    case "unavailable":
      // The backend cannot send email right now: offer the direct address instead.
      return (
        <p className="form-error" role="alert">
          ตอนนี้ส่งข้อความผ่านฟอร์มไม่ได้ อีเมลหาเราโดยตรงที่ <a href={`mailto:${contactEmail}`}>{contactEmail}</a>
        </p>
      );
    default:
      return (
        <p className="form-error" role="alert">
          {FAILED}
        </p>
      );
  }
}

/**
 * Posts to /api/contact (Route Handler -> backend `POST /contact`, which
 * sends the email). Works without JavaScript too: the plain form POST gets a
 * 303 back to /about?contact=<outcome>, read here on load. Success is only
 * shown after the backend accepted the message.
 */
export function ContactForm({ contactEmail }: { contactEmail: string }) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setStatus({ kind: "sending" });
    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      const body = (await response.json().catch(() => ({}))) as { outcome?: unknown; errors?: ContactFieldErrors };
      const outcome: Outcome = isOutcome(body.outcome) ? body.outcome : "error";
      if (outcome === "sent") form.reset();
      setStatus({ kind: "done", outcome, errors: body.errors });
    } catch {
      setStatus({ kind: "done", outcome: "error" });
    }
  }

  const fieldErrors = status.kind === "done" ? (status.errors ?? {}) : {};
  const sending = status.kind === "sending";

  return (
    <form action="/api/contact" method="post" onSubmit={onSubmit} className="stack" noValidate>
      <div className="field">
        <label htmlFor="c-name">ชื่อ</label>
        <input
          id="c-name"
          name="name"
          className="input"
          type="text"
          autoComplete="name"
          required
          maxLength={CONTACT_LIMITS.nameMax}
          aria-invalid={fieldErrors.name ? true : undefined}
          aria-describedby={fieldErrors.name ? "c-name-error" : undefined}
        />
        {fieldErrors.name ? <p className="field-error" id="c-name-error">{fieldErrors.name}</p> : null}
      </div>
      <div className="field">
        <label htmlFor="c-email">อีเมล</label>
        <input
          id="c-email"
          name="email"
          className="input"
          type="email"
          placeholder="you@email.com"
          autoComplete="email"
          required
          maxLength={CONTACT_LIMITS.emailMax}
          aria-invalid={fieldErrors.email ? true : undefined}
          aria-describedby={fieldErrors.email ? "c-email-error" : undefined}
        />
        {fieldErrors.email ? <p className="field-error" id="c-email-error">{fieldErrors.email}</p> : null}
      </div>
      <div className="field">
        <label htmlFor="c-msg">อยากถามอะไร</label>
        <textarea
          id="c-msg"
          name="message"
          className="input"
          placeholder="เล่าคร่าว ๆ ว่าทำคอนเทนต์แนวไหน และติดปัญหาตรงไหน"
          required
          minLength={CONTACT_LIMITS.messageMin}
          maxLength={CONTACT_LIMITS.messageMax}
          aria-invalid={fieldErrors.message ? true : undefined}
          aria-describedby={fieldErrors.message ? "c-msg-error" : undefined}
        />
        {fieldErrors.message ? <p className="field-error" id="c-msg-error">{fieldErrors.message}</p> : null}
      </div>
      {/* Honeypot: invisible to people and to assistive tech; bots fill it. */}
      <div className="honeypot" aria-hidden="true">
        <label htmlFor="c-company">บริษัท</label>
        <input id="c-company" name={HONEYPOT_FIELD} type="text" tabIndex={-1} autoComplete="off" />
      </div>
      <TurnstileWidget siteKey={TURNSTILE_SITE_KEY} resetKey={status.kind === "done" ? status : undefined} lazy />
      <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={sending} aria-busy={sending || undefined}>
        {sending ? "กำลังส่ง…" : "ส่งข้อความ"}
      </button>
      <div aria-live="polite">
        {status.kind === "done" ? <OutcomeMessage outcome={status.outcome} contactEmail={contactEmail} /> : null}
        {/* Outcome of a no-JavaScript submit, echoed back as /about?contact=<outcome>. */}
        {status.kind === "idle" ? (
          <SearchParam
            name="contact"
            render={(value) => (isOutcome(value) ? <OutcomeMessage outcome={value} contactEmail={contactEmail} /> : null)}
          />
        ) : null}
      </div>
      <p className="contact-note">
        หรืออีเมลมาที่ <a href={`mailto:${contactEmail}`}>{contactEmail}</a> เราตอบกลับภายในหนึ่งวันทำการ
      </p>
    </form>
  );
}
