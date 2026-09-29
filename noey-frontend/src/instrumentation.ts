/**
 * Server error monitoring (Node.js and edge runtimes), per
 * https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/ —
 * but the SDK is imported ONLY when NEXT_PUBLIC_SENTRY_DSN is set, so an
 * unconfigured deployment boots and runs exactly as before.
 */
import type { Instrumentation } from "next";
import { baseSentryOptions, sentryDsn } from "./lib/sentry-config";

let enabled = false;

export async function register() {
  if (!sentryDsn()) return;
  try {
    const Sentry = await import("@sentry/nextjs");
    Sentry.init({ ...baseSentryOptions(), serverName: "noey-frontend" });
    enabled = true;
  } catch (error) {
    // Monitoring must never stop the site from starting.
    console.warn(`[sentry] not started: ${(error as Error).message}`);
  }
}

/** Errors thrown while rendering, in Route Handlers, Server Actions and Proxy. */
export const onRequestError: Instrumentation.onRequestError = async (...args) => {
  if (!enabled) return;
  const Sentry = await import("@sentry/nextjs");
  Sentry.captureRequestError(...args);
};
