import type { Metadata } from "next";
import Link from "next/link";
import { JsonLd } from "@/components/JsonLd";
import { LoginForm } from "@/components/forms/LoginForm";
import { jsonLdGraph, webPageNode } from "@/lib/jsonld";
import { pageMetadata } from "@/lib/seo";
import { PAGES } from "@/lib/site";

// noindex (see the page registry): a login form answers no search query.
export const metadata: Metadata = pageMetadata("login");

export default function LoginPage() {
  return (
    <main id="main" className="container page auth-page">
      <div className="auth-page__form">
        <h1>เข้าสู่ระบบ</h1>
        <p className="auth-page__switch">
          ยังไม่มีบัญชี <Link href="/signup">สมัครใช้งานฟรี</Link>
        </p>
        <LoginForm />
      </div>
      <aside className="auth-aside" aria-labelledby="login-aside-title">
        <h2 id="login-aside-title">เข้ามาแล้วทำอะไรได้</h2>
        <ul>
          <li>
            <h3>โปรเจกต์เดิมอยู่ครบ</h3>
            <p>เปิดงานที่ค้างไว้ต่อได้ทันที รวมถึงเปิดจากคอมเครื่องอื่น</p>
          </li>
          <li>
            <h3>เห็นโควตาในหน้าเดียว</h3>
            <p>เห็นโควตาที่ใช้ไปในรอบปัจจุบันเป็นเปอร์เซ็นต์ พร้อมสัดส่วนงานแต่ละประเภท</p>
          </li>
          <li>
            <h3>แก้และเรนเดอร์ซ้ำได้ไม่จำกัด</h3>
            <p>ปรับไทม์ไลน์กี่รอบก็ได้โดยไม่กระทบโควตา</p>
          </li>
        </ul>
      </aside>
      <JsonLd
        data={jsonLdGraph(
          webPageNode({ path: PAGES.login.path, name: PAGES.login.title, description: PAGES.login.description, dateModified: PAGES.login.updated }),
        )}
      />
    </main>
  );
}
