import type { Metadata } from "next";
import Link from "next/link";
import { AuthStage } from "@/components/auth/AuthStage";
import { ComputerOnly } from "@/components/ComputerOnly";
import { JsonLd } from "@/components/JsonLd";
import { GoogleSignInForm, OrDivider } from "@/components/auth/GoogleSignInForm";
import { LoginForm } from "@/components/forms/LoginForm";
import { jsonLdGraph, webPageNode } from "@/lib/jsonld";
import { pageMetadata } from "@/lib/seo";
import { googleSignInEnabled } from "@/lib/server/google";
import { PAGES } from "@/lib/site";
import "../../styles/pages/auth.css";

// noindex (see the page registry): a login form answers no search query.
export const metadata: Metadata = pageMetadata("login");
// Static, refreshed every 5 minutes: only whether the Google button shows can change.
export const revalidate = 300;

/** Split screen, as on /signup: the form, and the editor playing slowly beside it. */
export default async function LoginPage() {
  const googleEnabled = await googleSignInEnabled();
  return (
    <main id="main" className="auth">
      <div className="wrap auth__grid">
        <div className="auth__main">
          <div className="auth__form">
            {/* The same place as on /signup: above the heading, not between it and the form. */}
            <ComputerOnly className="computer-only--top" />
            <h1>เข้าสู่ระบบ</h1>
            <p className="auth-page__switch">
              ยังไม่มีบัญชี <Link href="/signup">สมัครใช้งานฟรี</Link>
            </p>
            <GoogleSignInForm from="login" enabled={googleEnabled} />
            {googleEnabled ? <OrDivider /> : null}
            <LoginForm />
          </div>
        </div>
        <AuthStage />
      </div>
      <JsonLd
        data={jsonLdGraph(
          webPageNode({ path: PAGES.login.path, name: PAGES.login.title, description: PAGES.login.description, dateModified: PAGES.login.updated }),
        )}
      />
    </main>
  );
}
