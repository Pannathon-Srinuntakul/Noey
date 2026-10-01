# Blog — shared contract (MCP side ⇄ Blog pages side)

Both Claude Code sessions build against THIS file. Neither side changes it alone;
if a change is unavoidable, write it here first under "Changes" with a date, so the
other side picks it up.

## Ownership
- **MCP side** (`BLOG_MCP_PROMPT.md`): database, backend API (`backend/`), MCP server,
  OAuth, image storage, rate limits, audit log, owner moderation UI in `admin/`.
- **Blog pages side** (`BLOG_PAGES_PROMPT.md`): everything in `noey-frontend/` —
  `/blog`, `/blog/[slug]`, sitemap, feed, llms.txt, robots, revalidation route.

## Post object (JSON, as the public API returns it)
```json
{
  "slug": "thai-subtitles-tiktok-tips",          // unique, a-z0-9-, ≤ 80 chars, never changes after first publish
  "title": "string",
  "meta_title": "string ≤ 60 chars",
  "meta_description": "string ≤ 160 chars",
  "excerpt": "string ≤ 300 chars",
  "content_md": "GitHub-flavoured Markdown; headings start at ##; no raw HTML; images are absolute https URLs from BLOG_MEDIA_PUBLIC_URL",
  "cover_image_url": "https://… | null",
  "cover_alt": "string | null",
  "cover_width": 1600, "cover_height": 900,       // null when no cover
  "category": { "slug": "editing-tips", "name": "เทคนิคตัดต่อ" },
  "tags": [{ "slug": "subtitles", "name": "ซับไทย" }],
  "faq": [{ "question": "string", "answer": "plain text" }],
  "author": "Noey Studio",
  "source": "ai" | "human",
  "reading_minutes": 6,
  "published_at": "ISO-8601 UTC",
  "updated_at": "ISO-8601 UTC",
  "related": [ { "slug", "title", "excerpt", "cover_image_url", "cover_alt", "category", "published_at" } ]   // ≤ 3, only on GET one
}
```
`status`, `created_at` and `source` internals exist in the DB but the PUBLIC API only
ever returns `status = published` posts.

## Public read API (FastAPI, no auth, cacheable)
- `GET /blog/posts?page=1&per_page=12&category=<slug>&tag=<slug>` →
  `{ "items": [Post without content_md/faq/related], "page", "per_page", "total" }`, newest `published_at` first
- `GET /blog/posts/{slug}` → `Post` (with `content_md`, `faq`, `related`) · 404 when not published
- `GET /blog/slugs` → `[{ "slug", "updated_at" }]` all published (for sitemap / static params)
- `GET /blog/categories` → `[{ "slug", "name", "description", "post_count" }]`
- `GET /blog/tags` → `[{ "slug", "name", "post_count" }]` (only tags with ≥ 1 published post)
- Responses carry `Cache-Control: public, max-age=60`.

## Revalidation (backend → site)
After publish / unpublish / update of a published post, the backend calls
`POST {SITE_URL}/api/revalidate-blog` with `Authorization: Bearer $BLOG_REVALIDATE_SECRET`
and body `{ "slugs": ["…"] }`. The site revalidates `/blog`, `/blog/<slug>` (+ `.md` twin),
category/tag listing pages, `/sitemap.xml`, `/feed.xml`, `/llms.txt`. Fire-and-forget with
3 retries; a failure is logged, never blocks the publish (ISR catches up within 10 min).

## Env vars (names fixed)
- backend: `BLOG_REVALIDATE_URL`, `BLOG_REVALIDATE_SECRET`, `BLOG_MEDIA_PUBLIC_URL`,
  `BLOG_MAX_PUBLISH_PER_DAY` (default 2), `BLOG_AUTO_PUBLISH` (default true)
- noey-frontend: `BLOG_REVALIDATE_SECRET` (same value), existing `API_URL`

## Changes

### 2026-10-01 — blog pages side: one optional site env var
- **noey-frontend gains an OPTIONAL `BLOG_MEDIA_PUBLIC_URL`** — the same name and the same
  value as the backend's effective media base (backend default when unset:
  `<API_PUBLIC_URL>/blog/media`, i.e. `https://api.noeystudio.com/blog/media` in production,
  which is also the site's default, so production needs nothing set).
- The site reads it at BUILD time (`next.config.ts`): `next/image` `remotePatterns` allows
  exactly that origin + path prefix, https only, no query string. Only when the base is NOT
  https (a local test backend such as `http://localhost:8010/blog/media`) does CSP `img-src`
  gain exactly that one origin; https images are already allowed by `img-src https:`.
  Nothing else is loosened.
- Images outside that base are still shown (CSP allows https) but are not optimised;
  non-https images outside it are dropped. The backend side needs no change.

### 2026-10-01 — blog pages side: what the real API does (tested end to end; no change asked)
Found while building the pages against `feature/blog-mcp` (local, scratch DB). None of
these breaks the contract; the site handles each as written here.
- `GET /blog/posts?category=<unknown>` (or `tag=`) answers 200 with an empty list, not
  404. The site checks a slug against `/blog/categories` / `/blog/tags` before rendering
  a listing: an unknown category or a tag with no published post is a 404 on the site.
- `per_page` is capped at 50 and `page` at 10 000 (422 above); the site asks 12 per page
  and at most 50 for feeds and llms.txt.
- `related` items carry no `cover_width/height` and no `reading_minutes` (exactly the
  contract's field list): the site draws related covers in a fixed 16:9 frame.
- Images inside `content_md` carry no size. The site reads the size from the first bytes
  of the file — only for files under the media base — so the page reserves the space.
- With `BLOG_MEDIA_PUBLIC_URL` unset the backend serves images at
  `<API_PUBLIC_URL>/blog/media/<sha256>.webp` (the site's default media base too).
- The revalidation body names only the post's slugs. When an edit moves a post to another
  category or changes its tags, the old listings are not named, so the site expires every
  blog listing (tag `blog` + the listing routes) on every call.
- Unpublish sets `updated_at`; a post published again keeps its first `published_at`
  and gets a new `updated_at`, so the site shows "อัปเดตล่าสุด" on it.
- Revalidation is skipped (logged) when the backend has no `BLOG_REVALIDATE_SECRET`; the
  site then catches up through ISR (10 min listings, 1 h posts; the site's root layout
  re-reads prices every 10 min, so in practice every blog page is re-checked every 10 min).

### 2026-10-02 — both sides: pictures in posts (BLOG_MEDIA_PROMPT.md)
- **`GET /blog/posts/{slug}` gains `media`**: the body's pictures in reading order, each one
  only once, with what a page needs to draw it without layout shift:
  ```json
  [
    { "type": "visual", "id": "<32 hex>", "src": "https://embed.noeystudio.com/visual/<id>",
      "width": 1600, "height": 1000, "alt": "string", "caption": "string | null", "animated": true },
    { "type": "image", "url": "<media base>/<sha256>.webp", "alt": "string", "width": 2400, "height": 1200 },
    { "type": "video", "url": "<media base>/<sha256>.mp4", "poster_url": "<media base>/<sha256>.webp",
      "alt": "string", "width": 1280, "height": 720, "duration_sec": 5.4 }
  ]
  ```
  `width`/`height` of a visual are its designed canvas (aspect ratio only). Listings and
  `related` do not carry `media`. The site builds a visual's URL itself from `id` and its own
  `BLOG_EMBED_PUBLIC_URL`; `src` is informational.
- **`content_md` may now hold**: a line `::visual[alt](<id>)` alone in its paragraph (an HTML
  visual); `![alt](<media base>/<sha>.mp4)` (a library clip — muted loop with its poster); links
  `[text](<media base>/<sha>.pdf)` (a download). Raw HTML is still never allowed.
- **Visuals are served by a new origin**, `https://embed.noeystudio.com` (backend env
  `BLOG_EMBED_PUBLIC_URL`, the same name on the site): `/visual/<id>` (HTML, CSP
  `frame-ancestors https://noeystudio.com https://www.noeystudio.com`) and `/fonts/<file>`.
  The site frames it with `sandbox="allow-scripts"` only; CSP `frame-src` gains exactly that
  origin. Local testing only: backend `BLOG_EMBED_DEV_ANCESTORS`, site `BLOG_EMBED_ALLOW_HTTP=1`.
- **`/blog/media/<name>`** now also serves `<sha>.mp4` (with byte ranges) and `<sha>.pdf`
  (`Content-Disposition: attachment`, CSP sandbox). The cover stays a WebP (`render_cover`,
  1600×900, or a library image).
- JSON-LD: `BlogPosting.image` = the cover + library images in the body; library clips are
  `VideoObject`s; visuals are not images and are not listed.
