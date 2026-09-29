"use client";

import { useEffect } from "react";
import { sentryOptions, type MonitoringConfig } from "@/lib/sentry-config";

let started = false;

/**
 * Starts the browser SDK once per page load. The chunk is fetched only when
 * the server passed a config; under the nonce CSP it is loaded by the nonce'd
 * Next.js runtime (`'strict-dynamic'`), and it POSTs to the ingest origin that
 * src/proxy.ts adds to `connect-src` for the same DSN. No Session Replay, no
 * feedback widget: the dashboard shows customers' personal data.
 */
export function MonitoringClient({ config }: { config: MonitoringConfig }) {
  useEffect(() => {
    if (started) return;
    started = true;
    import("@sentry/nextjs")
      .then((Sentry) => {
        Sentry.init(sentryOptions(config));
      })
      .catch(() => {
        // Monitoring must never break the page.
      });
  }, [config]);
  return null;
}
