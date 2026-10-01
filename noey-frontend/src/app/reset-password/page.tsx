import type { Metadata } from "next";
import Link from "next/link";
import { AuthStage } from "@/components/auth/AuthStage";
import { StatusCard } from "@/components/ds/StatusCard";
import { ResetPasswordForm } from "@/components/forms/ResetPasswordForm";
import { MSG } from "@/lib/messages";
import { tokenPageMetadata } from "@/lib/seo";
import "../../styles/pages/auth.css";

// Opened from the reset email: always rendered per request, never cached,
// noindex, disallowed in robots.txt and sent with Referrer-Policy: no-referrer.
export const dynamic = "force-dynamic";
export const metadata: Metadata = tokenPageMetadata("ตั้งรหัสผ่านใหม่");

/**
 * The reset form, laid out as /login is (the form beside the editor playing
 * slowly: the same door into the same place) — or, for a missing or broken
 * link, the way to ask for a new one, on the status card.
 */
export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { token } = await searchParams;
  const valid = typeof token === "string" && token.length > 0 && token.length <= 2048;

  if (valid) {
    return (
      <main id="main" className="auth">
        <div className="wrap auth__grid">
          <div className="auth__main">
            <div className="auth__form">
              <h1>ตั้งรหัสผ่านใหม่</h1>
              <p className="auth-page__switch">บันทึกแล้วระบบจะพาเข้าสู่ระบบให้ทันที</p>
              <ResetPasswordForm token={token} />
            </div>
          </div>
          <AuthStage />
        </div>
      </main>
    );
  }

  return (
    <main id="main" className="status-page page-top">
      <div className="wrap">
        <StatusCard
          tone="danger"
          eyebrow="ตั้งรหัสผ่านใหม่"
          title="ลิงก์นี้ใช้ไม่ได้แล้ว"
          role="alert"
          actions={
            <Link href="/login?forgot=1" className="btn btn-primary btn-lg">
              ขอลิงก์ตั้งรหัสผ่านใหม่
            </Link>
          }
        >
          <p>{MSG.linkExpired} หรือลิงก์ไม่ครบ ลองเปิดจากอีเมลอีกครั้ง</p>
        </StatusCard>
      </div>
    </main>
  );
}
