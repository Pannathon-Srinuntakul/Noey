import type { Metadata } from "next";
import Link from "next/link";
import { ResetPasswordForm } from "@/components/forms/ResetPasswordForm";
import { MSG } from "@/lib/messages";
import { tokenPageMetadata } from "@/lib/seo";

// Opened from the reset email: always rendered per request, never cached,
// noindex, disallowed in robots.txt and sent with Referrer-Policy: no-referrer.
export const dynamic = "force-dynamic";
export const metadata: Metadata = tokenPageMetadata("ตั้งรหัสผ่านใหม่");

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { token } = await searchParams;
  const valid = typeof token === "string" && token.length > 0 && token.length <= 2048;

  return (
    <main id="main" className="container page">
      <div className="auth-page__form" style={{ maxWidth: 420 }}>
        <p className="eyebrow">บัญชีของฉัน</p>
        <h1 className="page-title">ตั้งรหัสผ่านใหม่</h1>
        {valid ? (
          <>
            <p className="lead" style={{ margin: "0 0 28px", fontSize: 15 }}>
              ตั้งรหัสผ่านใหม่อย่างน้อย 8 ตัวอักษร เสร็จแล้วระบบจะพาเข้าสู่ระบบให้ทันที
            </p>
            <ResetPasswordForm token={token} />
          </>
        ) : (
          <div className="notice notice--warn" role="alert">
            <p>{MSG.linkExpired} หรือลิงก์ไม่ครบ ลองเปิดจากอีเมลอีกครั้ง</p>
            <p>
              <Link href="/login?forgot=1">ขอลิงก์ตั้งรหัสผ่านใหม่</Link>
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
