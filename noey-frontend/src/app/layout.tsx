import type { Metadata, Viewport } from "next";
import { Noto_Sans_Thai } from "next/font/google";
import { BetaBanner } from "@/components/beta/BetaBanner";
import { BetaNotice } from "@/components/beta/BetaNotice";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/header/SiteHeader";
import { Atmosphere } from "@/components/shell/Atmosphere";
import { EditorOpenOverlay } from "@/components/shell/EditorOpening";
import { MotionRuntime } from "@/components/shell/MotionRuntime";
import { RouteTransition } from "@/components/shell/RouteTransition";
import { betaNoticeCopy, shouldShowBetaBanner } from "@/lib/beta";
import { PREPAINT_SCRIPT } from "@/lib/prepaint";
import { catalogIsBetaPriced } from "@/lib/server/prices";
import { SITE_VERIFICATION } from "@/lib/server/config";
import { LOCALE, PAGES, SITE_NAME, SITE_URL } from "@/lib/site";
import "./globals.css";
import "../styles/shell.css";
import "../styles/components.css";
import "../styles/parts/loading.css";

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

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const betaPriced = await catalogIsBetaPriced();
  // The beta strip is decided here, on the server, so it is part of the first
  // paint (no layout shift); BetaNotice re-checks the date in the browser.
  const betaStrip = shouldShowBetaBanner();
  return (
    // data-theme / data-auth are written by the pre-paint script before React
    // hydrates, hence suppressHydrationWarning on <html> only.
    <html lang="th" className={notoSansThai.variable} data-beta-banner={betaStrip ? "" : undefined} suppressHydrationWarning>
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
        {/* The beta disclosure: the pinned strip, and the modal on a first
            visit. Both stop rendering by themselves once the beta ends, and
            neither mentions a discount the live catalog is not charging. */}
        {betaStrip ? <BetaBanner text={betaNoticeCopy(betaPriced).banner} /> : null}
        <BetaNotice betaPriced={betaPriced} />
        <SiteHeader />
        <RouteTransition>{children}</RouteTransition>
        <SiteFooter />
        <Atmosphere />
        <EditorOpenOverlay />
        <MotionRuntime />
      </body>
    </html>
  );
}
