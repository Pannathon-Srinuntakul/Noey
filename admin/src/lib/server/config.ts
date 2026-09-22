import "server-only";

/**
 * Server-only environment. Nothing here reaches a Client Component.
 * The backend is called ONLY from this server (BFF); browsers never see its URL.
 */
export const API_URL = (process.env.API_URL || "http://localhost:8000").replace(/\/+$/, "");

/** This app's public origin (used by the same-origin check alongside Host). */
export const ADMIN_URL = process.env.ADMIN_URL?.trim() || undefined;

/** Cookies are Secure + `__Host-` in production builds (served over HTTPS). */
export const COOKIE_SECURE = process.env.NODE_ENV === "production";

/** The marketing site (noey-frontend) and the shared secret of its
 * POST /api/revalidate-prices. Both unset = prices refresh there on their own
 * within 10 minutes. */
export const SITE_URL = process.env.SITE_URL?.trim().replace(/\/+$/, "") || undefined;
export const PRICES_REVALIDATE_SECRET = process.env.PRICES_REVALIDATE_SECRET?.trim() || undefined;

/** Idle logout in the browser; the backend enforces the same limit itself. */
export const IDLE_LOGOUT_MS = 30 * 60 * 1000;
