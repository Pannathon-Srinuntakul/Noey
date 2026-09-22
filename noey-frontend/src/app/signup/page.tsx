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
      <JsonLd data={jsonLd} />
    </main>
  );
}
