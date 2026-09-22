import { NextResponse, type NextRequest } from "next/server";
import { ctxFrom, summarize, usersCsv } from "@/lib/money";
import { isSameSiteNavigation } from "@/lib/origin";
import { adminApi } from "@/lib/server/api";
import { accessToken } from "@/lib/server/auth";
import type { DashboardData } from "@/lib/types";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /export?from=YYYY-MM-DD&to=YYYY-MM-DD — the users table as CSV, priced
 * with the SAVED cost config (lib/money.ts), cells escaped against formula
 * injection. Authenticated like every page; refused unless the request is a
 * navigation from this app (Sec-Fetch-Site) — a cross-site link cannot
 * download it, and SameSite=Strict cookies would not ride along anyway.
 */
export async function GET(request: NextRequest) {
  const noStore = { "Cache-Control": "no-store" };
  if (!isSameSiteNavigation(request.headers)) return new NextResponse("forbidden", { status: 403, headers: noStore });
  const from = request.nextUrl.searchParams.get("from") ?? "";
  const to = request.nextUrl.searchParams.get("to") ?? "";
  if (!DATE.test(from) || !DATE.test(to)) return new NextResponse("bad period", { status: 400, headers: noStore });

  const token = await accessToken();
  if (!token) return NextResponse.redirect(new URL("/login", request.url));
  const r = await adminApi<DashboardData>(`/admin/dashboard?from=${from}&to=${to}`, { token });
  if (!r.ok) {
    if (r.status === 401) return NextResponse.redirect(new URL("/signout", request.url));
    return new NextResponse("export failed", { status: r.status === 0 ? 503 : 502, headers: noStore });
  }
  const csv = usersCsv(summarize(ctxFrom(r.data), r.data.users));
  return new NextResponse(csv, {
    headers: {
      ...noStore,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="noey-usage-${from}_${to}.csv"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
