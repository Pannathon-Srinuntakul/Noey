import { buildChangelogFeed } from "@/lib/changelog-feed";

// Static like the rest of the marketing site; the dates come from the entries.
export const dynamic = "force-static";
export const revalidate = 600;

export function GET() {
  return new Response(buildChangelogFeed(), {
    headers: { "Content-Type": "application/atom+xml; charset=utf-8" },
  });
}
