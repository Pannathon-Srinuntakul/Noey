import type { MetadataRoute } from "next";
import { appIconPath } from "@/lib/icons";
import { BRAND, PAGES, SITE_NAME } from "@/lib/site";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${SITE_NAME} — ตัดคลิปด้วย AI`,
    short_name: SITE_NAME,
    description: PAGES.home.description,
    lang: "th",
    dir: "ltr",
    start_url: "/",
    scope: "/",
    display: "browser",
    background_color: BRAND.ground,
    theme_color: BRAND.ground,
    icons: [
      { src: "/icon.svg", type: "image/svg+xml", sizes: "any", purpose: "any" },
      { src: appIconPath("icon-192.png"), type: "image/png", sizes: "192x192", purpose: "any" },
      { src: appIconPath("icon-512.png"), type: "image/png", sizes: "512x512", purpose: "any" },
      { src: appIconPath("icon-maskable-512.png"), type: "image/png", sizes: "512x512", purpose: "maskable" },
    ],
  };
}
