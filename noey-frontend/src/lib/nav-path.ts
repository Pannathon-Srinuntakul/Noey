/**
 * The public path a request stands for, for the header's "you are here".
 *
 * Some requests render under another path than the one in the address bar:
 * next.config.ts rewrites the blog's listings to internal param routes
 * (/blog → /blog/page/1, /blog/category/x → /blog/category/x/page/1), and
 * Proxy answers a missing blog URL by rewriting it to `<path>/__missing/404`,
 * a path no route matches (lib/blog-proxy.ts). The server renders with the
 * internal path while the browser hydrates with the public one, so the
 * header maps both back to the public path — otherwise the menu's
 * aria-current differs between the two and React reports a mismatch.
 * No imports: the header ships this to the browser.
 */
export const MISSING_SUFFIX = "/__missing/404";

export function navPathname(pathname: string): string {
  const missing = pathname.indexOf(MISSING_SUFFIX);
  const path = missing >= 0 ? pathname.slice(0, missing) || "/" : pathname;
  return path.replace(/^\/blog\/page\/\d+$/, "/blog").replace(/^\/blog\/(category|tag)\/([^/]+)\/page\/\d+$/, "/blog/$1/$2");
}
