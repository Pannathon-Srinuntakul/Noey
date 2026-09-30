import type { Metadata } from "next";
import { cookies } from "next/headers";
import { DeleteAccount } from "@/components/account/DeleteAccount";
import { GoogleLinkPanel, SetPasswordByEmail } from "@/components/account/GoogleLink";
import { EmailForm, PasswordForm, ProfileForm } from "@/components/account/ProfileForms";
import { REAUTH_COOKIE, googleMessage } from "@/lib/google-auth";
import { privatePageMetadata } from "@/lib/seo";
import { googleSignInEnabled } from "@/lib/server/google";
import { getMe, resolvePageOutcome } from "@/lib/server/session";
import { sanitizeDisplayName } from "@/lib/session";
import { keepThaiProse } from "@/components/ds/ThaiText";

export const metadata: Metadata = privatePageMetadata("ข้อมูลส่วนตัว");

export default async function ProfilePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = resolvePageOutcome(await getMe(), "/account/profile");
  if (!me?.ok) {
    return (
      <div className="notice" role="status">
        <p>ยังดึงข้อมูลบัญชีไม่ได้ในตอนนี้ ลองรีเฟรชหน้านี้อีกครั้งในอีกสักครู่</p>
      </div>
    );
  }

  const params = await searchParams;
  const googleCode = typeof params.google === "string" ? params.google : null;
  // Older backends omit these fields: an account then has a password and no Google link.
  const hasPassword = me.data.has_password !== false;
  const googleLinked = me.data.google_linked === true;
  const googleEnabled = await googleSignInEnabled().catch(() => false);
  // A Google re-auth proof waits in an HttpOnly cookie (never readable by scripts).
  const googleVerified = !!(await cookies()).get(REAUTH_COOKIE)?.value;
  // Back from a Google re-auth: `confirm` = verified, `retry` = it failed (`google` says why).
  const deleteStep = params.delete === "confirm" || params.delete === "retry" ? params.delete : null;
  const flowNotice = googleMessage(googleCode);

  return (
    <section className="account-grid acct-profile" aria-label="ข้อมูลส่วนตัว">
      <div className="card account-card">
        <div className="card-kicker">ข้อมูลส่วนตัว</div>
        <ProfileForm name={sanitizeDisplayName(me.data.display_name)} />
        <div className="card-section">
          <h3>อีเมลที่ใช้เข้าสู่ระบบ</h3>
          {hasPassword ? (
            <EmailForm email={me.data.email} />
          ) : (
            <p className="field-hint">
              {me.data.email} — การเปลี่ยนอีเมลต้องยืนยันด้วยรหัสผ่านปัจจุบัน ตั้งรหัสผ่านก่อนได้ที่ส่วนความปลอดภัย
            </p>
          )}
        </div>
      </div>
      <div className="card account-card">
        <div className="card-kicker">ความปลอดภัย</div>
        {hasPassword ? <PasswordForm /> : <SetPasswordByEmail email={me.data.email} />}
        {googleEnabled || googleLinked ? (
          <div className="card-section" id="google">
            <h3>บัญชี Google</h3>
            <GoogleLinkPanel
              linked={googleLinked}
              googleEmail={me.data.google_email ?? null}
              hasPassword={hasPassword}
              notice={deleteStep ? null : flowNotice}
            />
          </div>
        ) : null}
      </div>
      {/* The one block drawn in the danger colour, on its own at the end of the tab. */}
      <div className="card account-card danger-zone acct-danger" id="delete-account">
        <div className="acct-danger__copy">
          <h3>ลบบัญชี</h3>
          <p>{keepThaiProse("ลบบัญชีและโปรเจกต์ทั้งหมดบนเซิร์ฟเวอร์อย่างถาวร กู้คืนไม่ได้ ก่อนยืนยันจะแสดงรายละเอียดว่าอะไรถูกลบและอะไรเก็บไว้")}</p>
        </div>
        <div className="danger-zone__action">
          <DeleteAccount
            hasPassword={hasPassword}
            googleLinked={googleLinked}
            googleVerified={googleVerified}
            openOnLoad={deleteStep !== null}
            notice={deleteStep === "retry" ? flowNotice : null}
          />
        </div>
      </div>
    </section>
  );
}
