import Link from "next/link";
import type { ReactNode } from "react";
import { Breadcrumb } from "@/components/Breadcrumb";
import { FaqList } from "@/components/FaqList";
import { JsonLd } from "@/components/JsonLd";
import { ClipCard } from "@/components/ds/ClipCard";
import { IconArrowLeft, IconArrowRight } from "@/components/ds/icons";
import { PageHero } from "@/components/ds/PageHero";
import { TimelineToc } from "@/components/ds/TimelineToc";
import { FeatureVisual, MicroDemo } from "@/components/mockups/client";
import { UsageMockup } from "@/components/mockups/UsageMockup";
import { formatThaiDate } from "@/lib/format";
import type { GuideDoc } from "@/lib/guide";
import { articleNode, breadcrumbNode, faqPageNode, jsonLdGraph, webPageNode } from "@/lib/jsonld";
import { CONTENT_AUTHOR } from "@/lib/seo";
import { PAGES, publishedDate } from "@/lib/site";
import "../../styles/pages/article.css";
import { keepThaiProse } from "@/components/ds/ThaiProse";

/**
 * A bullet like "ตัดช่วงเงียบ — …" or "ทำให้: …" reads as a term and its
 * explanation; the term is set in bold. The text itself is unchanged.
 */
function Bullet({ text }: { text: string }) {
  const dash = text.indexOf(" — ");
  const colon = text.indexOf(": ");
  const at = dash > 0 ? dash : colon > 0 && colon < 24 ? colon : -1;
  if (at < 0) return <>{keepThaiProse(text)}</>;
  const cut = dash > 0 ? at : at + 1;
  return (
    <>
      <strong>{keepThaiProse(text.slice(0, cut))}</strong>
      {keepThaiProse(text.slice(cut))}
    </>
  );
}

/**
 * The part of the editor each guide is about, drawn as the home page draws
 * it (the app's own screens, labelled as a picture): the timeline after the
 * first cut, the caption lane, a scene swapped for its backup shot, a scene
 * being trimmed, the whole editor in a browser tab, the quota card.
 */
const VISUALS: Record<GuideDoc["key"], { node: ReactNode; label: string; shape: "wide" | "strip" | "card" }> = {
  guideCut: { node: <FeatureVisual index={0} />, label: "ไทม์ไลน์หลังระบบตัดดราฟต์แรก", shape: "wide" },
  guideSubtitles: { node: <MicroDemo kind="subs" />, label: "เลนคำบรรยายไทยในไทม์ไลน์", shape: "strip" },
  guideReview: { node: <MicroDemo kind="swap" />, label: "สลับฉากเป็นช็อตสำรอง", shape: "strip" },
  guideLongform: { node: <MicroDemo kind="trim" />, label: "ยืดหดความยาวฉากในไทม์ไลน์", shape: "strip" },
  guideChoose: { node: <FeatureVisual index={2} />, label: "ห้องตัดต่อบนเว็บ", shape: "card" },
  guideHelp: { node: <UsageMockup />, label: "การ์ดโควตาในหน้าตั้งค่า", shape: "card" },
};

/**
 * Shared frame for every /guide page.
 *
 * The order is the point: breadcrumb, question as H1, the self-contained
 * answer, the date, then the detail. An agent that reads only the first two
 * blocks still leaves with a correct, quotable answer.
 *
 * Layout: a sticky table of contents drawn as a vertical timeline (one cue
 * per heading, a playhead at your reading position) beside the article; on
 * phones the contents fold into a list above it.
 *
 * `extras` lets a page drop extra markup (the help page's plan table) under a
 * named section without forking this component.
 */
export function GuideArticle({ doc, extras }: { doc: GuideDoc; extras?: Record<string, ReactNode> }) {
  const page = PAGES[doc.key];
  const visual = VISUALS[doc.key];
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

  const toc = [
    ...doc.sections.map((section) => ({ id: section.id, label: keepThaiProse(section.title) })),
    { id: "faq", label: "คำถามที่พบบ่อย (FAQ)", cue: "FAQ" },
    { id: "related", label: "อ่านต่อ", cue: "→" },
  ];

  return (
    <main id="main" className="article-page">
      <PageHero
        crumb={<Breadcrumb trail={trail} />}
        title={doc.h1}
        size="h-1"
        lead={
          // Answer-first: 40–60 words that stand on their own.
          <p className="answer">{keepThaiProse(doc.answer)}</p>
        }
        aside={
          <figure className={`guide-visual guide-visual--${visual.shape}`} aria-label={`ภาพจำลอง · ${visual.label}`}>
            <div className="guide-visual__frame">{visual.node}</div>
            <figcaption className="guide-visual__tag mock-tag">ภาพจำลอง · {visual.label}</figcaption>
          </figure>
        }
        meta={
          <p className="stamp">
            อัปเดตล่าสุด <time dateTime={page.updated}>{formatThaiDate(page.updated)}</time>
            <span className="stamp__sep">{"\u00a0· "}</span>
            <span className="kt stamp__more">เขียนโดย {CONTENT_AUTHOR}</span>
          </p>
        }
      />

      <div className="wrap article-layout">
        <aside className="article-layout__toc">
          <TimelineToc items={toc} label="หัวข้อในหน้านี้" />
        </aside>

        <article className="article">
          {doc.sections.map((section, index) => (
            <section key={section.id} id={section.id} className="article__section" aria-labelledby={`${section.id}-heading`}>
              <div className="article__cue" aria-hidden="true">
                <span className="trk tc">{String(index + 1).padStart(2, "0")}</span>
              </div>
              <h2 id={`${section.id}-heading`} className="article__h2">
                {keepThaiProse(section.title)}
              </h2>
              <div className="prose">
                {section.paragraphs.map((paragraph) => (
                  <p key={paragraph}>{keepThaiProse(paragraph)}</p>
                ))}
                {section.bullets ? (
                  <ul className="article__bullets">
                    {section.bullets.map((bullet) => (
                      // What the system does not do yet gets a hollow marker, not the gold one.
                      <li key={bullet} data-kind={/^(ยัง(ทำ)?ไม่|ไม่)/.test(bullet) ? "no" : undefined}>
                        <Bullet text={bullet} />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
              {extras?.[section.id] ? <div className="article__extra">{extras[section.id]}</div> : null}
            </section>
          ))}

          <section id="faq" className="article__section" aria-labelledby={`${doc.key}-faq`}>
            <div className="article__cue" aria-hidden="true">
              <span className="trk tc">FAQ</span>
            </div>
            <h2 id={`${doc.key}-faq`} className="article__h2">
              คำถามที่พบบ่อย (FAQ)
            </h2>
            <FaqList items={doc.faq} compact />
          </section>

          <section id="related" className="article__section" aria-labelledby={`${doc.key}-related`}>
            <div className="article__cue" aria-hidden="true">
              <span className="trk tc">→</span>
            </div>
            <h2 id={`${doc.key}-related`} className="article__h2">
              อ่านต่อ
            </h2>
            <ul className="link-grid article__related">
              {doc.related.map((item, index) => (
                <li key={item.path}>
                  <ClipCard title={item.label} titleAs="h3" href={item.path} seed={index + 5}>
                    <p>{keepThaiProse(item.note)}</p>
                  </ClipCard>
                </li>
              ))}
            </ul>
          </section>

          <div className="article__foot">
            <Link href={PAGES.guide.path} className="btn btn-secondary">
              <IconArrowLeft size={16} />
              กลับไปหน้าคู่มือทั้งหมด
            </Link>
            <Link href={PAGES.signup.path} className="btn btn-primary" data-magnetic="">
              ทดลองใช้ฟรี
              <IconArrowRight size={16} />
            </Link>
          </div>
        </article>
      </div>
      <JsonLd data={jsonLd} />
    </main>
  );
}
