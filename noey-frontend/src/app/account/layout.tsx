import type { Metadata } from "next";
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
 * The account area reads as one editor panel: the greeting above it, the
 * four tabs along its top edge, and each tab's cards inside.
 */
export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const path = await currentPathname("/account");
  const me = resolvePageOutcome(await getMe(), path);
  const name = me?.ok ? sanitizeDisplayName(me.data.display_name) : "";
  const unavailable = !me?.ok;
  const rateLimited = me?.ok === false && me.status === 429;
  // Only an explicit `false` shows the banner (older backends omit the field).
  const needsVerification = me?.ok === true && me.data.email_verified === false;

  return (
    <main id="main" className="acct-page page-top">
      <div className="wrap">
        <div className="acct-page__head">
          <p className="acct-page__eyebrow">บัญชีของฉัน</p>
          <h1 className="acct-page__title">{name ? `สวัสดี คุณ${name}` : "สวัสดี"}</h1>
          <p className="acct-page__lead">{keepThaiProse("หน้านี้ใช้จัดการบัญชี แพลน และดูโควตา ส่วนการสร้างโปรเจกต์และตัดต่ออยู่ในห้องตัดต่อบนเว็บ")}</p>
        </div>
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
      </div>
    </main>
  );
}
