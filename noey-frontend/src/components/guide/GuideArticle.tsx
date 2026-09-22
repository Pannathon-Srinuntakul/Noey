import Link from "next/link";
import type { ReactNode } from "react";
import { Breadcrumb } from "@/components/Breadcrumb";
import { FaqList } from "@/components/FaqList";
import { JsonLd } from "@/components/JsonLd";
import { formatThaiDate } from "@/lib/format";
import type { GuideDoc } from "@/lib/guide";
import { articleNode, breadcrumbNode, faqPageNode, jsonLdGraph, webPageNode } from "@/lib/jsonld";
import { CONTENT_AUTHOR } from "@/lib/seo";
import { PAGES, publishedDate } from "@/lib/site";

/**
 * Shared frame for every /guide page.
 *
 * The order is the point: breadcrumb, question as H1, the self-contained
 * answer, the date, then the detail. An agent that reads only the first two
 * blocks still leaves with a correct, quotable answer.
 *
 * `extras` lets a page drop extra markup (the help page's plan table) under a
 * named section without forking this component.
 */
export function GuideArticle({ doc, extras }: { doc: GuideDoc; extras?: Record<string, ReactNode> }) {
  const page = PAGES[doc.key];
  const published = publishedDate(doc.key);
  const trail = [
    { name: PAGES.home.label, path: PAGES.home.path },
    { name: PAGES.guide.label, path: PAGES.guide.path },
    { name: page.label, path: page.path },
  ];

  const jsonLd = jsonLdGraph(
    webPageNode({ path: page.path, name: page.title, description: page.description, dateModified: page.updated }),
    articleNode({
      path: page.path,
      headline: doc.h1,
      description: page.description,
      datePublished: published,
      dateModified: page.updated,
      abstract: doc.answer,
      author: CONTENT_AUTHOR,
    }),
    faqPageNode(doc.faq, page.path),
    breadcrumbNode(trail),
  );

  return (
    <main id="main" className="container page">
      <article className="legal guide">
        <Breadcrumb trail={trail} />
        <h1 className="page-title legal__title">{doc.h1}</h1>
        {/* Answer-first: 40–60 words that stand on their own. */}
        <p className="legal__intro guide__answer">{doc.answer}</p>
        <p className="legal__updated">
          อัปเดตล่าสุด <time dateTime={page.updated}>{formatThaiDate(page.updated)}</time> · เขียนโดย {CONTENT_AUTHOR}
        </p>

        {doc.sections.map((section) => (
          <section key={section.id} id={section.id} className="legal__section" aria-labelledby={`${section.id}-heading`}>
            <h2 id={`${section.id}-heading`}>{section.title}</h2>
            {section.paragraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
            {section.bullets ? (
              <ul className="guide__list">
                {section.bullets.map((bullet) => (
                  <li key={bullet}>{bullet}</li>
                ))}
              </ul>
            ) : null}
            {extras?.[section.id] ?? null}
          </section>
        ))}

        <section id="faq" className="legal__section" aria-labelledby={`${doc.key}-faq`}>
          <h2 id={`${doc.key}-faq`}>คำถามที่พบบ่อย (FAQ)</h2>
          <FaqList items={doc.faq} compact />
        </section>

        <section id="related" className="legal__section" aria-labelledby={`${doc.key}-related`}>
          <h2 id={`${doc.key}-related`}>อ่านต่อ</h2>
          <ul className="guide__list guide__related">
            {doc.related.map((item) => (
              <li key={item.path}>
                <Link href={item.path}>{item.label}</Link> — {item.note}
              </li>
            ))}
          </ul>
        </section>

        <div className="legal__foot">
          <Link href={PAGES.guide.path}>กลับไปหน้าคู่มือทั้งหมด</Link>
          <Link href={PAGES.signup.path}>ทดลองใช้ฟรี</Link>
        </div>
      </article>
      <JsonLd data={jsonLd} />
    </main>
  );
}
