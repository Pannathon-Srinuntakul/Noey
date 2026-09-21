import "server-only";
import { NextResponse } from "next/server";

/**
 * Same-site redirect from a Route Handler with a RELATIVE `Location` (valid
 * per RFC 9110). When self-hosted behind a proxy, a Route Handler's
 * `request.url` is the address Next.js listens on (e.g. http://localhost:3000),
 * so `new URL(path, request.url)` would send visitors to that internal host.
 * `path` must already be a sanitised same-site path.
 */
export function redirectTo(path: string, status: 303 | 307 = 307): NextResponse {
  return new NextResponse(null, { status, headers: { Location: path, "Cache-Control": "no-store" } });
}
