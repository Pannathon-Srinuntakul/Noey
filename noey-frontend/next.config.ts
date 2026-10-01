import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { STATIC_CSP_SOURCE, staticContentSecurityPolicy } from "./src/lib/csp";
import { sentryDsn, sentryIngestOrigin } from "./src/lib/sentry-config";

const isProduction = process.env.NODE_ENV === "production";

/**
 * NEXT_PUBLIC_* values are inlined at BUILD time, so that is the only moment
 * a missing one matters (at `next start` the built value is already fixed).
 */
function warnAboutBuildTimeEnv(): void {
  if (!process.env.NEXT_PUBLIC_APP_URL) {
    console.warn("[noey] NEXT_PUBLIC_APP_URL is not set: \"ไปที่แอป\" links will point at http://localhost:5174.");
  }
  if (!process.env.NEXT_PUBLIC_SITE_URL) {
    console.warn("[noey] NEXT_PUBLIC_SITE_URL is not set: canonicals and the sitemap use https://noeystudio.com.");
  }
}

// The CSP itself lives in src/lib/csp.ts (static policy here, nonce policy
// in src/proxy.ts for /account and /checkout).
const sentryOrigin = sentryIngestOrigin(sentryDsn());
const contentSecurityPolicy = staticContentSecurityPolicy(sentryOrigin);

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  ...(isProduction
    ? [
        // Ignored by browsers over plain HTTP; takes effect once served over HTTPS.
        { key: "Strict-Transport-Security", value: "max-age=63072000" },
      ]
    : []),
];

const nextConfig: NextConfig = {
  // The Docker image runs `.next/standalone/server.js` with only the traced
  // files, not a full `node_modules` (see Dockerfile).
  output: "standalone",
  poweredByHeader: false,
  async redirects() {
    return [
      // Website v2 (2026-09-22) replaced the sample-clip page with the honest
      // scope page. Permanent, so search engines move the old URL's signals.
      { source: "/examples", destination: "/scope", permanent: true },
    ];
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // The mock-ups' footage: every URL carries ?v=<content hash> (sample.ts,
      // written by scripts/render-footage/encode.mjs), so a file never changes
      // under its URL.
      { source: "/footage/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
      // Static pages only: /account/* and /checkout/* get a per-request nonce
      // policy from src/proxy.ts instead (both headers would both be enforced).
      ...(isProduction
        ? [{ source: STATIC_CSP_SOURCE, headers: [{ key: "Content-Security-Policy", value: contentSecurityPolicy }] }]
        : []),
      // Point agents from each HTML page to its Markdown twin. Keep in step
      // with the `.md` route folders and `withMarkdownTwin` in lib/seo.ts.
      ...["/pricing", "/scope", "/guide/ai-cut-tiktok", "/guide/thai-subtitles", "/guide/product-review", "/guide/long-to-shorts", "/guide/choose-ai-editor", "/guide/help"].map(
        (path) => ({
          source: path,
          headers: [{ key: "Link", value: `<${path}.md>; rel="alternate"; type="text/markdown"` }],
        }),
      ),
      // Emailed one-time-token pages: never leak the token in a Referer header.
      // (Listed after the site-wide rule so this value wins.)
      { source: "/reset-password", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
      { source: "/verify-email", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
      // Google returns here with ?code=&state= (the handler also sets it on its redirect).
      { source: "/auth/google/callback", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
    ];
  },
};

export default function config(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_BUILD) warnAboutBuildTimeEnv();
  return nextConfig;
}
