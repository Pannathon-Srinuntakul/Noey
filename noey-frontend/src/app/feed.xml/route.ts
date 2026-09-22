import { buildAtomFeed } from "@/lib/feed";

// Static like the rest of the marketing site; the dates come from the page
// registry, not from build time.
export const dynamic = "force-static";
export const revalidate = 600;

export function GET() {
  return new Response(buildAtomFeed(), {
    headers: { "Content-Type": "application/atom+xml; charset=utf-8" },
  });
}
