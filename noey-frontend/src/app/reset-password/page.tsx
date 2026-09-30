import type { Metadata } from "next";
import Link from "next/link";
import { StatusCard } from "@/components/ds/StatusCard";
import { ResetPasswordForm } from "@/components/forms/ResetPasswordForm";
import { MSG } from "@/lib/messages";
import { tokenPageMetadata } from "@/lib/seo";

// Opened from the reset email: always rendered per request, never cached,
// noindex, disallowed in robots.txt and sent with Referrer-Policy: no-referrer.
export const dynamic = "force-dynamic";
export const metadata: Metadata = tokenPageMetadata("ตั้งรหัสผ่านใหม่");

/** The reset form, or — for a missing or broken link — the way to ask for a new one; both on the status card. */
export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { token } = await searchParams;
  const valid = typeof token === "string" && token.length > 0 && token.length <= 2048;

  return (
    <main id="main" className="status-page page-top">
      <div className="wrap">
        {valid ? (
          <StatusCard tone="info" eyebrow="บัญชีของฉัน" title="ตั้งรหัสผ่านใหม่">
            <p>ตั้งรหัสผ่านใหม่อย่างน้อย 8 ตัวอักษร เสร็จแล้วระบบจะพาเข้าสู่ระบบให้ทันที</p>
            <div className="status__form">
              <ResetPasswordForm token={token} />
            </div>
          </StatusCard>
        ) : (
          <StatusCard
            tone="danger"
            eyebrow="บัญชีของฉัน"
            title="ตั้งรหัสผ่านใหม่"
            role="alert"
            actions={
              <Link href="/login?forgot=1" className="btn btn-primary btn-lg">
                ขอลิงก์ตั้งรหัสผ่านใหม่
              </Link>
            }
          >
            <p>{MSG.linkExpired} หรือลิงก์ไม่ครบ ลองเปิดจากอีเมลอีกครั้ง</p>
          </StatusCard>
        )}
      </div>
    </main>
  );
}
