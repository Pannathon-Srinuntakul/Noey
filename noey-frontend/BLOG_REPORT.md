# Blog pages — report (branch `feature/blog-pages`, 2026-10-01)

The blog of noeystudio.com: listings, posts, feeds and machine-readable
surfaces, reading the public blog API of `BLOG_CONTRACT.md` (repo root). Built
on the "Cutting Room" design system as merged into `main` (8cde408; the spec
said to branch from `redesign/cutting-room`, which is now part of `main`).
Only `noey-frontend/` changed.

## Routes

| Public URL | Served by | Rendering |
| --- | --- | --- |
| `/blog`, `/blog?page=N` | `app/blog/page/[page]` (rewrite) | ISR 600 s |
| `/blog/category/<slug>` (+ `?page=N`) | `app/blog/category/[slug]/page/[page]` (rewrite) | ISR 600 s |
| `/blog/tag/<slug>` (+ `?page=N`) | `app/blog/tag/[slug]/page/[page]` (rewrite) | ISR 600 s; `noindex` below 3 posts |
| `/blog/<slug>` | `app/blog/[slug]` | ISR (`revalidate = 3600`; the root layout's price fetch makes it 600 s in practice) |
| `/blog/<slug>.md` | `app/blog/md/[slug]` (rewrite) | ISR 3600 s |
| `/blog/<slug>/opengraph-image` | generated card for a post without a cover | ISR |
| `/blog/opengraph-image` | the listings' share card | static |
| `/blog/feed.xml` | Atom, posts only | ISR 600 s |
| `POST /api/revalidate-blog` | revalidation hook for the backend | route handler |
| `/feed.xml`, `/sitemap.xml`, `/llms.txt` | now include the posts | ISR 600 s |

`?page=N` is rewritten (next.config.ts) to a static param route, so every
listing page is ISR and has its own canonical; `/blog/page/N` and the other
internal paths redirect back to the public URL. Page 1 is always the bare path.

**404s** (a post not published, an unknown category or tag, a page past the
last one) are answered by Proxy before any page renders (`lib/blog-proxy.ts`,
`lib/blog-gate.ts`): it keeps an index of the published slugs, categories and
tags (three public calls, 30 s, re-read before turning a URL away) and
rewrites a missing URL to `<path>/__missing/404`, which no route matches, so
the site's own 404 page renders on the server like `/nope`. Measured: a page
that calls `notFound()` while rendering gets Next 16's error shell instead —
an empty body, the 404 drawn in the browser, the root layout's scripts
re-created on the client ("Encountered a script tag…" in development).
When the API does not answer, Proxy decides nothing. The pages keep
`notFound()` as the backstop; their `generateMetadata` never throws and
returns the 404's own metadata (`noindex`, no canonical, no prev/next).
The header maps rewritten paths back to the address bar's
(`lib/nav-path.ts`), so its "you are here" is the same on the server and in
the browser.

## What was built, by spec section

- **Data layer** — `lib/server/blog.ts` (fetch + tags `blog`, `blog:<slug>`),
  `lib/blog.ts` (mapping untrusted JSON, copy, URLs). Fixtures:
  `lib/server/__fixtures__/blog.json` (5 posts: covers, no cover, no FAQ, a
  130-character title), on with `BLOG_FIXTURES=1` (`=empty` for no posts),
  never in a production build (NODE_ENV check that the bundler folds; the
  fixture data is absent from `.next/server` and `.next/standalone` — checked
  with grep — and unit-tested).
- **API down** — measured: Next answers a throw in the first render of an ISR
  page with a bare "Internal Server Error". So nothing throws: a failed call is
  retried once with a 30 s lifetime (Next takes it as the page's), then the
  last good answer this server saw is used, then the page renders its own
  "ตอนนี้ยังโหลดบทความไม่ได้" state (kept 30 s, still indexable). Cached pages
  keep serving (`x-nextjs-cache: HIT`). A post is never a 404 unless the API
  says 404. `app/blog/error.tsx` covers only unplanned errors.
- **/blog** — H1 + intro, category tracks (real links to SSR pages), the
  newest post on the "program monitor", the rest as clips with their reading
  length drawn on one scale, pagination with rel=prev/next and a canonical per
  page, the feed link, the closing band. Empty state: an empty editor track.
- **/blog/<slug>** — server-side Markdown (remark-gfm → rehype, raw HTML
  dropped, rehype-sanitize; no `dangerouslySetInnerHTML` on content), heading
  anchors, tables/code/quotes/lists in the system, `next/image` with real
  sizes (Markdown images are measured from their first bytes), external links
  `noopener nofollow` in a new tab (internal links get neither). Breadcrumb,
  H1, the opening paragraph as the answer, meta line (โดย Noey Studio · เผยแพร่
  · อัปเดตล่าสุด when changed on a later day · อ่าน N นาที), the cover or a
  generated slate (also when the picture fails to load), sticky `TimelineToc` from ##/### (### indented, cues
  01.1…), FAQ as `<details>`, related posts, the guide pages for the category,
  tags, then the site's closing band "ลองใช้ Noey Studio" (existing copy,
  /signup, /scope, /pricing).
- **Signature moments** — the *slate*: a post without a cover (or whose
  cover fails to load) gets a clapperboard drawn from the post: thin chalk
  stripes on the dark sticks on the logo's splice angle, a gold hinge,
  PROD. NOEY STUDIO and a roll, the category as the scene, a take number, a
  track of clips. It never repeats the title or the reading time (the card
  prints those once). The arm claps shut, and only then turns gold, when its
  card is picked up. The *program
  monitor* for the newest post, the *bin* of clips whose length is the
  reading time, the *transport* for pages, the *empty track*.
- **SEO** — `generateMetadata` (template `%s | Noey Studio`, canonical, OG
  `article` with times/section/tags/image, Twitter card); OG image = the cover,
  or `opengraph-image.tsx` (the site's card; the Thai title is laid out by
  fontkit and handed to satori as path data, so tone marks over upper vowels
  are drawn — satori alone drops them — and no API text reaches the SVG,
  GHSA-vcvr-r3jv-pc5j). JSON-LD through `lib/jsonld.ts`: `BlogPosting`
  (author and publisher the Organization), `FAQPage` when there is FAQ,
  `BreadcrumbList`; `/blog` adds `Blog` + `ItemList`; listings are
  `CollectionPage` + `ItemList`. Sitemap: `/blog`, listings with posts, tags
  with 3+ posts, every post with `updated_at`. `/feed.xml` gains the posts by
  their own dates; `/blog/feed.xml`; `<link rel="alternate">` on blog pages.
  llms.txt: a "บทความล่าสุด" section (20 newest, with `.md` twins). robots:
  unchanged (`/blog` is allowed).
- **Navigation** — "บทความ" in the header (six sections fit from 1024 px:
  tighter link padding at 1024–1099 px, a shorter signed-in name at
  1024–1180 px), the menu sheet, the footer, and a card on /guide.
- **Revalidation** — `POST /api/revalidate-blog`, like revalidate-prices:
  unset secret = 404, constant-time compare, ≤ 20 valid slugs, 8 KB body cap.
  Expires (`expire: 0`) the `blog` tags, each post, its `.md` twin and share
  image, every listing route, the sitemap, both feeds and llms.txt.
- **CSP / images** — `img-src` already allows `https:`. `next/image`
  `remotePatterns` gets exactly the media base (https, its path, no query).
  Only a non-https base (a local backend) adds its one origin to `img-src`.

## Environment

| Variable | Where | Notes |
| --- | --- | --- |
| `BLOG_REVALIDATE_SECRET` | run time | Same value as the backend's. Unset = no revalidation route (404); ISR still catches up. |
| `BLOG_MEDIA_PUBLIC_URL` | **build time** (Docker build arg) | Optional; default `https://api.noeystudio.com/blog/media` = the backend's default. Recorded in BLOG_CONTRACT.md "Changes" (2026-10-01). |
| `API_URL` | run time | Existing. |
| `BLOG_FIXTURES` | dev/test only | `1` or `empty`; ignored in production. |

Deploy notes: the build cannot reach the private API on Railway — fine: no
blog page is prerendered empty, and the sitemap/feeds/llms.txt built without
posts refresh 30 s after the deploy (verified with a build against a closed
port). `next/image` fetches covers from the public media URL, so Cloudflare
must not challenge the site's server (docs/blog-mcp.md already asks to turn
off Bot Fight Mode). Next 16.3.5 has advisory GHSA-vcvr-r3jv-pc5j (next/og
with attacker-controlled SVG values); the blog never passes API text to
`ImageResponse`, but upgrading `next` to ≥ 16.3.6 is recommended separately.

## End to end (local, against `feature/blog-mcp`)

Backend from that worktree on :8010 (`API_PUBLIC_URL=http://localhost:8010`),
scratch database `noey_blog_e2e` on the local Docker Postgres, revalidating
the standalone production build of this branch on :3320. Posts were written
through the MCP server exactly as a claude.ai connector does (DCR, PKCE,
admin consent, `upload_image`, `create_post`, `publish_post`; the backend
refused two drafts under its word minimum, as it should). Then one new post:

- before: the post is absent from /blog, its category and tag pages,
  sitemap.xml, feed.xml, blog/feed.xml, llms.txt; `/blog/<slug>` and `.md` 404;
- `publish_post` → the backend logged `blog_revalidated` (attempt 1, 2xx from
  the site) → the post page 200 with its title in the server HTML, present on
  every surface above, `.md` 200 `text/markdown`, share image 200 PNG —
  2.4 s from publish to everywhere;
- `unpublish_post` → revalidated → 404 and gone from every surface;
- `publish_post` again → back everywhere. PASS (50 checks, 0 failed).

## Lighthouse (mobile, 13.5, production build, simulated throttling)

| Page | Perf | A11y | BP | SEO | LCP | TBT | CLS |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/blog` (median of 3) | 93 | 100 | 100 | 100 | 3.2 s | 30 ms | 0 |
| `/blog/hook-first-shot-in-the-timeline` (cover, FAQ; median of 3) | 91 | 100 | 100 | 100 | 3.4 s | 20 ms | 0 |
| `/blog/subtitle-words-to-check` (no cover) | 94 | 100 | 100 | 100 | 3.1 s | 20 ms | 0 |

(Review round 2, after the fixes below. The first round measured 93 / 93 /
95, and 94 on a category page.)

The LCP element is the hero's lead text, as on the guides. Local images come
from an http backend, which the optimiser cannot fetch (local IP), so the
"image delivery" hint is local only; in production covers go through
`next/image`.

## Checks

- `npm run lint`, `npm run typecheck`: clean. `npx vitest run`: 35 files,
  360 tests (new: data layer, mapping, fixtures-never-in-production,
  Markdown sanitising, revalidation route, JSON-LD with/without FAQ,
  metadata, sitemap, feeds, llms.txt, `.md` twin, image sizes, OG text, the
  404 gate and its index, the 404 metadata of every blog route).
  The two existing tests that call `sitemap()` now `await` it (assertions
  unchanged).
- `npm run build`: passes with the API up and with it unreachable.
- `node scripts/content-parity.mjs`: 0 missing. `color-audit`: 0.
- JSON-LD: a local validator (schema.org vocabulary, inheritance, @id
  resolution, Google's required properties) passes on every blog page type.
- axe-core (WCAG 2.2 AA + best practice) at 390 and 1440 px, both themes, 7
  blog pages: 0 violations. No horizontal overflow at 360/390/768/1024/1440.
  No console errors or CSP reports. Keyboard: 69 tab stops on a post, every
  one visible with a focus ring; FAQ opens with Enter. JavaScript off: full
  text, every FAQ answer in the DOM, nothing hidden; every image sized.
- Computed styles at 360/390/1440: no Thai text in the blog under 12 px.
  (The one smaller Thai string on these pages is the header's site-wide
  brand tagline "ตัดคลิปด้วย AI", 10.5–11.5 px, unchanged from `main`.)
- `thai-breaks` (360/390/768/1024/1440): no break inside a word in the
  blog's own copy. Left: dictionary disagreements in test-article text
  ("อ่านทวน / คำ", "ทุกครั้ง / ก่อน…") — the same class as the
  21 hits `main` already has on /about, /scope, /terms and the guides
  (identical on both branches). New glue rules: "ตั้งแต่", "จนถึง", "จน" hold
  to the next word; the glossary gained the new copy's words.

## Screenshots

36 files (390 and 1440 px, light and dark) of /blog, a category, a tag, a post
with a cover, a post without one (the slate), a post with FAQ, the empty
state (dev, `BLOG_FIXTURES=empty`) and the API-down state (a post and a
listing never rendered before the outage), plus a cover that fails to load
(its file deleted from the media store) on a post and on a listing card,
with JavaScript (the slate) and without it (the frame, never the broken-image
glyph). All reviewed.

## Review round 2 (2026-10-01)

1. Slate sticks: light neutral stripes on the dark board, thinner; gold only
   on the hinge and while the arm claps. The box at the end of a post is now
   the site's closing band.
2. The slate shows no title: PROD. NOEY STUDIO, roll, SCENE (category), TAKE,
   the track. The share image keeps the title.
3. Reading time is said once ("อ่าน N นาที" and the card's strip); both
   timecodes are gone.
4. A cover that fails becomes the slate (`CoverImage`, next/image `onError`
   plus a check for a failure before hydration); without JavaScript the
   frame's ground covers the broken image.
5. Thai labels are at least `--fs-12` (the slate's scene clamps from it);
   checked with computed styles.
6. A page past the last one (and an unknown category, tag or post) has the
   404's metadata: `noindex`, no canonical, no prev/next.
7. Blog 404s render the site's 404 page on the server (Proxy, above): no
   script warning, no error shell, the same HTML as `/nope`.
8. The API-down listing keeps the lead; the count pill shows only when known
   and keeps its line either way.

## Waiting on the backend

Nothing blocks the pages. To go live: merge `feature/blog-mcp` (migration,
API, MCP), set `BLOG_REVALIDATE_SECRET` on both services (and
`BLOG_REVALIDATE_URL` on the API if the site is not at `SITE_URL`), keep
`BLOG_MEDIA_PUBLIC_URL` equal on both (or unset on both), and do the
Cloudflare steps in `docs/blog-mcp.md`. A `/blog` loading skeleton is left for
`feature/loading-states`.
