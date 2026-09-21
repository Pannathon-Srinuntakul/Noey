/**
 * Contact form: local validation (fast Thai feedback before a round trip) and
 * the mapping to/from the backend's `POST /contact`, which sends the email.
 * Pure — the route handler adds the Origin check and the network call.
 */

export const CONTACT_LIMITS = {
  nameMax: 100,
  emailMax: 254,
  messageMin: 10,
  messageMax: 4000,
} as const;

/**
 * Hidden honeypot input. People never see or fill it; bots fill every field.
 * Forwarded to the backend as `company`, which decides what to do with it.
 */
export const HONEYPOT_FIELD = "company";

/** Field Turnstile adds to the form it renders in. */
export const TURNSTILE_FIELD = "cf-turnstile-response";

export interface ContactInput {
  name: string;
  email: string;
  message: string;
}

export type ContactField = keyof ContactInput;
export type ContactFieldErrors = Partial<Record<ContactField, string>>;

export type ContactValidation =
  | { ok: true; value: ContactInput }
  | { ok: false; errors: ContactFieldErrors };

const EMAIL_PATTERN = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;

const FIELD_MESSAGES: Record<ContactField, string> = {
  name: "กรอกชื่อ",
  email: "กรอกอีเมลให้ถูกต้อง เพื่อให้เราตอบกลับได้",
  message: `เล่าให้เราฟังอีกนิด อย่างน้อย ${CONTACT_LIMITS.messageMin} ตัวอักษร`,
};

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function validateContact(raw: Record<string, unknown>): ContactValidation {
  const name = asText(raw.name).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  const email = asText(raw.email).trim();
  // Keep newlines in the message; drop the other control characters.
  const message = asText(raw.message).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();

  const errors: ContactFieldErrors = {};
  if (!name) errors.name = FIELD_MESSAGES.name;
  else if (name.length > CONTACT_LIMITS.nameMax) errors.name = `ชื่อยาวได้ไม่เกิน ${CONTACT_LIMITS.nameMax} ตัวอักษร`;

  if (!email || email.length > CONTACT_LIMITS.emailMax || !EMAIL_PATTERN.test(email)) errors.email = FIELD_MESSAGES.email;

  if (message.length < CONTACT_LIMITS.messageMin) errors.message = FIELD_MESSAGES.message;
  else if (message.length > CONTACT_LIMITS.messageMax) errors.message = `ข้อความยาวได้ไม่เกิน ${CONTACT_LIMITS.messageMax} ตัวอักษร`;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { name, email, message } };
}

export interface BackendContactPayload {
  name: string;
  email: string;
  message: string;
  company: string;
  turnstile_token?: string;
}

/** Body for `POST {API_URL}/contact`. The honeypot is passed through untouched. */
export function toBackendContact(value: ContactInput, raw: Record<string, unknown>): BackendContactPayload {
  const token = asText(raw[TURNSTILE_FIELD]).trim();
  return {
    ...value,
    company: asText(raw[HONEYPOT_FIELD]).slice(0, 200),
    ...(token ? { turnstile_token: token } : {}),
  };
}

/**
 * FastAPI's 422 body is `{detail: [{loc: ["body", "email"], msg, type}]}`.
 * Map the fields we render to our own Thai messages (the backend's English
 * `msg` is never shown); anything unrecognised becomes a form-level error.
 */
export function fieldErrorsFromValidation(body: unknown): { fields: ContactFieldErrors; unmatched: boolean } {
  const fields: ContactFieldErrors = {};
  let unmatched = false;
  const detail = body && typeof body === "object" ? (body as { detail?: unknown }).detail : undefined;
  if (!Array.isArray(detail)) return { fields, unmatched: true };
  for (const item of detail) {
    const loc = item && typeof item === "object" ? (item as { loc?: unknown }).loc : undefined;
    const field: unknown = Array.isArray(loc) ? loc[loc.length - 1] : undefined;
    if (field === "name" || field === "email" || field === "message") fields[field] = FIELD_MESSAGES[field];
    else unmatched = true;
  }
  return { fields, unmatched };
}
