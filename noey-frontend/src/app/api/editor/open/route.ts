import type { NextRequest } from "next/server";
import { resolveEditorDestination } from "@/lib/editor-handoff";
import { redirectTo } from "@/lib/server/redirect";
import { authedApi, readSessionTokens } from "@/lib/server/session";
import { APP_URL } from "@/lib/site";

interface HandoffOut {
  code?: unknown;
}

/**
 * GET /api/editor/open — every "เปิดห้องตัดต่อ" button links here.
 *
 * Signed in: mint a one-time handoff code server-side (refreshing the access
 * token first if needed — this is a Route Handler, so the new cookies are
 * written) and answer 303 to `<editor>/#handoff=<code>`. Signed out, or
 * anything going wrong: 303 to the editor as it is, which shows its own login.
 * Why GET and why the code rides in the fragment: src/lib/editor-handoff.ts.
 */
export async function GET(request: NextRequest) {
  const tokens = await readSessionTokens();
  const destination = await resolveEditorDestination({
    appUrl: APP_URL,
    secFetchSite: request.headers.get("sec-fetch-site"),
    hasSession: Boolean(tokens.access || tokens.refresh),
    mint: async () => {
      const outcome = await authedApi<HandoffOut>(
        "/auth/handoff",
        { method: "POST", body: { target: "editor" } },
        { mutable: true },
      );
      if (outcome.kind !== "ok" || !outcome.result.ok) return { ok: false };
      return { ok: true, code: outcome.result.data?.code };
    },
  });
  // Absolute on purpose: the editor is another origin (APP_URL is our own config).
  const response = redirectTo(destination, 303);
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
