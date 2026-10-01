import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { blogEmbedOrigin, blogMediaBase, blogMediaCspOrigin, blogMediaRemotePattern } from "./src/lib/blog-media";
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

// Where blog images come from (BLOG_MEDIA_PUBLIC_URL, read at BUILD time;
// lib/blog-media.ts): the one origin + path next/image may optimise, and —
// only for a non-https base such as a local backend — the one origin CSP
// img-src gains.
const blogMedia = blogMediaBase();
if (process.env.BLOG_MEDIA_PUBLIC_URL && !blogMedia) {
  console.warn("[noey] BLOG_MEDIA_PUBLIC_URL is not an http(s) URL without a query: blog images will not be optimised.");
}
const blogMediaPattern = blogMediaRemotePattern(blogMedia);
// Where in-article visuals are framed from (BLOG_EMBED_PUBLIC_URL, read at
// BUILD time like the media base; http only with BLOG_EMBED_ALLOW_HTTP=1).
const blogEmbed = blogEmbedOrigin();
if (process.env.BLOG_EMBED_PUBLIC_URL && !blogEmbed) {
  console.warn("[noey] BLOG_EMBED_PUBLIC_URL is not usable (https, or http with BLOG_EMBED_ALLOW_HTTP=1): visuals will not show.");
}

// The CSP itself lives in src/lib/csp.ts (static policy here, nonce policy
// in src/proxy.ts for /account and /checkout).
const sentryOrigin = sentryIngestOrigin(sentryDsn());
const contentSecurityPolicy = staticContentSecurityPolicy(sentryOrigin, blogMediaCspOrigin(blogMedia), blogEmbed);

// Blog listings: the public URL (`/blog?page=N`) is served by a static param
// route (app/blog/page/[page], …/category/[slug]/page/[page], …/tag/…).
const BLOG_SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";
const PAGE_NUMBER = "(?<page>[1-9][0-9]{0,3})";

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
  // A post's share image is drawn at run time (not at build like the others)
  // with the bundled Thai font files, read from disk: ship them in the image.
  outputFileTracingIncludes: { "/blog/**": ["./src/assets/og/*.woff"] },
  poweredByHeader: false,
  // Frozen at build time, like the image patterns built from it, so the
  // server's "may this image be optimised?" can never disagree with them.
  env: {
    BLOG_MEDIA_PUBLIC_URL: blogMedia ?? "",
    BLOG_EMBED_PUBLIC_URL: blogEmbed ?? "",
    BLOG_EMBED_ALLOW_HTTP: process.env.BLOG_EMBED_ALLOW_HTTP === "1" ? "1" : "",
  },
  images: {
    remotePatterns: blogMediaPattern ? [blogMediaPattern] : [],
    qualities: [75],
  },
  async redirects() {
    return [
      // Website v2 (2026-09-22) replaced the sample-clip page with the honest
      // scope page. Permanent, so search engines move the old URL's signals.
      { source: "/examples", destination: "/scope", permanent: true },
      // The blog's internal listing routes (see rewrites) answer at their
      // public URLs only. Redirects run on the visitor's URL, never on a
      // rewritten one, so these cannot loop.
      { source: "/blog/page/1", destination: "/blog", permanent: true },
      { source: "/blog/page/:page(\\d+)", destination: "/blog?page=:page", permanent: true },
      { source: `/blog/:kind(category|tag)/:slug(${BLOG_SLUG})/page/1`, destination: "/blog/:kind/:slug", permanent: true },
      { source: `/blog/:kind(category|tag)/:slug(${BLOG_SLUG})/page/:page(\\d+)`, destination: "/blog/:kind/:slug?page=:page", permanent: true },
      { source: `/blog/md/:slug(${BLOG_SLUG})`, destination: "/blog/:slug.md", permanent: true },
    ];
  },
  async rewrites() {
    return {
      // Before the filesystem, so /blog itself never needs a page of its own.
      beforeFiles: [
        { source: "/blog", has: [{ type: "query", key: "page", value: PAGE_NUMBER }], destination: "/blog/page/:page" },
        { source: "/blog", destination: "/blog/page/1" },
        {
          source: `/blog/:kind(category|tag)/:slug(${BLOG_SLUG})`,
          has: [{ type: "query", key: "page", value: PAGE_NUMBER }],
          destination: "/blog/:kind/:slug/page/:page",
        },
        { source: `/blog/:kind(category|tag)/:slug(${BLOG_SLUG})`, destination: "/blog/:kind/:slug/page/1" },
        // A post's Markdown twin (/blog/<slug>.md): a dynamic segment cannot
        // carry a suffix, so the twin's route lives at /blog/md/<slug>.
        { source: `/blog/:slug(${BLOG_SLUG})\\.md`, destination: "/blog/md/:slug" },
      ],
    };
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
      // Every blog post points at its twin the same way (lib/blog-seo.ts adds the <link>).
      {
        source: `/blog/:slug(${BLOG_SLUG})`,
        headers: [{ key: "Link", value: '</blog/:slug.md>; rel="alternate"; type="text/markdown"' }],
      },
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
