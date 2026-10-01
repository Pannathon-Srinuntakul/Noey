import "server-only";
import DATA from "./__fixtures__/blog.json";

/**
 * The public blog API answered from __fixtures__/blog.json, for development
 * and tests while the backend is not running (BLOG_FIXTURES=1). It answers in
 * the API's own shape (BLOG_CONTRACT.md) so the same mapping code runs on it.
 * lib/server/blog.ts only loads this module outside production.
 */

type Raw = (typeof DATA.posts)[number];
type Answer = { status: number; body: unknown };

const SUMMARY_DROPS = ["content_md", "faq", "related"] as const;

function summary(post: Raw) {
  const copy: Record<string, unknown> = { ...post };
  for (const key of SUMMARY_DROPS) delete copy[key];
  return copy;
}

/** ≤ 3 published posts sharing tags (weighted) or the category — the backend's rule. */
function related(post: Raw, posts: readonly Raw[]) {
  const tags = new Set(post.tags.map((tag) => tag.slug));
  return posts
    .filter((other) => other.slug !== post.slug)
    .map((other) => ({
      other,
      score: other.tags.filter((tag) => tags.has(tag.slug)).length * 2 + (other.category.slug === post.category.slug ? 1 : 0),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.other.published_at.localeCompare(a.other.published_at))
    .slice(0, 3)
    .map(({ other }) => ({
      slug: other.slug,
      title: other.title,
      excerpt: other.excerpt,
      cover_image_url: other.cover_image_url,
      cover_alt: other.cover_alt,
      category: other.category,
      published_at: other.published_at,
    }));
}

export function blogFixtureApi(empty: boolean) {
  const posts = (empty ? [] : [...DATA.posts]).sort((a, b) => b.published_at.localeCompare(a.published_at));
  return {
    list({ page = 1, perPage = 12, category, tag }: { page?: number; perPage?: number; category?: string; tag?: string }): Answer {
      const matching = posts.filter(
        (post) => (!category || post.category.slug === category) && (!tag || post.tags.some((item) => item.slug === tag)),
      );
      const items = matching.slice((page - 1) * perPage, page * perPage).map(summary);
      return { status: 200, body: { items, page, per_page: perPage, total: matching.length } };
    },
    post(slug: string): Answer {
      const post = posts.find((item) => item.slug === slug);
      return post ? { status: 200, body: { ...post, related: related(post, posts) } } : { status: 404, body: { detail: "not found" } };
    },
    slugs(): Answer {
      return { status: 200, body: posts.map((post) => ({ slug: post.slug, updated_at: post.updated_at })) };
    },
    categories(): Answer {
      return {
        status: 200,
        body: DATA.categories.map((category) => ({
          ...category,
          post_count: posts.filter((post) => post.category.slug === category.slug).length,
        })),
      };
    },
    tags(): Answer {
      const counts = new Map<string, { slug: string; name: string; post_count: number }>();
      for (const post of posts) {
        for (const tag of post.tags) {
          const entry = counts.get(tag.slug) ?? { ...tag, post_count: 0 };
          entry.post_count += 1;
          counts.set(tag.slug, entry);
        }
      }
      return { status: 200, body: [...counts.values()].sort((a, b) => b.post_count - a.post_count || a.slug.localeCompare(b.slug)) };
    },
  };
}
