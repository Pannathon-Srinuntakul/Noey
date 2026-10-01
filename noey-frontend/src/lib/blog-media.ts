/**
 * Where blog images come from (BLOG_CONTRACT.md, "Changes" 2026-10-01).
 *
 * The backend serves every blog image from one public base — by default
 * `<API_PUBLIC_URL>/blog/media`, i.e. https://api.noeystudio.com/blog/media —
 * and the site is told the same base in BLOG_MEDIA_PUBLIC_URL. Pure (no
 * Next.js import), so next.config.ts, the server code and the unit tests
 * share it:
 *
 *  - `next/image` may optimise exactly this origin + path prefix, https only
 *    (`remotePatterns`, read at build time);
 *  - CSP `img-src` already allows every https image; only a NON-https base (a
 *    local test backend) adds its one origin there. Nothing else is loosened.
 */

export const DEFAULT_BLOG_MEDIA_PUBLIC_URL = "https://api.noeystudio.com/blog/media";

/** The configured base, normalised (no trailing slash, no query); null when it is not a usable http(s) URL. */
export function blogMediaBase(raw: string | undefined = process.env.BLOG_MEDIA_PUBLIC_URL): string | null {
  const value = (raw ?? "").trim() || DEFAULT_BLOG_MEDIA_PUBLIC_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export interface BlogImagePattern {
  protocol: "https";
  hostname: string;
  port: string;
  pathname: string;
  search: "";
}

/** The one `images.remotePatterns` entry: the base's host and path, https only, no query string. */
export function blogMediaRemotePattern(base: string | null): BlogImagePattern | null {
  if (!base) return null;
  const url = new URL(base);
  if (url.protocol !== "https:") return null;
  return { protocol: "https", hostname: url.hostname, port: url.port, pathname: `${url.pathname.replace(/\/+$/, "")}/**`, search: "" };
}

/** The extra CSP `img-src` origin: only for a base that `https:` does not already cover. */
export function blogMediaCspOrigin(base: string | null): string | null {
  if (!base) return null;
  const url = new URL(base);
  return url.protocol === "https:" ? null : url.origin;
}

// ─── In-article visuals (BLOG_CONTRACT.md, "Changes" 2026-10-02) ────────────
//
// A post's `::visual[alt](id)` is HTML the backend serves from its own
// cookieless origin (BLOG_EMBED_PUBLIC_URL, https://embed.noeystudio.com) and
// the page shows in `<iframe sandbox="allow-scripts">`. The site builds the
// URL itself from the id — never from a URL in the API answer — and CSP
// `frame-src` gains exactly this origin.

export const DEFAULT_BLOG_EMBED_PUBLIC_URL = "https://embed.noeystudio.com";
const VISUAL_ID = /^[0-9a-f]{32}$/;

/**
 * The embed origin, normalised; null when unusable. https only, unless
 * BLOG_EMBED_ALLOW_HTTP=1 (local testing against a backend on http://…).
 */
export function blogEmbedOrigin(
  raw: string | undefined = process.env.BLOG_EMBED_PUBLIC_URL,
  allowHttp: boolean = process.env.BLOG_EMBED_ALLOW_HTTP === "1",
): string | null {
  const value = (raw ?? "").trim() || DEFAULT_BLOG_EMBED_PUBLIC_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) return null;
  return url.origin;
}

/** `<origin>/visual/<id>` for a well-formed id; null otherwise. */
export function visualSrc(id: unknown, origin: string | null): string | null {
  return origin && typeof id === "string" && VISUAL_ID.test(id) ? `${origin}/visual/${id}` : null;
}
