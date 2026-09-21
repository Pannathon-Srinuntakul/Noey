import type { MetadataRoute } from "next";
import { SITE_URL } from "./site";

/**
 * Everyone may crawl the public site; nobody crawls the signed-in area, the
 * checkout return page, the emailed one-time-token pages or the API.
 *
 * AI search and assistant crawlers are named explicitly so the policy is a
 * stated decision, not an assumption. Under robots.txt rules a crawler that
 * matches a named group IGNORES the `*` group — so every named group repeats
 * the same Disallow lines instead of getting a bare `Allow: /`.
 * (Crawler user-agent names are the one place vendor names appear; they are
 * directives, not UI.)
 */
export const PRIVATE_PATHS = ["/account", "/checkout", "/reset-password", "/verify-email", "/api"];

export const SEARCH_AND_AI_CRAWLERS = [
  "Googlebot",
  "Google-Extended",
  "Bingbot",
  "Applebot",
  "Applebot-Extended",
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "PerplexityBot",
  "Perplexity-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "Claude-User",
  "anthropic-ai",
  "DuckAssistBot",
];

export function robotsRules(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: PRIVATE_PATHS },
      { userAgent: SEARCH_AND_AI_CRAWLERS, allow: "/", disallow: PRIVATE_PATHS },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
