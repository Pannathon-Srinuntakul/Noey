import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Resolves the `@/*` alias from tsconfig.json.
    tsconfigPaths: true,
    alias: {
      // `server-only` throws outside the react-server condition; tests import
      // server modules directly, so stub it out.
      "server-only": fileURLToPath(new URL("./src/test/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      NEXT_PUBLIC_SITE_URL: "https://noeystudio.com",
      // Nothing listens on the discard port: code that calls the backend sees
      // it down at once, whatever runs on this machine's :8000.
      API_URL: "http://127.0.0.1:9",
      TZ: "UTC",
    },
  },
});
