/**
 * Browser error monitoring, loaded only when NEXT_PUBLIC_SENTRY_DSN was set
 * at build time. The value is inlined, so with it empty this whole branch —
 * and the SDK chunk — is removed from the bundle.
 *
 * Next.js runs this file before hydration (node_modules/next/dist/docs/
 * 01-app/03-api-reference/03-file-conventions/instrumentation-client.md);
 * the dynamic import is fire-and-forget, so errors in the first moments of a
 * page load may be missed — the price of shipping nothing when disabled.
 * No Session Replay, no feedback widget: the account pages show personal data.
 */
import { baseSentryOptions } from "./lib/sentry-config";

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  import("@sentry/nextjs")
    .then((Sentry) => {
      Sentry.init(baseSentryOptions());
    })
    .catch(() => {
      // Monitoring must never break the page.
    });
}
