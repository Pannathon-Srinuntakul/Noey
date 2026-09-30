import type { Metadata } from "next";
import Link from "next/link";
import { StatusCard } from "@/components/ds/StatusCard";
import { SITE_NAME } from "@/lib/site";
import { keepThaiProse } from "@/components/ds/ThaiText";

// Where a self-service account deletion lands. Static and never indexed;
// it shows nothing about the account (the session is already gone).
export const metadata: Metadata = {
  title: { absolute: `ลบบัญชีแล้ว | ${SITE_NAME}` },
  robots: { index: false, follow: false },
};

/** Calm and plain: the quiet status card, no celebration, one way back. */
export default function AccountDeletedPage() {
  return (
    <main id="main" className="status-page page-top">
      <div className="wrap">
        <StatusCard
          tone="quiet"
          eyebrow="บัญชีของฉัน"
          title="ลบบัญชีเรียบร้อยแล้ว"
          role="status"
          actions={
            <Link href="/" className="btn btn-secondary btn-lg">
              กลับหน้าแรก
            </Link>
          }
        >
          <p>
            {keepThaiProse(
              "บัญชีและโปรเจกต์บนเซิร์ฟเวอร์ถูกลบแล้ว และออกจากระบบทุกอุปกรณ์แล้ว ข้อมูลการชำระเงินที่กฎหมายบัญชีและภาษีกำหนดให้เก็บ จะเก็บไว้โดยไม่ผูกกับชื่อหรืออีเมลของคุณ",
            )}
          </p>
          <p>
            {keepThaiProse(
              "ไฟล์ที่อยู่ในเครื่องของคุณเอง เช่น โปรเจกต์ในเบราว์เซอร์ของห้องตัดต่อหรือในแอปบนคอมพิวเตอร์ ยังอยู่ในเครื่องนั้น ลบเองได้ตามต้องการ",
            )}
          </p>
        </StatusCard>
      </div>
    </main>
  );
}
