import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";

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

/**
 * Content-Security-Policy. `'unsafe-inline'` scripts are required because the
 * marketing pages are static (no per-request nonce) and carry the theme
 * pre-paint script and JSON-LD; every script ORIGIN is still pinned.
 * Turnstile is the only third-party script. `form-action` lists Stripe's
 * hosted pages because a no-JavaScript plan-button submit is answered with a
 * 303 redirect to Checkout / the Customer Portal — if the backend ever uses a
 * Stripe custom domain, add it here.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src https://challenges.cloudflare.com",
  "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  ...(isProduction
    ? [
        { key: "Content-Security-Policy", value: contentSecurityPolicy },
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
      {
        // Point agents from the HTML pricing page to its Markdown twin.
        source: "/pricing",
        headers: [{ key: "Link", value: '</pricing.md>; rel="alternate"; type="text/markdown"' }],
      },
      // Emailed one-time-token pages: never leak the token in a Referer header.
      // (Listed after the site-wide rule so this value wins.)
      { source: "/reset-password", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
      { source: "/verify-email", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
    ];
  },
};

export default function config(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_BUILD) warnAboutBuildTimeEnv();
  return nextConfig;
}
