/**
 * "Open the editor" with the site's session carried over — one login for
 * both apps. Pure (no Next.js import) so the decision is unit-tested; the
 * Route Handler at app/api/editor/open/route.ts wires in cookies and the API.
 *
 * The site and the editor are different subdomains with different session
 * storage (HttpOnly cookies here, the editor's own browser storage there), so
 * nothing is shared. Instead this site's SERVER asks the API for a one-time
 * code as the signed-in user (POST /auth/handoff, 60 s, single use, stored
 * hashed) and sends the browser to `<editor>/#handoff=<code>`. The editor
 * strips the fragment at once and redeems the code for its own pair.
 * A fragment never reaches a server log or a Referer header. Flow and
 * security notes: docs/auth-handoff.md.
 *
 * Why a GET link and not a POST form: the route mints only for the session
 * in the visitor's OWN cookie and sends the code only to the visitor's own
 * browser, so a cross-site page that triggers it achieves nothing but
 * opening the victim's editor as the victim (no login CSRF: it can never
 * sign anyone in as someone else). Minting has no other side effect. A
 * plain link also keeps open-in-new-tab and no-JavaScript working. As belt
 * and braces, a navigation another SITE started (`Sec-Fetch-Site:
 * cross-site`) gets the plain editor URL without a code.
 */

/** Same-site path every "open editor" button links to. */
export const EDITOR_OPEN_PATH = "/api/editor/open";

/** The fragment key the editor looks for (web/src/lib/handoff.ts). */
export const HANDOFF_FRAGMENT_KEY = "handoff";

/** What the API mints: `secrets.token_urlsafe(32)` (43 chars). Anything else is not forwarded. */
export function isHandoffCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{20,128}$/.test(value);
}

/** Absolute editor URL carrying the code in the fragment (never the query). */
export function editorHandoffUrl(appUrl: string, code: string): string {
  const url = new URL(appUrl);
  url.search = "";
  url.hash = `${HANDOFF_FRAGMENT_KEY}=${encodeURIComponent(code)}`;
  return url.toString();
}

/**
 * Only navigations the visitor started on our own site (or typed / bookmarked:
 * `none`) mint. A browser without Fetch Metadata sends no header; those are
 * allowed — the GET is harmless anyway (see above), this is defence in depth.
 */
export function mayMintFor(secFetchSite: string | null): boolean {
  return secFetchSite !== "cross-site";
}

export type MintResult = { ok: true; code: unknown } | { ok: false };

/**
 * Where to send the browser. Every failure — no session, a cross-site start,
 * the API down or refusing, a malformed code — falls back to the plain editor
 * URL, where the editor's own login screen takes over. Never an error page.
 */
export async function resolveEditorDestination(options: {
  appUrl: string;
  secFetchSite: string | null;
  hasSession: boolean;
  mint: () => Promise<MintResult>;
}): Promise<string> {
  const plain = options.appUrl;
  if (!options.hasSession || !mayMintFor(options.secFetchSite)) return plain;
  let minted: MintResult;
  try {
    minted = await options.mint();
  } catch {
    return plain;
  }
  if (!minted.ok || !isHandoffCode(minted.code)) return plain;
  try {
    return editorHandoffUrl(options.appUrl, minted.code);
  } catch {
    return plain;
  }
}
