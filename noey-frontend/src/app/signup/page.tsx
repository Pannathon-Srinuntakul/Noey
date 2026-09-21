import type { Metadata } from "next";
import { JsonLd } from "@/components/JsonLd";
import { SignupForm } from "@/components/forms/SignupForm";
import { jsonLdGraph, webPageNode } from "@/lib/jsonld";
import { pageMetadata } from "@/lib/seo";
import { PAGES } from "@/lib/site";

export const metadata: Metadata = pageMetadata("signup");

export default function SignupPage() {
  const page = PAGES.signup;
  const jsonLd = jsonLdGraph(
    webPageNode({ path: page.path, name: page.title, description: page.description, dateModified: page.updated }),
  );

  return (
    <main id="main" className="container page auth-page">
      <div className="auth-page__form">
        <SignupForm />
      </div>
      <aside className="auth-aside" aria-labelledby="signup-aside-title">
        <h2 id="signup-aside-title">สมัครแล้วได้อะไร</h2>
        <ul>
          <li>
            <h3>ใช้แพลนฟรีได้ทันที</h3>
            <p>ตัดคลิปสั้นได้ทุกวันตามโควตา ไม่มีวันหมดอายุ และไม่ต้องผูกบัตร</p>
          </li>
          <li>
            <h3>ได้ทุกโหมดตั้งแต่วันแรก</h3>
            <p>รวมโหมดพากย์ใหม่พร้อมสคริปต์ AI แพลนฟรีต่างแค่โควตาต่อวันและความยาวฟุตเทจ</p>
          </li>
          <li>
            <h3>งานเปิดต่อจากเครื่องอื่นได้</h3>
            <p>โปรเจกต์ผูกกับบัญชี ย้ายไปทำต่อที่คอมอีกเครื่องได้โดยไม่ต้องเริ่มใหม่</p>
          </li>
        </ul>
      </aside>
      <JsonLd data={jsonLd} />
    </main>
  );
}
