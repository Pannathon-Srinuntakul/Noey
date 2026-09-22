import type { Metadata } from "next";
import Link from "next/link";
import { JsonLd } from "@/components/JsonLd";
import { SignupForm } from "@/components/forms/SignupForm";
import { PLAN_COPY } from "@/lib/plans";
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
        <section aria-labelledby="signup-free-title" style={{ marginTop: 40 }}>
          <h2 id="signup-free-title" className="subsection-title" style={{ marginBottom: 12, fontSize: 17 }}>
            แพลนฟรีได้อะไรบ้าง
          </h2>
          <ul className="ruled-list">
            {PLAN_COPY.free.features.map((feature) => (
              <li key={feature}>{feature}</li>
            ))}
            <li>ใช้บนคอมพิวเตอร์ผ่าน Chrome หรือ Edge เวอร์ชันใหม่ ไม่ต้องติดตั้งโปรแกรม</li>
            <li>ได้ไฟล์วิดีโอแนวตั้ง 1080×1920 พร้อมลง TikTok, Reels หรือ Shorts</li>
          </ul>
          <p className="fine" style={{ marginTop: 14 }}>
            อ่านก่อนสมัคร: <Link href={PAGES.scope.path}>ระบบทำอะไรได้บ้าง</Link> ·{" "}
            <Link href={PAGES.guideHelp.path}>โหมด ไฟล์ และโควตา</Link> · <Link href={PAGES.pricing.path}>ราคาแพลนอื่น</Link>
          </p>
        </section>
      </div>
      <JsonLd data={jsonLd} />
    </main>
  );
}
