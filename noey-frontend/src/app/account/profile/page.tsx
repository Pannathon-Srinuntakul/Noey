import type { Metadata } from "next";
import Link from "next/link";
import { EmailForm, PasswordForm, ProfileForm } from "@/components/account/ProfileForms";
import { privatePageMetadata } from "@/lib/seo";
import { getMe, resolvePageOutcome } from "@/lib/server/session";
import { sanitizeDisplayName } from "@/lib/session";

export const metadata: Metadata = privatePageMetadata("ข้อมูลส่วนตัว");

export default async function ProfilePage() {
  const me = resolvePageOutcome(await getMe(), "/account/profile");
  if (!me?.ok) {
    return (
      <div className="notice" style={{ marginTop: 32 }} role="status">
        <p>ยังดึงข้อมูลบัญชีไม่ได้ในตอนนี้ ลองรีเฟรชหน้านี้อีกครั้งในอีกสักครู่</p>
      </div>
    );
  }

  return (
    <section className="account-grid" aria-label="ข้อมูลส่วนตัว">
      <div className="card account-card">
        <div className="card-kicker">ข้อมูลส่วนตัว</div>
        <ProfileForm name={sanitizeDisplayName(me.data.display_name)} />
        <div className="card-section" style={{ marginTop: 20 }}>
          <h3>อีเมลที่ใช้เข้าสู่ระบบ</h3>
          <EmailForm email={me.data.email} />
        </div>
      </div>
      <div className="card account-card">
        <div className="card-kicker">ความปลอดภัย</div>
        <PasswordForm />
        <div className="card-section danger-zone" style={{ marginTop: 16 }}>
          <h3>ลบบัญชี</h3>
          <p>โปรเจกต์ที่เก็บไว้บนบัญชีจะถูกลบทั้งหมดและกู้คืนไม่ได้</p>
          {/* The backend has no account-deletion endpoint yet, so there is no button here. */}
          <p>
            ต้องการลบบัญชีถาวร ส่งคำขอผ่าน<Link href="/about#contact">ช่องทางติดต่อ</Link>โดยใช้อีเมลของบัญชีนี้ แล้วทีมงานจะดำเนินการให้
          </p>
        </div>
      </div>
    </section>
  );
}
