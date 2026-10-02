import "server-only";

/**
 * Server-only environment. Nothing here may reach a Client Component: these
 * values are read at request/build time on the server and passed down as
 * plain props where a page needs to show one (e.g. the contact address).
 *
 * All email (contact form, verification, password reset) is sent by the
 * BACKEND; this site holds no mail credentials.
 */

/**
 * Base URL of the FastAPI backend. Called ONLY from the server (BFF).
 *
 * At run time this is Railway's private address (fast, never leaves Railway).
 * A Railway BUILD cannot reach the private network, so `next build` uses
 * API_URL_BUILD (the public API URL) when it is set: without it every deploy
 * prerendered /sitemap.xml, the feeds, /login's Google button and the price
 * table without the backend's data until ISR caught up.
 */
const BUILD_API_URL = process.env.NEXT_PHASE === "phase-production-build" ? process.env.API_URL_BUILD : undefined;
export const API_URL = (BUILD_API_URL || process.env.API_URL || "http://localhost:8000").replace(/\/+$/, "");

/** Public contact address: the note under the contact form and its mailto fallback. */
export const CONTACT_EMAIL = process.env.CONTACT_EMAIL || "hello@noeystudio.com";

export const SITE_VERIFICATION = {
  google: process.env.GOOGLE_SITE_VERIFICATION?.trim() || undefined,
  bing: process.env.BING_SITE_VERIFICATION?.trim() || undefined,
};

/** Cookies get `Secure` in production builds (served over HTTPS). */
export const COOKIE_SECURE = process.env.NODE_ENV === "production";
