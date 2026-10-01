import Link from "next/link";
import { Breadcrumb } from "@/components/Breadcrumb";
import { FaqList } from "@/components/FaqList";
import { JsonLd } from "@/components/JsonLd";
import { ClipCard } from "@/components/ds/ClipCard";
import { CtaBand } from "@/components/ds/CtaBand";
import { IconArrowLeft } from "@/components/ds/icons";
import { PageHero } from "@/components/ds/PageHero";
import { keepThaiProse } from "@/components/ds/ThaiProse";
import { TimelineToc, type TocItem } from "@/components/ds/TimelineToc";
import {
  BLOG_COPY,
  BLOG_FEED_PATH,
  BLOG_PATH,
  blogPostPath,
  categoryPath,
  guidesFor,
  tagPath,
  wasUpdated,
  type BlogPost,
} from "@/lib/blog";
import { articleParts } from "@/lib/blog-markdown";
import { BLOG_TRAIL, postJsonLd } from "@/lib/blog-seo";
import { formatThaiDate } from "@/lib/format";
import { GUIDE_DOCS, GUIDE_ORDER } from "@/lib/guide";
import { PAGES } from "@/lib/site";
import { mediaIndex, renderHast } from "./ArticleBody";
import { PostCard } from "./PostCard";
import { PostCover } from "./PostCover";
import "../../styles/pages/article.css";
import "../../styles/pages/blog.css";

/** A guide page's label and the note the guides already use for it ("อ่านต่อ"). */
function guideLink(path: string): { path: string; label: string; note: string } | null {
  const key = GUIDE_ORDER.find((candidate) => PAGES[candidate].path === path);
  if (!key) return null;
  const note = GUIDE_ORDER.flatMap((other) => GUIDE_DOCS[other].related).find((item) => item.path === path)?.note ?? PAGES[key].description;
  return { path, label: PAGES[key].label, note };
}

/**
 * One blog post, laid out like the guides (the same reading column, the
 * same timeline table of contents, the same FAQ cue list): the opening
 * answer under the title, the cover — or the post's slate — beside it, the
 * sections, then the FAQ, related posts and the guide pages for its
 * category, and the site's closing band with the call to try the product.
 */
export function BlogArticle({ post }: { post: BlogPost }) {
  const parts = articleParts(post.contentMd);
  const media = mediaIndex(post.media);
  const trail = [
    ...BLOG_TRAIL,
    { name: post.category.name, path: categoryPath(post.category.slug) },
    { name: post.title, path: blogPostPath(post.slug) },
  ];
  const guides = guidesFor(post.category.slug)
    .map(guideLink)
    .filter((item): item is NonNullable<typeof item> => item !== null);
  const updated = wasUpdated(post);

  const toc: TocItem[] = [
    ...parts.toc.map((entry) => ({ id: entry.id, label: keepThaiProse(entry.text), cue: entry.cue, depth: entry.depth })),
    ...(post.faq.length ? [{ id: "faq", label: BLOG_COPY.faqTitle, cue: "FAQ" }] : []),
    ...(post.related.length ? [{ id: "related", label: BLOG_COPY.relatedTitle, cue: "→" }] : []),
    ...(guides.length ? [{ id: "guides", label: BLOG_COPY.guideTitle, cue: "→" }] : []),
  ];

  return (
    <main id="main" className={["article-page blog-article", post.title.length > 90 ? "blog-article--long-title" : null].filter(Boolean).join(" ")}>
      <PageHero
        crumb={<Breadcrumb trail={trail} />}
        title={post.title}
        size={post.title.length > 48 ? "h-2" : "h-1"}
        lead={
          parts.answer ? (
            <p className="answer">{renderHast(parts.answer.children)}</p>
          ) : post.excerpt ? (
            <p className="answer">{keepThaiProse(post.excerpt)}</p>
          ) : null
        }
        aside={<PostCover post={post} variant="hero" sizes="(min-width: 961px) 520px, calc(100vw - 32px)" />}
        meta={
          <p className="stamp post-stamp">
            <span className="kt">{BLOG_COPY.by}</span>
            <span className="post-stamp__sep" aria-hidden="true">
              {" · "}
            </span>
            <span className="kt">
              {BLOG_COPY.published} <time dateTime={post.publishedAt}>{formatThaiDate(post.publishedAt)}</time>
            </span>
            {updated ? (
              <>
                <span className="post-stamp__sep" aria-hidden="true">
                  {" · "}
                </span>
                <span className="kt">
                  {BLOG_COPY.updated} <time dateTime={post.updatedAt}>{formatThaiDate(post.updatedAt)}</time>
                </span>
              </>
            ) : null}
            <span className="post-stamp__sep" aria-hidden="true">
              {" · "}
            </span>
            <span className="kt">{BLOG_COPY.readMinutes(post.readingMinutes)}</span>
          </p>
        }
      />

      <div className="wrap article-layout">
        <aside className="article-layout__toc">
          <TimelineToc items={toc} label={BLOG_COPY.tocLabel} />
        </aside>

        <article className="article blog-body">
          {parts.intro.length ? (
            <div className="article__section blog-intro">
              <div className="prose blog-prose">{renderHast(parts.intro, media)}</div>
            </div>
          ) : null}

          {parts.sections.map((section) => (
            <section key={section.id} id={section.id} className="article__section" aria-labelledby={`${section.id}-title`}>
              <div className="article__cue" aria-hidden="true">
                <span className="trk tc">{section.cue}</span>
              </div>
              <h2 id={`${section.id}-title`} className="article__h2">
                {renderHast(section.heading.children)}
              </h2>
              <div className="prose blog-prose">{renderHast(section.children, media)}</div>
            </section>
          ))}

          {post.tags.length ? (
            <div className="blog-tags">
              <span className="blog-tags__label">{BLOG_COPY.tagsLabel}</span>
              <ul className="blog-tags__list">
                {post.tags.map((tag) => (
                  <li key={tag.slug}>
                    <Link href={tagPath(tag.slug)} className="blog-tag" prefetch={false}>
                      {tag.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {post.faq.length ? (
            <section id="faq" className="article__section" aria-labelledby="faq-title">
              <div className="article__cue" aria-hidden="true">
                <span className="trk tc">FAQ</span>
              </div>
              <h2 id="faq-title" className="article__h2">
                {BLOG_COPY.faqTitle}
              </h2>
              <FaqList items={post.faq} compact />
            </section>
          ) : null}

          {post.related.length ? (
            <section id="related" className="article__section" aria-labelledby="related-title">
              <div className="article__cue" aria-hidden="true">
                <span className="trk tc">→</span>
              </div>
              <h2 id="related-title" className="article__h2">
                {BLOG_COPY.relatedTitle}
              </h2>
              <ul className="blog-related">
                {post.related.map((item) => (
                  <li key={item.slug}>
                    <PostCard post={item} titleAs="h3" sizes="(min-width: 960px) 320px, calc(100vw - 32px)" />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {guides.length ? (
            <section id="guides" className="article__section" aria-labelledby="guides-title">
              <div className="article__cue" aria-hidden="true">
                <span className="trk tc">→</span>
              </div>
              <h2 id="guides-title" className="article__h2">
                {BLOG_COPY.guideTitle}
              </h2>
              <ul className="link-grid article__related">
                {guides.map((guide, index) => (
                  <li key={guide.path}>
                    <ClipCard title={guide.label} titleAs="h3" href={guide.path} seed={index + 11}>
                      <p>{keepThaiProse(guide.note)}</p>
                    </ClipCard>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <div className="article__foot">
            <Link href={BLOG_PATH} className="btn btn-secondary">
              <IconArrowLeft size={16} />
              {BLOG_COPY.backToBlog}
            </Link>
            <a href={BLOG_FEED_PATH} className="more-link blog-article__feed">
              {BLOG_COPY.feedLink}
            </a>
          </div>
        </article>
      </div>

      {/* "ลองใช้ Noey Studio": the site's closing band (as on the listings, /pricing and
          /scope), with the site's own sign-up lines and the two pages to read first. */}
      <CtaBand
        id="blog-cta-title"
        compact
        title={BLOG_COPY.ctaTitle}
        actions={
          <>
            <Link href={PAGES.signup.path} className="btn btn-primary btn-lg" data-magnetic="" prefetch={false}>
              {BLOG_COPY.ctaButton}
            </Link>
            <Link href={PAGES.scope.path} className="btn btn-secondary btn-lg" prefetch={false}>
              {BLOG_COPY.ctaScope}
            </Link>
            <Link href={PAGES.pricing.path} className="btn btn-secondary btn-lg" prefetch={false}>
              {BLOG_COPY.ctaPricing}
            </Link>
          </>
        }
      >
        <p>{keepThaiProse(BLOG_COPY.ctaText)}</p>
      </CtaBand>
      <JsonLd data={postJsonLd(post, trail)} />
    </main>
  );
}
