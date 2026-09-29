/**
 * Sign in with Google + account deletion: the pure half (no Next.js imports,
 * unit-tested). The Route Handlers in app/api/auth/google/start and
 * app/auth/google/callback and the Server Actions in app/actions/account.ts
 * do the I/O; the decisions live here.
 *
 * Flow (backend contract: POST /auth/google/start and /auth/google/callback):
 *   1. The button POSTs a plain form to /api/auth/google/start (works without
 *      JavaScript). That handler asks the backend for an authorization URL,
 *      keeps the returned `state` in an HttpOnly cookie and 303s the TOP
 *      window to Google. The browser never sees the PKCE verifier (the backend
 *      holds it) and never sees a token.
 *   2. Google sends the browser back to /auth/google/callback?code=&state=.
 *      The handler compares `state` with the cookie (login-CSRF binding),
 *      deletes the cookie, calls the backend, and turns the answer into the
 *      same session cookies a password login writes.
 *
 * Why `SameSite=Lax` on the state cookie: the return from accounts.google.com
 * is a cross-site top-level GET navigation. Lax cookies ride along on that;
 * Strict ones are dropped, and every callback would fail as "invalid state".
 */

export type GoogleIntent = "signin" | "link" | "reauth";

/** Where a sign-in flow started, so errors can go back to the right page. */
export type GoogleFrom = "login" | "signup";

export const GOOGLE_STATE_COOKIE = "noey_g_state";
export const GOOGLE_CONTEXT_COOKIE = "noey_g_ctx";
/** Both flow cookies are scoped to the callback path only. */
export const GOOGLE_COOKIE_PATH = "/auth/google";
/** The backend's state lives 600 s; the cookies never outlive it. */
export const GOOGLE_FLOW_MAX_AGE = 600;

/**
 * The short-lived (300 s) proof from a Google re-authentication, kept
 * server-side in an HttpOnly cookie between the callback and the final
 * "delete my account" click. Scoped to /account so it only rides along with
 * the profile page's Server Action.
 */
export const REAUTH_COOKIE = "noey_reauth";
export const REAUTH_COOKIE_PATH = "/account";
export const REAUTH_MAX_AGE_CAP = 300;

export const CALLBACK_PATH = "/auth/google/callback";

/** The exact redirect_uri registered with Google and in GOOGLE_REDIRECT_URIS. */
export function callbackRedirectUri(siteUrl: string): string {
  return `${new URL(siteUrl).origin}${CALLBACK_PATH}`;
}

export function isGoogleIntent(value: unknown): value is GoogleIntent {
  return value === "signin" || value === "link" || value === "reauth";
}

export interface GoogleContext {
  intent: GoogleIntent;
  /** Sanitised same-site path to land on after a successful sign-in. */
  next: string;
  from: GoogleFrom;
}

/** Cookie value for the flow context. Only non-secret routing data. */
export function encodeGoogleContext(context: GoogleContext): string {
  return JSON.stringify({ i: context.intent, n: context.next, f: context.from });
}

/**
 * Parse the context cookie. Anything malformed falls back to a plain
 * sign-in; `next` is re-sanitised by the caller before it is used.
 */
export function decodeGoogleContext(raw: string | undefined | null): GoogleContext | null {
  if (!raw || raw.length > 1024) return null;
  try {
    const value = JSON.parse(raw) as { i?: unknown; n?: unknown; f?: unknown };
    if (!isGoogleIntent(value.i)) return null;
    return {
      intent: value.i,
      next: typeof value.n === "string" ? value.n : "/account",
      from: value.f === "signup" ? "signup" : "login",
    };
  } catch {
    return null;
  }
}

/** Exact, length-independent comparison of the returned and the kept `state`. */
export function statesMatch(returned: string | null | undefined, kept: string | null | undefined): boolean {
  if (!returned || !kept) return false;
  const a = new TextEncoder().encode(returned);
  const b = new TextEncoder().encode(kept);
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}

/**
 * Defence in depth: the backend builds the authorization URL, but this site
 * only ever sends a browser to Google's own OAuth host over HTTPS — never to
 * wherever a misconfigured or compromised API might point.
 * (Endpoint per https://accounts.google.com/.well-known/openid-configuration.)
 */
export function isGoogleAuthorizationUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "accounts.google.com" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

/** `detail = {code, message, ...}` from the backend's new routes. */
export interface ApiErrorInfo {
  code: string | null;
  balanceSatang: number | null;
}

export function apiErrorInfo(data: unknown): ApiErrorInfo {
  const detail = data && typeof data === "object" ? (data as { detail?: unknown }).detail : null;
  if (!detail || typeof detail !== "object") return { code: null, balanceSatang: null };
  const { code, balance_satang: balance } = detail as { code?: unknown; balance_satang?: unknown };
  return {
    code: typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : null,
    balanceSatang: typeof balance === "number" && Number.isFinite(balance) && balance > 0 ? Math.round(balance) : null,
  };
}

/**
 * Thai text for every outcome code the Google flow can end in. Codes travel
 * in the URL (`?google=<code>`), messages never do — a crafted link can only
 * pick one of these fixed strings. The backend's own `message` is not shown
 * for `not_configured` because it names server variables.
 */
const GOOGLE_MESSAGES: Record<string, string> = {
  cancelled: "ยกเลิกการเข้าสู่ระบบด้วย Google แล้ว",
  invalid_state: "การเข้าสู่ระบบด้วย Google หมดเวลาหรือถูกใช้ไปแล้ว — กรุณาเริ่มใหม่อีกครั้ง",
  redirect_uri_mismatch: "การเข้าสู่ระบบด้วย Google หมดเวลาหรือถูกใช้ไปแล้ว — กรุณาเริ่มใหม่อีกครั้ง",
  code_rejected: "การเข้าสู่ระบบด้วย Google หมดเวลาหรือถูกใช้ไปแล้ว — กรุณาเริ่มใหม่อีกครั้ง",
  invalid_id_token: "ยืนยันตัวตนกับ Google ไม่สำเร็จ — กรุณาลองใหม่อีกครั้ง",
  link_requires_password:
    "มีบัญชีที่ใช้อีเมลนี้อยู่แล้ว — กรุณาเข้าสู่ระบบด้วยอีเมลและรหัสผ่าน แล้วเชื่อมต่อบัญชี Google จากหน้าตั้งค่าบัญชี",
  email_not_verified: "อีเมลของบัญชี Google นี้ยังไม่ได้รับการยืนยัน จึงใช้เข้าสู่ระบบไม่ได้",
  registration_closed: "ยังไม่เปิดรับสมัครสมาชิกใหม่ในขณะนี้",
  captcha_required: "กรุณายืนยันว่าไม่ใช่บอทก่อนสมัครด้วย Google",
  captcha_failed: "ยืนยันว่าไม่ใช่บอทไม่สำเร็จ ลองติ๊กยืนยันอีกครั้งแล้วกดปุ่ม Google ใหม่",
  account_disabled: "บัญชีนี้ยังเข้าใช้งานไม่ได้ ติดต่อทีมงานได้ที่หน้าเกี่ยวกับเรา",
  no_tenant: "บัญชีนี้ยังเข้าใช้งานไม่ได้ ติดต่อทีมงานได้ที่หน้าเกี่ยวกับเรา",
  wrong_account: "บัญชีที่เข้าสู่ระบบอยู่ไม่ตรงกับบัญชีที่เริ่มขั้นตอนนี้ — กรุณาเริ่มใหม่อีกครั้ง",
  not_linked_google: "บัญชี Google ที่เลือกไม่ใช่บัญชีที่เชื่อมต่อไว้กับบัญชีนี้ — กรุณาเลือกบัญชี Google ที่เชื่อมไว้",
  no_google_link: "บัญชีนี้ยังไม่ได้เชื่อมต่อกับ Google",
  google_in_use: "บัญชี Google นี้เชื่อมต่อกับบัญชีอื่นอยู่แล้ว",
  already_linked: "บัญชีนี้เชื่อมต่อกับบัญชี Google อื่นอยู่แล้ว — กรุณายกเลิกการเชื่อมต่อเดิมก่อน",
  try_again: "ระบบไม่ว่างชั่วคราว — กรุณาลองใหม่อีกครั้ง",
  provider_unavailable: "ติดต่อ Google ไม่ได้ในขณะนี้ — กรุณาลองใหม่อีกครั้งในอีกสักครู่",
  not_configured: "การเข้าสู่ระบบด้วย Google ยังไม่เปิดใช้งานในขณะนี้ ใช้อีเมลและรหัสผ่านแทนได้",
  store_unavailable: "ระบบขัดข้องชั่วคราว ลองใหม่อีกครั้งในอีกสักครู่",
  rate_limited: "ส่งถี่เกินไป ลองใหม่อีกครั้งภายหลัง",
  consent_required: "ติ๊กยอมรับเงื่อนไขการใช้งานและนโยบายความเป็นส่วนตัวก่อนสมัครด้วย Google",
  signed_out: "กรุณาเข้าสู่ระบบก่อน แล้วลองอีกครั้ง",
  linked: "เชื่อมต่อบัญชี Google แล้ว ใช้ปุ่ม “เข้าสู่ระบบด้วย Google” ได้ตั้งแต่ครั้งหน้า",
  unlinked: "ยกเลิกการเชื่อมต่อบัญชี Google แล้ว",
  error: "ระบบขัดข้องชั่วคราว ลองใหม่อีกครั้งในอีกสักครู่",
};

/** Outcomes that are good news (shown as a status, not an alert). */
const GOOGLE_SUCCESS_CODES = new Set(["linked", "unlinked"]);

export function googleMessage(code: string | null | undefined): { text: string; ok: boolean } | null {
  if (!code || !Object.hasOwn(GOOGLE_MESSAGES, code)) return null;
  return { text: GOOGLE_MESSAGES[code], ok: GOOGLE_SUCCESS_CODES.has(code) };
}

/** Map an API failure to one of the codes above (unknown ones become "error"). */
export function googleOutcomeCode(status: number, code: string | null): string {
  if (status === 429) return "rate_limited";
  if (code && Object.hasOwn(GOOGLE_MESSAGES, code) && !GOOGLE_SUCCESS_CODES.has(code)) return code;
  if (status === 503) return "store_unavailable";
  return "error";
}

/**
 * Where a failed or cancelled flow goes back to. Sign-in flows return to the
 * page they started on (keeping `next`, or the plan picked on /signup);
 * link and re-auth return to the profile page.
 */
export function googleReturnPath(context: Pick<GoogleContext, "intent" | "from" | "next"> | null, code: string): string {
  const query = new URLSearchParams({ google: code });
  if (!context || context.intent === "signin") {
    const from = context?.from ?? "login";
    const next = context?.next;
    if (from === "signup") {
      const plan = next ? new URL(next, "https://placeholder.invalid").searchParams.get("plan") : null;
      if (plan && /^[a-z]{1,20}$/.test(plan)) query.set("plan", plan);
      return `/signup?${query}`;
    }
    if (next && next !== "/account") query.set("next", next);
    return `/login?${query}`;
  }
  if (context.intent === "reauth") {
    query.set("delete", "retry");
    return `/account/profile?${query}#delete-account`;
  }
  return `/account/profile?${query}#google`;
}

/** Thai text for POST /auth/delete-account failures. Never the backend's own text: some name server variables. */
export function deleteAccountMessage(status: number, code: string | null): string {
  switch (code) {
    case "wrong_password":
      return "รหัสผ่านไม่ถูกต้อง";
    case "reauth_required":
      return "กรุณายืนยันตัวตนก่อนลบบัญชี";
    case "reauth_invalid":
      return "การยืนยันตัวตนกับ Google หมดอายุ — กรุณายืนยันใหม่อีกครั้ง";
    case "admin_account":
      return "บัญชีผู้ดูแลระบบลบเองไม่ได้ — ให้ผู้ดูแลระบบคนอื่นถอดสิทธิ์ผู้ดูแลก่อน";
    case "wallet_balance":
      return "ยังมียอดเงินคงเหลือในกระเป๋า ซึ่งจะหายไปเมื่อลบบัญชี — กรุณายืนยันอีกครั้งหากต้องการลบ";
    case "billing_cancel_failed":
      return "ยกเลิกแพลนที่ชำระเงินอยู่ไม่สำเร็จ บัญชียังไม่ถูกลบและยังไม่มีข้อมูลใดหายไป — กรุณาลองใหม่อีกครั้งในอีกสักครู่";
    case "billing_unavailable":
      return "ตอนนี้ยกเลิกแพลนที่ชำระเงินอยู่ให้อัตโนมัติไม่ได้ บัญชียังไม่ถูกลบ — กรุณาติดต่อทีมงานที่หน้าเกี่ยวกับเรา";
    case "deletion_incomplete":
      return "ลบข้อมูลได้ไม่ครบในครั้งนี้ บัญชียังไม่ถูกลบ — กรุณาลองใหม่อีกครั้ง";
  }
  if (status === 429) return "ส่งถี่เกินไป ลองใหม่อีกครั้งภายหลัง";
  return "ระบบขัดข้องชั่วคราว บัญชียังไม่ถูกลบ ลองใหม่อีกครั้งในอีกสักครู่";
}

/** "1,234.50" for a satang amount (the wallet-forfeit confirmation). */
export function formatBahtFromSatang(satang: number): string {
  return (satang / 100).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
