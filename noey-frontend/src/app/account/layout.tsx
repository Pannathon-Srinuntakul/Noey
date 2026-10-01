import type { Metadata } from "next";
import { Suspense } from "react";
import { AccountPanelSkeleton } from "@/components/account/AccountSkeleton";
import { AccountTabs } from "@/components/account/AccountTabs";
import { VerifyEmailBanner } from "@/components/account/VerifyEmail";
import { MSG } from "@/lib/messages";
import { privatePageMetadata } from "@/lib/seo";
import { currentPathname, getMe, resolvePageOutcome } from "@/lib/server/session";
import { sanitizeDisplayName } from "@/lib/session";
import "../../styles/pages/account.css";
import { keepThaiProse } from "@/components/ds/ThaiProse";

// Signed-in area: never indexed (also disallowed in robots.txt).
export const metadata: Metadata = privatePageMetadata("บัญชีของฉัน");

/**
 * GET /auth/me for this request (React-cached: the greeting, the panel and
 * the pages share one call), or leave for /login or the refresh route.
 */
async function readMe() {
  const path = await currentPathname("/account");
  return resolvePageOutcome(await getMe(), path);
}

async function Greeting() {
  const me = await readMe();
  const name = me?.ok ? sanitizeDisplayName(me.data.display_name) : "";
  return <h1 className="acct-page__title">{name ? `สวัสดี คุณ${name}` : "สวัสดี"}</h1>;
}

/**
 * While the account is read, the greeting is drawn from the name the header
 * already shows (the pre-paint script's greeting variable, from the same
 * cookie the server's greeting matches), so it does not change on arrival.
 */
function GreetingFallback() {
  return (
    <h1 className="acct-page__title">
      สวัสดี
      <span className="acct-greet" aria-hidden="true" />
    </h1>
  );
}

async function AccountPanel({ children }: { children: React.ReactNode }) {
  const me = await readMe();
  const unavailable = !me?.ok;
  const rateLimited = me?.ok === false && me.status === 429;
  // Only an explicit `false` shows the banner (older backends omit the field).
  const needsVerification = me?.ok === true && me.data.email_verified === false;

  return (
    <>
      {needsVerification && me?.ok ? <VerifyEmailBanner email={me.data.email} /> : null}
      <div className="acct-page__panel">
        <AccountTabs />
        <div className="acct-page__body">
          {unavailable ? (
            <div className="notice notice--warn" role="alert">
              <p>
                {rateLimited
                  ? MSG.rateLimited
                  : "ระบบบัญชีขัดข้องชั่วคราว ข้อมูลบางส่วนอาจแสดงไม่ได้ ลองรีเฟรชหน้านี้อีกครั้งในอีกสักครู่"}
              </p>
            </div>
          ) : null}
          {children}
        </div>
      </div>
    </>
  );
}

/**
 * The account area reads as one editor panel: the greeting above it, the
 * four tabs along its top edge, and each tab's cards inside.
 *
 * The frame (eyebrow, lead) is drawn at once; what needs the account — the
 * greeting, the verification banner, the panel — waits in its own Suspense
 * boundary with the panel's skeleton (the documented way to keep a layout's
 * runtime data from blocking navigation). Switching tabs never re-renders
 * this layout: app/account/loading.tsx fills the panel's body meanwhile.
 */
export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return (
    <main id="main" className="acct-page page-top">
      <div className="wrap">
        <div className="acct-page__head">
          <p className="acct-page__eyebrow">บัญชีของฉัน</p>
          <Suspense fallback={<GreetingFallback />}>
            <Greeting />
          </Suspense>
          <p className="acct-page__lead">{keepThaiProse("หน้านี้ใช้จัดการบัญชี แพลน และดูโควตา ส่วนการสร้างโปรเจกต์และตัดต่ออยู่ในห้องตัดต่อบนเว็บ")}</p>
        </div>
        <Suspense fallback={<AccountPanelSkeleton />}>
          <AccountPanel>{children}</AccountPanel>
        </Suspense>
      </div>
    </main>
  );
}
