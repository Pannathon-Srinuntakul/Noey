import type { Metadata, Viewport } from "next";
import { Noto_Sans_Thai } from "next/font/google";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/header/SiteHeader";
import { PREPAINT_SCRIPT } from "@/lib/prepaint";
import { SITE_VERIFICATION } from "@/lib/server/config";
import { LOCALE, PAGES, SITE_NAME, SITE_URL } from "@/lib/site";
import "./globals.css";
import "./site.css";

// Self-hosted by next/font (no request to Google at runtime). Noto Sans Thai
// is a variable font: one file per subset covers every weight the design uses
// (300–600). Thai + Latin subsets are preloaded; `swap` plus next/font's
// metric-matched fallback keep the font switch from shifting layout.
const notoSansThai = Noto_Sans_Thai({
  subsets: ["thai", "latin"],
  display: "swap",
  variable: "--font-noto-thai",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: PAGES.home.title, template: `%s | ${SITE_NAME}` },
  description: PAGES.home.description,
  applicationName: SITE_NAME,
  openGraph: { type: "website", siteName: SITE_NAME, locale: LOCALE },
  twitter: { card: "summary_large_image" },
  formatDetection: { telephone: false, email: false, address: false },
  verification: {
    google: SITE_VERIFICATION.google,
    other: SITE_VERIFICATION.bing ? { "msvalidate.01": SITE_VERIFICATION.bing } : undefined,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f2f2" },
    { media: "(prefers-color-scheme: dark)", color: "#171614" },
  ],
  colorScheme: "light dark",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // data-theme / data-auth are written by the pre-paint script before React
    // hydrates, hence suppressHydrationWarning on <html> only.
    <html lang="th" className={notoSansThai.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: PREPAINT_SCRIPT }} />
        <meta httpEquiv="content-language" content="th" />
        {/* Feed discovery. Written here rather than through `alternates` in
            metadata: a page that sets its own canonical replaces the layout's
            whole `alternates` object, which would drop this link. */}
        <link rel="alternate" type="application/atom+xml" title={`${SITE_NAME} — อัปเดตเนื้อหา`} href="/feed.xml" />
      </head>
      <body>
        <a className="skip-link" href="#main">
          ข้ามไปที่เนื้อหา
        </a>
        <SiteHeader />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
