import { createHash, timingSafeEqual } from "node:crypto";
import { revalidatePath, revalidateTag } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";

/**
 * POST /api/revalidate-prices — called server-to-server by the admin app
 * (admin/) right after an admin changes a plan price, so the pricing surfaces
 * stop serving the old amount without waiting out the 10-minute ISR window.
 *
 * Authorised by a shared secret (PRICES_REVALIDATE_SECRET, the same value on
 * both services) in `Authorization: Bearer …`. Unset = the route does not
 * exist (404). It only marks cached data stale; it reads and writes nothing.
 */
function secretMatches(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  const secret = process.env.PRICES_REVALIDATE_SECRET?.trim();
  if (!secret) return new NextResponse(null, { status: 404 });
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
  if (!secretMatches(given, secret)) return new NextResponse(null, { status: 401 });

  // Stale content is never served again: the next visit refetches GET /billing/plans.
  revalidateTag("billing-plans", { expire: 0 });
  for (const path of ["/", "/pricing", "/pricing.md", "/llms.txt"]) revalidatePath(path);
  return NextResponse.json({ revalidated: true }, { headers: { "Cache-Control": "no-store" } });
}
