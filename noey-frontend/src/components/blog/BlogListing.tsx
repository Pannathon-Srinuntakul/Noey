import Link from "next/link";
import type { ReactNode } from "react";
import { Breadcrumb } from "@/components/Breadcrumb";
import { JsonLd } from "@/components/JsonLd";
import { CtaBand } from "@/components/ds/CtaBand";
import { PageHero } from "@/components/ds/PageHero";
import { keepThaiProse } from "@/components/ds/ThaiProse";
import { BLOG_COPY, BLOG_FEED_PATH, BLOG_PER_PAGE, pageCount, type BlogCategory, type BlogListPage } from "@/lib/blog";
import { listingJsonLd } from "@/lib/blog-seo";
import { formatThaiDate } from "@/lib/format";
import type { Crumb } from "@/lib/jsonld";
import { PAGES } from "@/lib/site";
import { BlogEmpty } from "./BlogEmpty";
import { BlogUnavailable } from "./BlogUnavailable";
import { CategoryRail, trackLabels } from "./CategoryRail";
import { Pagination } from "./Pagination";
import { PostCard } from "./PostCard";
import "../../styles/pages/blog.css";

/**
 * One layout for every listing — /blog, a category, a tag: the hero, the
 * category tracks, the newest post on the program monitor (first page only),
 * the rest as clips in the bin, the transport to the next page, the feed,
 * and the closing scene. `list === null` only happens in a build the API
 * missed: the page then says it could not load, and ISR replaces it.
 */
export function BlogListing({
  kind,
  path,
  page,
  title,
  lead,
  trail,
  list,
  categories,
  current,
  jsonLdName,
  jsonLdDescription,
}: {
  kind: "all" | "category" | "tag";
  path: string;
  page: number;
  title: string;
  lead: ReactNode;
  trail: readonly Crumb[];
  list: BlogListPage | null;
  categories: readonly BlogCategory[] | null;
  /** The category being viewed (null on /blog, undefined on a tag page). */
  current: string | null | undefined;
  jsonLdName: string;
  jsonLdDescription: string;
}) {
  const items = list?.items ?? [];
  const last = list ? pageCount(list.total, list.perPage || BLOG_PER_PAGE) : 1;
  const tracks = trackLabels(categories ?? []);
  const featured = page === 1 && items.length >= 2 ? items[0] : null;
  const rest = featured ? items.slice(1) : items;
  const newest = items.reduce((latest, post) => (post.updatedAt > latest ? post.updatedAt : latest), "");
  const allTotal = categories ? categories.reduce((sum, category) => sum + category.postCount, 0) : null;

  return (
    <main id="main" className="blog-page">
      <PageHero
        crumb={<Breadcrumb trail={trail} />}
        title={title}
        size={title.length > 34 ? "h-2" : "h-1"}
        lead={lead}
        meta={
          list && list.total > 0 ? (
            <p className="stamp">
              {BLOG_COPY.postsCount(list.total)}
              {newest ? (
                <>
                  <span className="stamp__sep">{" · "}</span>
                  <span className="kt stamp__more">
                    {BLOG_COPY.updated} <time dateTime={newest}>{formatThaiDate(newest)}</time>
                  </span>
                </>
              ) : null}
            </p>
          ) : null
        }
      />

      <div className="wrap blog-list">
        {categories ? <CategoryRail categories={categories} current={current} total={kind === "all" && list ? list.total : allTotal} /> : null}

        {list === null ? (
          <BlogUnavailable
            retry={
              <Link href={path} className="btn btn-primary" prefetch={false}>
                {BLOG_COPY.retry}
              </Link>
            }
          />
        ) : items.length === 0 ? (
          <BlogEmpty filtered={kind !== "all"} />
        ) : (
          <>
            {featured ? (
              <div className="blog-monitor">
                <div className="blog-monitor__bar" aria-hidden="true">
                  <span className="blog-monitor__rec" />
                  <span className="tc">PROGRAM</span>
                  <span className="blog-monitor__rule" />
                  <span className="tc">LATEST</span>
                </div>
                <PostCard post={featured} track={tracks.get(featured.category.slug)} variant="feature" />
              </div>
            ) : null}
            {rest.length ? (
              <>
                <div className="blog-bin__bar" aria-hidden="true">
                  <span className="trk tc">BIN</span>
                  <span className="tc blog-bin__count">
                    {String(rest.length).padStart(2, "0")} CLIPS · {String(page).padStart(2, "0")}/{String(last).padStart(2, "0")}
                  </span>
                  <span className="blog-bin__rule" />
                </div>
                <ul className="blog-grid" data-reveal="stagger">
                  {rest.map((post) => (
                    <li key={post.slug}>
                      <PostCard post={post} track={tracks.get(post.category.slug)} />
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            <Pagination path={path} page={page} last={last} />
          </>
        )}

        <p className="blog-feed">
          <a href={BLOG_FEED_PATH}>{BLOG_COPY.feedLink}</a>
          <span aria-hidden="true">{" · "}</span>
          <Link href={PAGES.guide.path} prefetch={false}>
            {keepThaiProse(PAGES.guide.label)}
          </Link>
        </p>
      </div>

      <CtaBand
        id="blog-cta-title"
        compact
        title="ลองตัดคลิปแรกวันนี้"
        actions={
          <Link href="/signup" className="btn btn-primary btn-lg" data-magnetic="">
            {BLOG_COPY.ctaButton}
          </Link>
        }
      >
        <p>{keepThaiProse(BLOG_COPY.ctaText)}</p>
      </CtaBand>

      <JsonLd
        data={listingJsonLd({
          path,
          page,
          name: jsonLdName,
          description: jsonLdDescription,
          posts: items,
          trail,
          isBlogIndex: kind === "all",
        })}
      />
    </main>
  );
}
