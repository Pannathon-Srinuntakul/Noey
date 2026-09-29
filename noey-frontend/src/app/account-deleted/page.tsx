import type { Metadata } from "next";
import Link from "next/link";
import { SITE_NAME } from "@/lib/site";

// Where a self-service account deletion lands. Static and never indexed;
// it shows nothing about the account (the session is already gone).
export const metadata: Metadata = {
  title: { absolute: `ลบบัญชีแล้ว | ${SITE_NAME}` },
  robots: { index: false, follow: false },
};

export default function AccountDeletedPage() {
  return (
    <main id="main" className="container page">
      <p className="eyebrow">บัญชีของฉัน</p>
      <h1 className="page-title">ลบบัญชีเรียบร้อยแล้ว</h1>
      <div className="card status-card" role="status">
        <p>
          บัญชีและโปรเจกต์บนเซิร์ฟเวอร์ถูกลบแล้ว และออกจากระบบทุกอุปกรณ์แล้ว
          ข้อมูลการชำระเงินที่กฎหมายบัญชีและภาษีกำหนดให้เก็บ จะเก็บไว้โดยไม่ผูกกับชื่อหรืออีเมลของคุณ
        </p>
        <p>
          ไฟล์ที่อยู่ในเครื่องของคุณเอง เช่น โปรเจกต์ในเบราว์เซอร์ของห้องตัดต่อหรือในแอปบนคอมพิวเตอร์ ยังอยู่ในเครื่องนั้น ลบเองได้ตามต้องการ
        </p>
        <div className="button-row">
          <Link href="/" className="btn btn-secondary btn-lg">
            กลับหน้าแรก
          </Link>
        </div>
      </div>
    </main>
  );
}
