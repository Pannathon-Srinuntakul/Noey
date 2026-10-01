import Link from "next/link";
import { BLOG_COPY, BLOG_PATH, categoryPath, type BlogCategory } from "@/lib/blog";

/** A category's track label: its place in the backend's fixed order (V1, V2 …). */
export function trackLabels(categories: readonly BlogCategory[]): Map<string, string> {
  return new Map(categories.map((category, index) => [category.slug, `V${index + 1}`]));
}

/**
 * The category filter, drawn as the editor's track headers: one per
 * category that has posts (plus the one being viewed), each with its track
 * label and count. Real links to real pages (/blog/category/<slug>), not a
 * filter in the browser — so each category is a page search engines can
 * index. Scrolls sideways on a phone.
 */
export function CategoryRail({
  categories,
  current,
  total,
}: {
  categories: readonly BlogCategory[];
  /** The category being viewed; null on /blog itself, undefined on a tag page (none current). */
  current: string | null | undefined;
  total: number | null;
}) {
  const tracks = trackLabels(categories);
  const shown = categories.filter((category) => category.postCount > 0 || category.slug === current);
  // No post anywhere yet: nothing to filter.
  if (!shown.length) return null;
  return (
    <nav className="cat-rail" aria-label={BLOG_COPY.filterLabel}>
      <ul className="cat-rail__list">
        <li>
          <Link href={BLOG_PATH} className="cat-rail__link" aria-current={current === null ? "page" : undefined} prefetch={false}>
            <span className="trk tc" aria-hidden="true">
              ALL
            </span>
            <span className="cat-rail__name">{BLOG_COPY.allPosts}</span>
            {total !== null ? <span className="cat-rail__count tc">{total}</span> : null}
          </Link>
        </li>
        {shown.map((category) => (
          <li key={category.slug}>
            <Link
              href={categoryPath(category.slug)}
              className="cat-rail__link"
              aria-current={current === category.slug ? "page" : undefined}
              prefetch={false}
            >
              <span className="trk tc" aria-hidden="true">
                {tracks.get(category.slug)}
              </span>
              <span className="cat-rail__name">{category.name}</span>
              <span className="cat-rail__count tc">{category.postCount}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
