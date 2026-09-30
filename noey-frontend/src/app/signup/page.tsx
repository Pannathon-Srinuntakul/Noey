import type { Metadata } from "next";
import Link from "next/link";
import { AuthStage } from "@/components/auth/AuthStage";
import { JsonLd } from "@/components/JsonLd";
import { IconCheck } from "@/components/ds/icons";
import { SignupForm } from "@/components/forms/SignupForm";
import { PLAN_COPY } from "@/lib/plans";
import { googleSignInEnabled } from "@/lib/server/google";
import { jsonLdGraph, webPageNode } from "@/lib/jsonld";
import { pageMetadata } from "@/lib/seo";
import { PAGES } from "@/lib/site";
import "../../styles/pages/auth.css";
import { keepThaiProse } from "@/components/ds/ThaiProse";

export const metadata: Metadata = pageMetadata("signup");
// Static, refreshed every 5 minutes: only whether the Google button shows can change.
export const revalidate = 300;

/**
 * Split screen: the form on the left, clean and still while you type; the
 * editor playing slowly on the right (hidden on phones).
 */
export default async function SignupPage() {
  const googleEnabled = await googleSignInEnabled();
  const page = PAGES.signup;
  const jsonLd = jsonLdGraph(
    webPageNode({ path: page.path, name: page.title, description: page.description, dateModified: page.updated }),
  );

  return (
    <main id="main" className="auth">
      <div className="wrap auth__grid">
        <div className="auth__main">
          <div className="auth__form">
            <SignupForm googleEnabled={googleEnabled} />
          </div>
          <section className="auth-free" aria-labelledby="signup-free-title">
            <h2 id="signup-free-title" className="auth-free__title">
              แพลนฟรีได้อะไรบ้าง
            </h2>
            <ul className="auth-free__list">
              {PLAN_COPY.free.features.map((feature) => (
                <li key={feature}>
                  <IconCheck size={16} className="auth-free__tick" />
                  <span>{keepThaiProse(feature)}</span>
                </li>
              ))}
              <li>
                <IconCheck size={16} className="auth-free__tick" />
                <span>{keepThaiProse("ใช้บนคอมพิวเตอร์ผ่าน Chrome หรือ Edge เวอร์ชันใหม่ ไม่ต้องติดตั้งโปรแกรม")}</span>
              </li>
              <li>
                <IconCheck size={16} className="auth-free__tick" />
                <span>{keepThaiProse("ได้ไฟล์วิดีโอแนวตั้ง 1080×1920 พร้อมลง TikTok, Reels หรือ Shorts")}</span>
              </li>
            </ul>
            <p className="fine auth-free__read">
              {/* Each link keeps its "·" on its own line: a line never starts with one. */}
              อ่านก่อนสมัคร:{" "}
              <span className="kt">
                <Link href={PAGES.scope.path}>ระบบทำอะไรได้บ้าง</Link> ·
              </span>{" "}
              <span className="kt">
                <Link href={PAGES.guideHelp.path}>โหมด ไฟล์ และโควตา</Link> ·
              </span>{" "}
              <Link href={PAGES.pricing.path}>ราคาแพลนอื่น</Link>
            </p>
          </section>
        </div>
        <AuthStage />
      </div>
      <JsonLd data={jsonLd} />
    </main>
  );
}
