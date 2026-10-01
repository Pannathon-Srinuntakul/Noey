import Link from "next/link";
import { IconArrowLeft, IconArrowRight } from "@/components/ds/icons";
import { BLOG_COPY, withPage } from "@/lib/blog";

/** Page numbers to show: the first, the last, and the current one with its neighbours; gaps as null. */
export function pageWindow(current: number, last: number): (number | null)[] {
  const wanted = new Set([1, last, current - 1, current, current + 1].filter((n) => n >= 1 && n <= last));
  const sorted = [...wanted].sort((a, b) => a - b);
  const out: (number | null)[] = [];
  sorted.forEach((n, index) => {
    if (index > 0 && n - sorted[index - 1] > 1) out.push(null);
    out.push(n);
  });
  return out;
}

/**
 * Listing pages as the editor's transport: back, the pages as numbered
 * marks on a ruler, forward. Plain links to `?page=N` (server-rendered; the
 * same pairs are in <head> as rel=prev/next).
 */
export function Pagination({ path, page, last }: { path: string; page: number; last: number }) {
  if (last <= 1) return null;
  return (
    <nav className="pager" aria-label={BLOG_COPY.pagination}>
      {page > 1 ? (
        <Link href={withPage(path, page - 1)} rel="prev" className="btn btn-secondary btn-sm pager__step" prefetch={false}>
          <IconArrowLeft size={16} />
          {BLOG_COPY.previous}
        </Link>
      ) : (
        <span className="btn btn-secondary btn-sm pager__step" aria-disabled="true">
          <IconArrowLeft size={16} />
          {BLOG_COPY.previous}
        </span>
      )}
      <ol className="pager__marks">
        {pageWindow(page, last).map((n, index) =>
          n === null ? (
            <li key={`gap-${index}`} className="pager__gap" aria-hidden="true">
              …
            </li>
          ) : (
            <li key={n}>
              <Link
                href={withPage(path, n)}
                className="pager__mark tc"
                aria-current={n === page ? "page" : undefined}
                aria-label={BLOG_COPY.page(n)}
                prefetch={false}
              >
                {String(n).padStart(2, "0")}
              </Link>
            </li>
          ),
        )}
      </ol>
      {page < last ? (
        <Link href={withPage(path, page + 1)} rel="next" className="btn btn-secondary btn-sm pager__step" prefetch={false}>
          {BLOG_COPY.next}
          <IconArrowRight size={16} />
        </Link>
      ) : (
        <span className="btn btn-secondary btn-sm pager__step" aria-disabled="true">
          {BLOG_COPY.next}
          <IconArrowRight size={16} />
        </span>
      )}
    </nav>
  );
}
