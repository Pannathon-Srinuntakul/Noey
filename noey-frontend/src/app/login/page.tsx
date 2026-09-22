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
      <JsonLd
        data={jsonLdGraph(
          webPageNode({ path: PAGES.login.path, name: PAGES.login.title, description: PAGES.login.description, dateModified: PAGES.login.updated }),
        )}
      />
    </main>
  );
}
