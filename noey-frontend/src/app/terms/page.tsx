import type { Metadata } from "next";
import { LegalPage } from "@/components/LegalPage";
import { TERMS } from "@/lib/legal";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata("terms");

export default function TermsPage() {
  return <LegalPage pageKey="terms" title="เงื่อนไขการใช้งาน" doc={TERMS} />;
}
