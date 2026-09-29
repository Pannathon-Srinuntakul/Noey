/**
 * Server error monitoring, per
 * https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/ —
 * mirrors noey-frontend/src/instrumentation.ts, but the DSN is the RUN-time
 * SENTRY_DSN (lib/sentry-config.ts). Unset, the SDK is never imported and the
 * dashboard boots and runs exactly as before.
 */
import type { Instrumentation } from "next";
import { monitoringConfig, sentryOptions } from "./lib/sentry-config";

let enabled = false;

export async function register() {
  const config = monitoringConfig();
  if (!config) return;
  try {
    const Sentry = await import("@sentry/nextjs");
    Sentry.init({ ...sentryOptions(config), serverName: "noey-admin" });
    enabled = true;
  } catch (error) {
    // Monitoring must never stop the dashboard from starting.
    console.warn(`[sentry] not started: ${(error as Error).message}`);
  }
}

/** Errors thrown while rendering, in Route Handlers, Server Actions and Proxy. */
export const onRequestError: Instrumentation.onRequestError = async (...args) => {
  if (!enabled) return;
  const Sentry = await import("@sentry/nextjs");
  Sentry.captureRequestError(...args);
};
