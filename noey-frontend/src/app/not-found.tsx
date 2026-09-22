import type { Metadata } from "next";
import Link from "next/link";
import { SITE_NAME } from "@/lib/site";

export const metadata: Metadata = {
  title: { absolute: `ไม่พบหน้าที่ต้องการ | ${SITE_NAME}` },
  robots: { index: false, follow: true },
};

export default function NotFound() {
  return (
    <main id="main" className="container page">
      <p className="eyebrow">404</p>
      <h1 className="page-title">ไม่พบหน้าที่ต้องการ</h1>
      <p className="lead" style={{ maxWidth: "36em" }}>
        ลิงก์นี้อาจพิมพ์ผิด หรือหน้าถูกย้ายไปแล้ว ลองเริ่มจากหน้าเหล่านี้แทน
      </p>
      <ul className="link-list">
        <li>
          <Link href="/" className="btn btn-primary btn-lg">
            กลับหน้าแรก
          </Link>
        </li>
        <li>
          <Link href="/pricing" className="btn btn-secondary btn-lg">
            ดูราคา
          </Link>
        </li>
        <li>
          <Link href="/scope" className="btn btn-secondary btn-lg">
            ดูว่าทำอะไรได้บ้าง
          </Link>
        </li>
      </ul>
    </main>
  );
}
