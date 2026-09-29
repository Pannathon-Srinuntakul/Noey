import { connection } from "next/server";
import { monitoringConfig } from "@/lib/sentry-config";
import { MonitoringClient } from "./MonitoringClient";

/**
 * Browser error monitoring, switched by the RUN-time SENTRY_DSN. Read here, on
 * the server, and handed to the client as a prop — the admin has no
 * NEXT_PUBLIC_* values, so noey-frontend's build-time instrumentation-client.ts
 * does not fit. Renders nothing at all when monitoring is off.
 */
export async function Monitoring() {
  await connection(); // the env must be read per request, never at build time
  const config = monitoringConfig();
  return config ? <MonitoringClient config={config} /> : null;
}
