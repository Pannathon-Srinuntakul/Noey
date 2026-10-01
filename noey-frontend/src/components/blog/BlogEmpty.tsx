import Link from "next/link";
import { IconArrowRight, IconBook } from "@/components/ds/icons";
import { keepThaiProse } from "@/components/ds/ThaiProse";
import { BLOG_COPY, BLOG_PATH } from "@/lib/blog";
import { PAGES } from "@/lib/site";

/**
 * No posts (yet, or in this category): an empty track in the editor — the
 * ruler and the playhead parked at zero over a hatched lane waiting for its
 * first clip — then where to read meanwhile. Never a bare "no results".
 */
export function BlogEmpty({ filtered }: { filtered: boolean }) {
  return (
    <section className="blog-empty" aria-labelledby="blog-empty-title">
      <div className="blog-empty__stage" aria-hidden="true">
        <span className="blog-empty__ruler" />
        <span className="blog-empty__lane">
          <span className="trk tc">V1</span>
          <span className="blog-empty__well">
            <span className="tc">00:00:00:00</span>
          </span>
        </span>
        <span className="blog-empty__lane blog-empty__lane--audio">
          <span className="trk tc">A1</span>
          <span className="blog-empty__well" />
        </span>
        <span className="blog-empty__head" />
      </div>
      <div className="blog-empty__copy">
        <h2 id="blog-empty-title" className="h-3">
          {BLOG_COPY.emptyTitle}
        </h2>
        <p>{keepThaiProse(filtered ? BLOG_COPY.emptyFiltered : BLOG_COPY.emptyAll)}</p>
        <div className="cta-row">
          <Link href={PAGES.guide.path} className="btn btn-primary" data-magnetic="">
            <IconBook size={16} />
            {BLOG_COPY.toGuide}
          </Link>
          {filtered ? (
            <Link href={BLOG_PATH} className="btn btn-secondary">
              {BLOG_COPY.toAll}
              <IconArrowRight size={16} />
            </Link>
          ) : null}
        </div>
      </div>
    </section>
  );
}
