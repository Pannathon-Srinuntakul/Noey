import type { Metadata } from "next";
import { AccountTabs } from "@/components/account/AccountTabs";
import { SignOutButton } from "@/components/account/SignOutButton";
import { VerifyEmailBanner } from "@/components/account/VerifyEmail";
import { MSG } from "@/lib/messages";
import { privatePageMetadata } from "@/lib/seo";
import { currentPathname, getMe, resolvePageOutcome } from "@/lib/server/session";
import { sanitizeDisplayName } from "@/lib/session";
import { APP_URL } from "@/lib/site";

// Signed-in area: never indexed (also disallowed in robots.txt).
export const metadata: Metadata = privatePageMetadata("บัญชีของฉัน");

export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const path = await currentPathname("/account");
  const me = resolvePageOutcome(await getMe(), path);
  const name = me?.ok ? sanitizeDisplayName(me.data.display_name) : "";
  const unavailable = !me?.ok;
  const rateLimited = me?.ok === false && me.status === 429;
  // Only an explicit `false` shows the banner (older backends omit the field).
  const needsVerification = me?.ok === true && me.data.email_verified === false;

  return (
    <main id="main" className="container account">
      <div className="account-head">
        <div>
          <p className="eyebrow">บัญชีของฉัน</p>
          <h1>{name ? `สวัสดี คุณ${name}` : "สวัสดี"}</h1>
          <p>หน้านี้ใช้จัดการบัญชี แพลน และดูโควตา ส่วนการสร้างโปรเจกต์และตัดต่ออยู่ในห้องตัดต่อบนเว็บ</p>
        </div>
        <div className="account-actions">
          <SignOutButton />
          <a href={APP_URL} className="btn btn-primary btn-lg">
            เปิดห้องตัดต่อ
          </a>
        </div>
      </div>
      {needsVerification && me?.ok ? <VerifyEmailBanner email={me.data.email} /> : null}
      <AccountTabs />
      {unavailable ? (
        <div className="notice notice--warn" role="alert" style={{ marginTop: 32 }}>
          <p>
            {rateLimited
              ? MSG.rateLimited
              : "ระบบบัญชีขัดข้องชั่วคราว ข้อมูลบางส่วนอาจแสดงไม่ได้ ลองรีเฟรชหน้านี้อีกครั้งในอีกสักครู่"}
          </p>
        </div>
      ) : null}
      {children}
    </main>
  );
}
