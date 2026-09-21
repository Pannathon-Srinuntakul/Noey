import { NextResponse, type NextRequest } from "next/server";
import { fieldErrorsFromValidation, toBackendContact, validateContact } from "@/lib/contact";
import { isSameOriginRequest } from "@/lib/origin";
import { apiRequest } from "@/lib/server/api";
import { redirectTo } from "@/lib/server/redirect";
import { SITE_URL } from "@/lib/site";

const MAX_BODY_BYTES = 16 * 1024;

type Outcome = "sent" | "invalid" | "rate-limited" | "unavailable" | "captcha" | "error";

const STATUS: Record<Outcome, number> = {
  sent: 202,
  invalid: 422,
  "rate-limited": 429,
  unavailable: 503,
  captcha: 400,
  error: 502,
};

/**
 * Contact form -> backend `POST /contact` (the backend sends the email and
 * applies per-IP rate limits; the visitor's X-Forwarded-For is forwarded).
 * JSON in -> JSON out for the enhanced form; a plain HTML form POST gets a
 * 303 back to /about with the outcome in `?contact=`. Success is reported only
 * when the backend accepted the message (202) — never faked.
 */
export async function POST(request: NextRequest) {
  const isJson = (request.headers.get("content-type") ?? "").includes("application/json");
  const respond = (outcome: Outcome, extra: Record<string, unknown> = {}) => {
    if (isJson) {
      return NextResponse.json({ ok: outcome === "sent", outcome, ...extra }, { status: STATUS[outcome], headers: { "Cache-Control": "no-store" } });
    }
    return redirectTo(`/about?contact=${outcome}#contact`, 303);
  };

  if (!isSameOriginRequest(request, SITE_URL)) {
    return isJson ? NextResponse.json({ ok: false, outcome: "forbidden" }, { status: 403 }) : respond("error");
  }

  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return respond("invalid");

  let raw: Record<string, unknown>;
  try {
    if (isJson) {
      const text = await request.text();
      if (text.length > MAX_BODY_BYTES) return respond("invalid");
      const parsed: unknown = JSON.parse(text);
      raw = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } else {
      raw = Object.fromEntries(await request.formData());
    }
  } catch {
    return respond("invalid");
  }

  const validation = validateContact(raw);
  if (!validation.ok) return respond("invalid", { errors: validation.errors });

  const result = await apiRequest("/contact", { method: "POST", body: toBackendContact(validation.value, raw) });
  if (result.ok) return respond("sent");
  switch (result.status) {
    case 422: {
      const { fields } = fieldErrorsFromValidation(result.data);
      return respond("invalid", { errors: fields });
    }
    case 429:
      return respond("rate-limited");
    case 503:
      return respond("unavailable");
    case 400:
      return respond("captcha");
    default:
      return respond("error");
  }
}
