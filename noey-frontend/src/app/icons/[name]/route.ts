import { APP_ICONS, type AppIconName } from "@/lib/icons";
import { renderAppIcon } from "@/lib/server/og";

/**
 * PNG app icons for the web manifest and the Organization logo in JSON-LD,
 * drawn from the logo's app-icon spec at build time (no binaries in the repo).
 */
export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return Object.keys(APP_ICONS).map((name) => ({ name }));
}

export async function GET(_request: Request, context: { params: Promise<{ name: string }> }) {
  const { name } = await context.params;
  const icon = APP_ICONS[name as AppIconName];
  if (!icon) return new Response("Not found", { status: 404 });
  const response = renderAppIcon(icon.size, { rounded: icon.rounded, markRatio: icon.rounded ? 0.6 : 0.5 });
  return new Response(await response.arrayBuffer(), {
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
  });
}
