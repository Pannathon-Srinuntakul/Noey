import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumb } from "@/components/Breadcrumb";
import { JsonLd } from "@/components/JsonLd";
import { formatThaiDate } from "@/lib/format";
import { GUIDE_DOCS, GUIDE_ORDER } from "@/lib/guide";
import { breadcrumbNode, itemListNode, jsonLdGraph, webPageNode } from "@/lib/jsonld";
import { pageMetadata } from "@/lib/seo";
import { PAGES } from "@/lib/site";

export const metadata: Metadata = pageMetadata("guide");

const TRAIL = [
  { name: PAGES.home.label, path: PAGES.home.path },
  { name: PAGES.guide.label, path: PAGES.guide.path },
];

/** Index of the answer pages. Each entry shows the page's own opening answer. */
export default function GuideIndexPage() {
  const page = PAGES.guide;
  const jsonLd = jsonLdGraph(
    webPageNode({
      path: page.path,
      name: page.title,
      description: page.description,
      dateModified: page.updated,
      type: "CollectionPage",
    }),
    itemListNode({
      path: page.path,
      name: "คู่มือใช้งาน Noey Studio",
      items: GUIDE_ORDER.map((key) => ({ name: GUIDE_DOCS[key].h1, path: PAGES[key].path })),
    }),
    breadcrumbNode(TRAIL),
  );

  return (
    <main id="main" className="container page">
      <article className="legal guide">
        <Breadcrumb trail={TRAIL} />
        <h1 className="page-title legal__title">คู่มือใช้งานและคำตอบที่ถามบ่อย</h1>
        <p className="legal__intro guide__answer">
          หน้านี้รวมคำตอบของคำถามที่คนถามบ่อยที่สุดก่อนเริ่มตัดคลิปสั้นด้วย AI ทั้งวิธีตัดคลิป TikTok การใส่ซับไทยอัตโนมัติ
          การตัดคลิปรีวิวสินค้า การตัดคลิปยาวเป็นคลิปสั้นหลายตัว เกณฑ์เลือกเครื่องมือ และหน้าช่วยเหลือที่รวมโหมด ไฟล์ที่รองรับ
          ขีดจำกัดของแต่ละแพลน และวิธีแก้ปัญหาไว้ที่เดียว
        </p>
        <p className="legal__updated">
          อัปเดตล่าสุด <time dateTime={page.updated}>{formatThaiDate(page.updated)}</time>
        </p>

        {GUIDE_ORDER.map((key) => {
          const doc = GUIDE_DOCS[key];
          const entry = PAGES[key];
          return (
            <section key={key} className="legal__section" aria-labelledby={`${key}-heading`}>
              <h2 id={`${key}-heading`}>
                <Link href={entry.path}>{doc.h1}</Link>
              </h2>
              <p>{doc.answer}</p>
              <p className="guide__meta">
                หัวข้อในหน้านี้: {doc.sections.map((section) => section.title).join(" · ")}
              </p>
            </section>
          );
        })}

        <section className="legal__section" aria-labelledby="scope-links-heading">
          <h2 id="scope-links-heading">อ่านต่อนอกคู่มือ</h2>
          <ul className="guide__list guide__related">
            <li>
              <Link href={PAGES.scope.path}>{PAGES.scope.label}</Link> — ขอบเขตของระบบ ทำอะไรได้ และอะไรที่ยังทำไม่ได้
            </li>
            <li>
              <Link href={PAGES.pricing.path}>{PAGES.pricing.label}</Link> — ตารางเทียบทั้งเจ็ดแพลน โควตา และเพดานฟุตเทจ
            </li>
            <li>
              <Link href={PAGES.about.path}>{PAGES.about.label}</Link> — ที่มาของเครื่องมือ และช่องทางติดต่อทีมงาน
            </li>
            <li>
              <Link href={PAGES.signup.path}>{PAGES.signup.label}</Link> — ทดลองกับฟุตเทจของคุณเองด้วยแพลนฟรี
            </li>
          </ul>
        </section>

        <div className="legal__foot">
          <Link href={PAGES.home.path}>กลับหน้าแรก</Link>
          <Link href={PAGES.pricing.path}>ดูราคาและโควตา</Link>
        </div>
      </article>
      <JsonLd data={jsonLd} />
    </main>
  );
}
