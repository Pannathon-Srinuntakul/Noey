import { renderAppIcon } from "@/lib/server/og";

// iOS rounds the corners itself, so the tile stays square.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return renderAppIcon(180, { rounded: false });
}
