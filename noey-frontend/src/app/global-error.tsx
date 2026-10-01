"use client";

import Link from "next/link";
import { useEffect } from "react";

/*
 * Global styles do not reach this page (it replaces the root layout), so it
 * carries its own: the site's colour tokens (the same values as globals.css,
 * light and dark) and the status card drawn small — the splice mark in the
 * accent colour over a render bar cut in two.
 */
const CSS = `
:root {
  color-scheme: light dark;
  --bg: #f3f2f2;
  --panel: #eae9e9;
  --ink: #201f1d;
  --ink-2: #444141;
  --line: color-mix(in srgb, #201f1d 16%, transparent);
  --gold: #b68235;
  --gold-ink: #7d5411;
  --on-gold: #201f1d;
  --danger: #9b2c1f;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #171614;
    --panel: #201f1d;
    --ink: #f3f2f2;
    --ink-2: #d5d1ca;
    --line: #35322d;
    --gold: #d9a441;
    --gold-ink: #dcb05a;
    --on-gold: #171614;
    --danger: #f0a095;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px 16px;
  background: var(--bg);
  color: var(--ink);
  font-family: "Noto Sans Thai", system-ui, sans-serif;
  font-weight: 300;
  line-height: 1.7;
}
.ge {
  width: min(100%, 520px);
  padding: 40px 28px 34px;
  border: 1px solid var(--line);
  border-radius: 20px;
  background: var(--panel);
  text-align: center;
}
.ge__mark { color: var(--gold); }
.ge__bar { position: relative; width: 160px; height: 6px; margin: 16px auto 22px; border-radius: 6px; background: var(--line); }
.ge__bar::before { content: ""; position: absolute; inset: 0 52% 0 0; border-radius: 6px; background: var(--danger); }
.ge__bar::after { content: ""; position: absolute; top: -4px; bottom: -4px; left: 50%; width: 3px; background: var(--danger); rotate: 22deg; }
h1 { margin: 0 0 8px; font-size: 1.75rem; font-weight: 600; line-height: 1.35; }
p { margin: 0; color: var(--ink-2); }
.ge__actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 12px; margin-top: 24px; }
.ge__btn { font: inherit; font-weight: 600; min-height: 44px; padding: 0 22px; border: 0; border-radius: 10px; background: var(--gold); color: var(--on-gold); cursor: pointer; }
.ge__btn:focus-visible, .ge a:focus-visible { outline: 2px solid var(--gold); outline-offset: 3px; }
.ge a { color: var(--gold-ink); font-weight: 500; text-underline-offset: 4px; }
`;

/**
 * Last-resort error page (replaces the root layout when it fails). Reports
 * the error to Sentry only when NEXT_PUBLIC_SENTRY_DSN was set at build time
 * (https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/,
 * "app/global-error.tsx"); otherwise the SDK is never loaded.
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
      <body>
        <style>{CSS}</style>
        <title>ระบบขัดข้องชั่วคราว | Noey Studio</title>
        <main className="ge">
          <svg
            className="ge__mark"
            width="44"
            height="44"
            viewBox="0 0 100 100"
            fill="none"
            stroke="currentColor"
            strokeWidth="13"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M22 78 V 22" />
            <path d="M22 22 L 44 55" />
            <path d="M56 45 L 78 78" />
            <path d="M78 78 V 22" />
          </svg>
          <div className="ge__bar" aria-hidden="true" />
          <h1>ระบบขัดข้องชั่วคราว</h1>
          <p>หน้านี้แสดงไม่ได้ในตอนนี้ ลองใหม่อีกครั้งในอีกสักครู่</p>
          <p className="ge__actions">
            <button type="button" className="ge__btn" onClick={() => retry()}>
              ลองอีกครั้ง
            </button>{" "}
            · <Link href="/">กลับหน้าแรก</Link>
          </p>
        </main>
      </body>
    </html>
  );
}
