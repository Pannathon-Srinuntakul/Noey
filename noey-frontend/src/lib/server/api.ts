import "server-only";
import { headers } from "next/headers";
import { API_URL } from "./config";

/**
 * The only place this site talks to the FastAPI backend. Browsers never call
 * the backend directly (BFF): tokens stay in HttpOnly cookies on this origin
 * and are attached here, server-side.
 *
 * Network failures and timeouts come back as `status: 0` rather than throwing,
 * so callers can tell "backend down" (keep the session) from "401" (end it).
 *
 * Only call this while handling a request (Server Actions, Route Handlers,
 * dynamic pages): it forwards the visitor's X-Forwarded-For so the backend's
 * per-IP rate limits see the visitor instead of this server. Build-time /
 * ISR fetches of public data (the price list) use `fetch` directly.
 */
export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; detail: string | null; data: unknown };

export interface ApiRequestInit {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  token?: string;
  timeoutMs?: number;
}

/**
 * The visitor's address chain as received. Forwarded unchanged: behind the
 * hosting proxy it ends with the address that proxy saw, which is the entry
 * the backend should trust (the left-hand entries are client-supplied).
 */
export async function visitorForwardedFor(): Promise<string | undefined> {
  const incoming = await headers();
  const chain = incoming.get("x-forwarded-for") ?? incoming.get("x-real-ip");
  return chain?.trim() || undefined;
}

export async function apiRequest<T = unknown>(path: string, init: ApiRequestInit = {}): Promise<ApiResult<T>> {
  const requestHeaders: Record<string, string> = { Accept: "application/json" };
  if (init.body !== undefined) requestHeaders["Content-Type"] = "application/json";
  if (init.token) requestHeaders.Authorization = `Bearer ${init.token}`;
  const forwardedFor = await visitorForwardedFor();
  if (forwardedFor) requestHeaders["X-Forwarded-For"] = forwardedFor;

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: init.method ?? "GET",
      headers: requestHeaders,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
      signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
    });
  } catch {
    return { ok: false, status: 0, detail: null, data: null };
  }

  let data: unknown = null;
  const text = await response.text().catch(() => "");
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (response.ok) return { ok: true, status: response.status, data: data as T };
  const detail =
    data && typeof data === "object" && typeof (data as { detail?: unknown }).detail === "string"
      ? (data as { detail: string }).detail
      : null;
  return { ok: false, status: response.status, detail, data };
}

/** `GET /auth/me` — `display_name` and `email_verified` are newer, optional fields. */
export interface MeOut {
  user_id: number;
  email: string;
  tenant_id: number;
  tenant_slug: string;
  role: string;
  is_admin: boolean;
  display_name?: string | null;
  email_verified?: boolean;
}

/** `GET /usage/me` — only the fields this site renders. */
export interface UsageMe {
  plan: string;
  period_start: string;
  usage_pct: number | null;
  unlimited: boolean;
  reset_at: string | null;
  by_task?: Array<{ task: string; total_tokens: number; pct: number }>;
}
