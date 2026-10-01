/**
 * The public path a request stands for, for the header's "you are here".
 *
 * next.config.ts rewrites the blog's listings to internal param routes
 * (/blog → /blog/page/1, /blog/category/x → /blog/category/x/page/1). A
 * listing prerendered at build time renders with the internal path while
 * the browser hydrates with the public one, so the header maps both back to
 * the public path — otherwise the menu's aria-current differs between the
 * two and React reports a mismatch. No imports: the header ships this to
 * the browser.
 */
export function navPathname(pathname: string): string {
  return pathname.replace(/^\/blog\/page\/\d+$/, "/blog").replace(/^\/blog\/(category|tag)\/([^/]+)\/page\/\d+$/, "/blog/$1/$2");
}

/**
 * The segment Next gives its 404 route in the route tree. The tree is the
 * same on the server and in the browser (it comes with the page), so a 404
 * is told apart while hydrating, whatever the address bar says.
 */
export const NOT_FOUND_SEGMENT = "/_not-found";
