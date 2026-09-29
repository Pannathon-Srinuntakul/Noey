"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Last-resort error page (replaces the root layout when it fails). Reports
 * the error to Sentry only when NEXT_PUBLIC_SENTRY_DSN was set at build time
 * (https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/,
 * "app/global-error.tsx"); otherwise the SDK is never loaded.
 * Global styles do not reach this page, so it carries its own.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return;
    import("@sentry/nextjs")
      .then((Sentry) => Sentry.captureException(error))
      .catch(() => {});
  }, [error]);

  return (
    <html lang="th">
      <body style={{ fontFamily: "system-ui, sans-serif", maxWidth: "32em", margin: "15vh auto", padding: "0 20px", lineHeight: 1.7, colorScheme: "light dark" }}>
        <title>ระบบขัดข้องชั่วคราว | Noey Studio</title>
        <h1 style={{ fontWeight: 400 }}>ระบบขัดข้องชั่วคราว</h1>
        <p>หน้านี้แสดงไม่ได้ในตอนนี้ ลองใหม่อีกครั้งในอีกสักครู่</p>
        <p>
          <button type="button" onClick={() => retry()} style={{ font: "inherit", padding: "6px 14px", cursor: "pointer" }}>
            ลองอีกครั้ง
          </button>{" "}
          · <Link href="/">กลับหน้าแรก</Link>
        </p>
      </body>
    </html>
  );
}
