import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumb } from "@/components/Breadcrumb";
import { JsonLd } from "@/components/JsonLd";
import { ClipCard } from "@/components/ds/ClipCard";
import { IconArrowLeft, IconArrowRight } from "@/components/ds/icons";
import { PageHero } from "@/components/ds/PageHero";
import { SectionHeader } from "@/components/ds/SectionHeader";
import { BinThumb } from "@/components/guide/BinThumb";
import { formatThaiDate } from "@/lib/format";
import { GUIDE_DOCS, GUIDE_ORDER } from "@/lib/guide";
import { breadcrumbNode, itemListNode, jsonLdGraph, webPageNode } from "@/lib/jsonld";
import { pageMetadata } from "@/lib/seo";
import { PAGES } from "@/lib/site";
import "../../styles/pages/guide-index.css";

export const metadata: Metadata = pageMetadata("guide");

const TRAIL = [
  { name: PAGES.home.label, path: PAGES.home.path },
  { name: PAGES.guide.label, path: PAGES.guide.path },
];

const MORE = [
  { href: PAGES.scope.path, label: PAGES.scope.label, note: "ขอบเขตของระบบ ทำอะไรได้ และอะไรที่ยังทำไม่ได้" },
  { href: PAGES.pricing.path, label: PAGES.pricing.label, note: "ตารางเทียบทั้งเจ็ดแพลน โควตา และเพดานฟุตเทจ" },
  { href: PAGES.about.path, label: PAGES.about.label, note: "ที่มาของเครื่องมือ และช่องทางติดต่อทีมงาน" },
  { href: PAGES.signup.path, label: PAGES.signup.label, note: "ทดลองกับฟุตเทจของคุณเองด้วยแพลนฟรี" },
];

/**
 * Index of the answer pages, laid out as an editor's media bin: each guide is
 * a clip with a thumbnail generated from the guide itself (hover scrubs it),
 * its question as the title, its own opening answer, and its section list.
 */
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
    <main id="main" className="guide-index">
      <PageHero
        crumb={<Breadcrumb trail={TRAIL} />}
        title="คู่มือใช้งานและคำตอบที่ถามบ่อย"
        lead={
          <p>
            หน้านี้รวมคำตอบของคำถามที่คนถามบ่อยที่สุดก่อนเริ่มตัดคลิปสั้นด้วย AI ทั้งวิธีตัดคลิป TikTok การใส่ซับไทยอัตโนมัติ
            การตัดคลิปรีวิวสินค้า การตัดคลิปยาวเป็นคลิปสั้นหลายตัว เกณฑ์เลือกเครื่องมือ และหน้าช่วยเหลือที่รวมโหมด ไฟล์ที่รองรับ
            ขีดจำกัดของแต่ละแพลน และวิธีแก้ปัญหาไว้ที่เดียว
          </p>
        }
        meta={
          <p className="stamp">
            อัปเดตล่าสุด <time dateTime={page.updated}>{formatThaiDate(page.updated)}</time>
          </p>
        }
      />

      <section className="bin" aria-label="บทความในคู่มือ">
        <div className="wrap">
          <div className="bin__bar" aria-hidden="true">
            <span className="trk tc">BIN</span>
            <span className="bin__count tc">{GUIDE_ORDER.length} CLIPS</span>
            <span className="bin__rule" />
          </div>
          <ul className="bin__grid" data-reveal="stagger">
            {GUIDE_ORDER.map((key, index) => {
              const doc = GUIDE_DOCS[key];
              const entry = PAGES[key];
              const file = entry.path.split("/").pop() ?? key;
              // The thumbnail's running time grows with the guide's own text.
              const chars = doc.sections.reduce(
                (total, section) => total + section.paragraphs.join("").length + (section.bullets?.join("").length ?? 0),
                0,
              );
              return (
                <li key={key} className="bin__item">
                  <article className="clip clip--link bin__clip">
                    <BinThumb
                      name={`${file}.mov`}
                      sections={doc.sections.length}
                      seed={index * 7 + 3}
                      length={chars / 9}
                    />
                    <div className="clip__body bin__body">
                      <h2 id={`${key}-heading`} className="clip__title bin__title">
                        <Link href={entry.path} className="clip__link">
                          {doc.h1}
                        </Link>
                      </h2>
                      <p className="bin__answer">{doc.answer}</p>
                      <p className="bin__meta">
                        หัวข้อในหน้านี้: {doc.sections.map((section) => section.title).join(" · ")}
                      </p>
                    </div>
                  </article>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <section className="sect guide-more" aria-labelledby="scope-links-heading">
        <div className="wrap">
          <SectionHeader id="scope-links-heading" track="R2" timecode="00:01:30:00" title="อ่านต่อนอกคู่มือ" size="h-3" />
          <ul className="link-grid" data-reveal="stagger">
            {MORE.map((item, index) => (
              <li key={item.href}>
                <ClipCard title={item.label} titleAs="h3" href={item.href} seed={index + 31} track={`X${index + 1}`}>
                  <p>{item.note}</p>
                </ClipCard>
              </li>
            ))}
          </ul>
          <div className="guide-more__foot">
            <Link href={PAGES.home.path} className="btn btn-secondary">
              <IconArrowLeft size={16} />
              กลับหน้าแรก
            </Link>
            <Link href={PAGES.pricing.path} className="btn btn-primary" data-magnetic="">
              ดูราคาและโควตา
              <IconArrowRight size={16} />
            </Link>
          </div>
        </div>
      </section>
      <JsonLd data={jsonLd} />
    </main>
  );
}
