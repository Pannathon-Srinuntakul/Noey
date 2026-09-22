import type { Metadata } from "next";
import { LegalPage } from "@/components/LegalPage";
import { PRIVACY } from "@/lib/legal";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata("privacy");

export default function PrivacyPage() {
  return <LegalPage pageKey="privacy" title="นโยบายความเป็นส่วนตัว" doc={PRIVACY} />;
}
