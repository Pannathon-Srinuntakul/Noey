import Link from "next/link";
import { Fragment } from "react";
import { formatThaiDate } from "@/lib/format";
import { breadcrumbNode, jsonLdGraph, webPageNode } from "@/lib/jsonld";
import type { LegalDoc } from "@/lib/legal";
import { PAGES, type PageKey } from "@/lib/site";
import { Breadcrumb } from "./Breadcrumb";
import { JsonLd } from "./JsonLd";

type LegalKey = Extract<PageKey, "terms" | "privacy">;

/** A paragraph with `{about}` rendered as a link to the contact form. */
function Paragraph({ text }: { text: string }) {
  const parts = text.split("{about}");
  return (
    <p>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {part}
          {index < parts.length - 1 ? <Link href={`${PAGES.about.path}#contact`}>เกี่ยวกับเรา</Link> : null}
        </Fragment>
      ))}
    </p>
  );
}

/**
 * Shared frame for /terms and /privacy (Website v2): eyebrow, title, intro,
 * date, numbered sections, then a link to the other document.
 */
export function LegalPage({ pageKey, title, doc }: { pageKey: LegalKey; title: string; doc: LegalDoc }) {
  const page = PAGES[pageKey];
  const other = PAGES[pageKey === "terms" ? "privacy" : "terms"];
  const otherLabel = pageKey === "terms" ? "อ่านนโยบายความเป็นส่วนตัว" : "อ่านเงื่อนไขการใช้งาน";
  const trail = [
    { name: PAGES.home.label, path: PAGES.home.path },
    { name: page.label, path: page.path },
  ];
  return (
    <main id="main" className="container page">
      <article className="legal">
        <Breadcrumb trail={trail} />
        <p className="eyebrow">เอกสาร</p>
        <h1 className="page-title legal__title">{title}</h1>
        <p className="legal__intro">{doc.intro}</p>
        <p className="legal__updated">
          อัปเดตล่าสุด <time dateTime={page.updated}>{formatThaiDate(page.updated)}</time>
        </p>
        {doc.sections.map((section, index) => (
          <section key={section.title} className="legal__section">
            <h2>
              <span className="num legal__n">{String(index + 1).padStart(2, "0")}</span>
              <span>{section.title}</span>
            </h2>
            {section.paragraphs.map((paragraph) => (
              <Paragraph key={paragraph} text={paragraph} />
            ))}
          </section>
        ))}
        <div className="legal__foot">
          <Link href={other.path}>{otherLabel}</Link>
          <Link href="/">กลับหน้าแรก</Link>
        </div>
      </article>
      <JsonLd
        data={jsonLdGraph(
          webPageNode({ path: page.path, name: page.title, description: page.description, dateModified: page.updated }),
          breadcrumbNode(trail),
        )}
      />
    </main>
  );
}
