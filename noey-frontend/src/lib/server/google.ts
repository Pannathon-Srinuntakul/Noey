import "server-only";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { API_URL } from "./config";

/** Seconds between checks of whether Google sign-in is switched on. */
export const GOOGLE_CONFIG_REVALIDATE_SECONDS = 300;

/**
 * GET /auth/google/config — whether to show "เข้าสู่ระบบด้วย Google".
 * Public and cacheable, so /login and /signup stay static (ISR) rather than
 * rendering per request.
 *
 * While GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URIS are
 * unset on the backend this answers `enabled: false` and no button is drawn.
 * A stale "enabled" page is harmless: /api/auth/google/start re-asks the
 * backend and sends the visitor back with a calm "not enabled" notice.
 *
 * On failure: false during `next build` and in dev (a build never depends on
 * the backend); at production runtime throw, so the last good page stays up.
 */
export async function googleSignInEnabled(): Promise<boolean> {
  try {
    const response = await fetch(`${API_URL}/auth/google/config`, {
      headers: { Accept: "application/json" },
      next: { revalidate: GOOGLE_CONFIG_REVALIDATE_SECONDS, tags: ["google-config"] },
      signal: AbortSignal.timeout(5_000),
    });
    // An older backend without the route: simply no button.
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`GET /auth/google/config answered ${response.status}`);
    const body: unknown = await response.json();
    return !!body && typeof body === "object" && (body as { enabled?: unknown }).enabled === true;
  } catch (error) {
    if (process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD || process.env.NODE_ENV !== "production") {
      console.warn(`[google] sign-in button hidden: ${(error as Error).message}`);
      return false;
    }
    throw error;
  }
}
