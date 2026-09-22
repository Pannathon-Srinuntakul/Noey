import type { Metadata } from "next";
import { GuideArticle } from "@/components/guide/GuideArticle";
import { GUIDE_DOCS } from "@/lib/guide";
import { markdownTwinPath, pageMetadata, withMarkdownTwin } from "@/lib/seo";

export const metadata: Metadata = withMarkdownTwin(pageMetadata("guideLongform"), markdownTwinPath("guideLongform"));

export default function Page() {
  return <GuideArticle doc={GUIDE_DOCS.guideLongform} />;
}
