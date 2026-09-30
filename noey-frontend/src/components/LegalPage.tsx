import Link from "next/link";
import { Fragment } from "react";
import { formatThaiDate } from "@/lib/format";
import { breadcrumbNode, jsonLdGraph, webPageNode } from "@/lib/jsonld";
import type { LegalDoc } from "@/lib/legal";
import { PAGES, type PageKey } from "@/lib/site";
import { Breadcrumb } from "./Breadcrumb";
import { ClipCard } from "./ds/ClipCard";
import { PageHero } from "./ds/PageHero";
import { TimelineToc } from "./ds/TimelineToc";
import { JsonLd } from "./JsonLd";
import "../styles/pages/article.css";
import { keepThai } from "./ds/ThaiText";

type LegalKey = Extract<PageKey, "terms" | "privacy">;

/** A paragraph with `{about}` rendered as a link to the contact form. */
function Paragraph({ text }: { text: string }) {
  const parts = text.split("{about}");
  return (
    <p>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {keepThai(part)}
          {index < parts.length - 1 ? <Link href={`${PAGES.about.path}#contact`}>เกี่ยวกับเรา</Link> : null}
        </Fragment>
      ))}
    </p>
  );
}

/**
 * Shared frame for /terms and /privacy (Website v2): breadcrumb, title,
 * intro, date, numbered sections, then the related pages. The calmest page
 * on the site: the same timeline table of contents as the guides (a cue per
 * section, a playhead at the reading position), wide margins, and almost no
 * motion.
 */
export function LegalPage({ pageKey, title, doc }: { pageKey: LegalKey; title: string; doc: LegalDoc }) {
  const page = PAGES[pageKey];
  const other = PAGES[pageKey === "terms" ? "privacy" : "terms"];
  const otherLabel = pageKey === "terms" ? "อ่านนโยบายความเป็นส่วนตัว" : "อ่านเงื่อนไขการใช้งาน";
  const trail = [
    { name: PAGES.home.label, path: PAGES.home.path },
    { name: page.label, path: page.path },
  ];
  const sectionId = (index: number) => `s${String(index + 1).padStart(2, "0")}`;
  const toc = [
    ...doc.sections.map((section, index) => ({ id: sectionId(index), label: section.title })),
    { id: `${pageKey}-related-section`, label: "หน้าที่เกี่ยวข้อง", cue: "→" },
  ];
  const related = [
    { href: other.path, label: other.label, note: "เอกสารอีกฉบับที่ใช้ร่วมกับหน้านี้" },
    { href: PAGES.guideHelp.path, label: PAGES.guideHelp.label, note: "โหมดการตัด ไฟล์ที่รองรับ โควตา และการแก้ปัญหา" },
    { href: PAGES.pricing.path, label: PAGES.pricing.label, note: "ราคา ขีดจำกัดของแต่ละแพลน และการยกเลิก" },
    { href: PAGES.scope.path, label: PAGES.scope.label, note: "ขอบเขตของระบบ สิ่งที่ทำได้และทำไม่ได้" },
  ];

  return (
    <main id="main" className="article-page legal-page">
      <PageHero
        crumb={<Breadcrumb trail={trail} />}
        title={title}
        lead={<p>{keepThai(doc.intro)}</p>}
        meta={
          <p className="stamp">
            อัปเดตล่าสุด <time dateTime={page.updated}>{formatThaiDate(page.updated)}</time>
          </p>
        }
      />
      <div className="wrap article-layout">
        <aside className="article-layout__toc">
          <TimelineToc items={toc} label="หัวข้อในหน้านี้" />
        </aside>
        <article className="article legal">
          {doc.sections.map((section, index) => (
            <section key={section.title} id={sectionId(index)} className="article__section legal__section">
              <h2 className="article__h2 legal__h2">
                <span className="num legal__n">{String(index + 1).padStart(2, "0")}</span>
                <span>{section.title}</span>
              </h2>
              <div className="prose">
                {section.paragraphs.map((paragraph) => (
                  <Paragraph key={paragraph} text={paragraph} />
                ))}
              </div>
            </section>
          ))}
          <section className="article__section" id={`${pageKey}-related-section`} aria-labelledby={`${pageKey}-related`}>
            <h2 id={`${pageKey}-related`} className="article__h2">
              หน้าที่เกี่ยวข้อง
            </h2>
            <ul className="link-grid article__related">
              {related.map((item, index) => (
                <li key={item.href}>
                  <ClipCard title={item.label} titleAs="h3" href={item.href} seed={index + 21}>
                    <p>{keepThai(item.note)}</p>
                  </ClipCard>
                </li>
              ))}
            </ul>
          </section>
          <div className="article__foot">
            <Link href={other.path} className="btn btn-secondary">
              {otherLabel}
            </Link>
            <Link href="/" className="btn btn-ghost">
              กลับหน้าแรก
            </Link>
          </div>
        </article>
      </div>
      <JsonLd
        data={jsonLdGraph(
          webPageNode({ path: page.path, name: page.title, description: page.description, dateModified: page.updated }),
          breadcrumbNode(trail),
        )}
      />
    </main>
  );
}
