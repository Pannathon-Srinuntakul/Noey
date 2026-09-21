import { OG_COPY } from "@/lib/og-copy";
import { renderOgImage } from "@/lib/server/og";

// Generated at build time with a bundled Thai font (see lib/server/og.tsx).
export const alt = OG_COPY.home.alt;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return renderOgImage(OG_COPY.home);
}
