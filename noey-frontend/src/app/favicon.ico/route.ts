import { buildIco } from "@/lib/ico";
import { renderAppIcon } from "@/lib/server/og";

/**
 * /favicon.ico for clients that request it directly (older browsers, some
 * crawlers and feed readers). Browsers that read <link rel="icon"> use
 * icon.svg instead. Built once at build time from the brand mark.
 */
export const dynamic = "force-static";

export async function GET() {
  const sizes = [16, 32, 48];
  const images = await Promise.all(
    sizes.map(async (size) => ({
      size,
      png: new Uint8Array(await renderAppIcon(size, { rounded: true, markRatio: 0.72 }).arrayBuffer()),
    })),
  );
  return new Response(buildIco(images), {
    headers: { "Content-Type": "image/x-icon", "Cache-Control": "public, max-age=86400" },
  });
}
