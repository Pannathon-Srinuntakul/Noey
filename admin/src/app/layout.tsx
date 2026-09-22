import type { Metadata, Viewport } from "next";
import { Noto_Sans_Thai } from "next/font/google";
import "./globals.css";
import "./admin.css";

// Self-hosted by next/font at build time — no request to Google at runtime,
// which the strict CSP (font-src 'self') requires.
const notoSansThai = Noto_Sans_Thai({
  subsets: ["thai", "latin"],
  weight: ["300", "400", "500", "600"],
  display: "swap",
  variable: "--font-noto-thai",
});

export const metadata: Metadata = {
  title: "Noey Studio — แผงผู้ดูแลระบบ",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  referrer: "no-referrer",
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  themeColor: "#f3f2f2",
  colorScheme: "light",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="th" data-theme="light" className={notoSansThai.variable}>
      <body>{children}</body>
    </html>
  );
}
