import "server-only";
import { headers } from "next/headers";
import { API_URL } from "./config";

/**
 * The only place this app talks to the backend. Failures come back as values
 * (`status: 0` = backend unreachable), never thrown.
 *
 * Forwards the visitor's X-Forwarded-For and User-Agent so the backend's
 * rate limits, IP allowlist and audit log see the admin, not this server (the
 * backend trusts X-Forwarded-For only as far as TRUSTED_PROXY_HOPS says).
 */
export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; detail: string | null };

export interface ApiInit {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  token?: string;
  timeoutMs?: number;
}

async function visitorHeaders(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const incoming = await headers();
    const chain = incoming.get("x-forwarded-for") ?? incoming.get("x-real-ip");
    if (chain) out["X-Forwarded-For"] = chain.trim();
    const ua = incoming.get("user-agent");
    if (ua) out["User-Agent"] = ua.slice(0, 255);
  } catch {
    // outside a request (tests)
  }
  return out;
}

export async function adminApi<T = unknown>(path: string, init: ApiInit = {}): Promise<ApiResult<T>> {
  const h: Record<string, string> = { Accept: "application/json", ...(await visitorHeaders()) };
  if (init.body !== undefined) h["Content-Type"] = "application/json";
  if (init.token) h.Authorization = `Bearer ${init.token}`;
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: init.method ?? "GET",
      headers: h,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
      signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
    });
  } catch {
    return { ok: false, status: 0, detail: null };
  }
  const text = await response.text().catch(() => "");
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (response.ok) return { ok: true, status: response.status, data: data as T };
  const detail = data && typeof data === "object" && typeof (data as { detail?: unknown }).detail === "string" ? (data as { detail: string }).detail : null;
  return { ok: false, status: response.status, detail };
}
