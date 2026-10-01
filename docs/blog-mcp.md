# Blog MCP server — let Claude write noeystudio.com articles

A scheduled task in claude.ai writes an SEO article every two days and posts it
to noeystudio.com through a **Remote MCP server** added as a **custom
connector**. The owner monitors and can take any article down at any time from
the admin dashboard (tab **บทความ**).

Code: `backend/services/mcp/server.py` (MCP server, mounted inside the API
process), `backend/packages/blog/` (rules, OAuth, images, revalidation, and
the pictures of §4: visuals, covers, the media library, brief and plan),
`backend/services/api/routers/blog.py` (public read API) and `admin_blog.py`
(moderation), `admin/src/components/BlogTab.tsx` + `admin/src/app/connect/`
(UI). The read API and revalidation follow `BLOG_CONTRACT.md` (repo root); the
pages live in `noey-frontend/`.

## 1. Endpoint URLs

| | Production | Local |
|---|---|---|
| MCP endpoint (enter this in Claude) | `https://api.noeystudio.com/mcp` | `http://localhost:8000/mcp` |
| Protected resource metadata | `https://api.noeystudio.com/.well-known/oauth-protected-resource/mcp` (also at `/.well-known/oauth-protected-resource`) | same paths on `localhost:8000` |
| Authorization server metadata | `https://api.noeystudio.com/.well-known/oauth-authorization-server` | same |
| OAuth endpoints | `/mcp/oauth/authorize`, `/mcp/oauth/token`, `/mcp/oauth/register`, `/mcp/oauth/revoke` | same |
| Consent page (admin) | `https://admin.noeystudio.com/connect?request=…` | `http://localhost:3001/connect?request=…` |
| Public blog API | `https://api.noeystudio.com/blog/...` | `http://localhost:8000/blog/...` |

Transport: Streamable HTTP, **stateless**, JSON responses (the API runs several
workers/replicas; nothing is kept in a process between requests).

### What the server exposes

Tools (all with strict JSON schemas and English descriptions; a refusal lists
every problem to fix):

- `get_site_info` — product facts, audience, real modes, honest scope (can / cannot do), plans + live prices, CTA links, the existing `/guide` articles (never write a duplicate topic), and the **writing rules**.
- `list_posts(status?, limit=20, cursor?)` — every status, to avoid repeats.
- `get_post(slug)`
- `get_site_info` also returns `brand` (colours light + dark from the site's tokens, font families and their URLs on the font origin, the logo in the media store + as inline SVG, canvas sizes, the cover CSS subset, a minimal working visual and cover), the owner's `brief` (with `updated_at`) and `content_plan` (open topics only, in order).
- `create_post({...})` — always a **draft**, `source = "ai"`. Validates: contract lengths, unique slug, Markdown with no raw HTML/script/iframe, headings from `##`, ≥ 2 internal links, ≥ `BLOG_MIN_WORDS` words (Thai segmented), category exists (categories are fixed), 3–6 FAQ, no AI-vendor names anywhere — and the **picture rules** (§4): a cover from `render_cover` or the library, ≥ 2 body pictures (visuals, library images/clips), every one with alt text and stored here, visuals made by **this** connection only, ≤ 3 animated, PDFs only as links from the library.
- `update_post(slug, changes)` — only posts with `source = "ai"`; the owner's posts (`source = "human"`, i.e. anything edited in the admin) are out of reach. `new_slug` only before the first publish.
- `publish_post(slug)` — refuses when the owner switched auto-publish off (answers "waiting for the owner") or the per-day cap (Asia/Bangkok calendar day) is used up (answers when it can publish next). Sets `published_at` the first time, locks the slug, revalidates the site.
- `unpublish_post(slug)` — takes a post offline (kept, never deleted). **There is no delete tool.**
- `upload_image(image_base64, filename, alt)` — **small images only: base64 ≤ 300 KB** (the description sends the writer to `create_visual` / `render_cover` / `list_media`). PNG/JPEG/WebP by magic bytes, ≤ 4096 px; re-encoded to WebP (EXIF/ICC/XMP gone, longest side ≤ 1600 px), named by its SHA-256 → `{url, width, height}`. Cannot be a cover.
- `create_visual({html, css, js?, width, height, alt, caption?, animated})` → `{id, markdown: "::visual[alt](id)", preview_url}` — an in-article picture drawn in HTML (§4). Validated and stored, never rendered on the server.
- `render_cover({html, css, alt})` → `{url, width: 1600, height: 900}` — the cover as a real WebP, drawn by satori + resvg (§4). `BLOG_COVER_CALLS_PER_MIN` (6) per connection.
- `list_media({kind?: screenshot|demo|logo|file, tag?})` → `[{url, poster_url?, alt, description, tags, width, height, markdown}]` — the owner's library.
- `get_icons({names[], size?, color?, stroke?})` — Lucide icons as inline `<svg>` to paste into a visual or cover.
- `mark_topic_done({topic_id, slug})` — links a content-plan topic to the post that covers it.
- `list_categories`, `list_tags`.

Rate limit: `BLOG_MCP_CALLS_PER_MIN` (60) tool calls per minute per approved
connection, counted in Redis. OAuth endpoints have per-IP limits.

Every write — from MCP or the admin, allowed or refused — is a row in
`core.blog_audit_log`, visible in the admin (บันทึกการเปลี่ยนแปลง).

## 2. Add it to claude.ai as a custom connector

What Claude's connector client requires — verified 2026-10-01 against
[MCP authorization spec 2026-07-28](https://modelcontextprotocol.io/specification/latest/basic/authorization),
its [discovery](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery)
and [security](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
pages, Claude's [Authentication for connectors](https://claude.com/docs/connectors/building/authentication)
and [Add a connector that isn't in the directory](https://claude.com/docs/connectors/custom/add-unlisted):

- A `401` with `WWW-Authenticate: Bearer resource_metadata="…"` starts sign-in (Claude ignores the header on a 200). ✔ ours also carries `scope="blog:write"` and `error="invalid_token"`.
- The PRM `resource` must equal the URL entered in Claude exactly — enter **`https://api.noeystudio.com/mcp`** (no trailing slash). Claude uses only the first `authorization_servers` entry. ✔ one entry: `https://api.noeystudio.com`.
- Authorization server metadata (RFC 8414) must advertise `code_challenge_methods_supported: ["S256"]`; clients refuse without it. Claude always sends PKCE S256. ✔ PKCE is mandatory here.
- Client identity: Claude uses a Client ID Metadata Document only if the AS advertises `client_id_metadata_document_supported` **and** `none` auth; otherwise it uses **Dynamic Client Registration**. ✔ We support DCR (RFC 7591) and do not advertise CIMD, so Claude registers itself. (The spec now calls DCR "deprecated, retained for compatibility" and CIMD a SHOULD — DCR is what Claude falls back to, and it is the simplest safe choice for one owner.)
- Hosted Claude apps (web, Desktop, mobile, Cowork) redirect to **`https://claude.ai/api/mcp/auth_callback`**; Anthropic says this may become `https://claude.com/api/mcp/auth_callback`. ✔ Registration accepts exactly these two. Claude Code uses a loopback redirect on a random port — accepted only when `BLOG_MCP_ALLOW_LOOPBACK_REDIRECTS=true` (off in production).
- `resource` (RFC 8707) is sent on authorize and token requests; tokens must be audience-bound and the server must refuse others. ✔ A foreign `resource` is refused (`invalid_target`); tokens carry `aud=noey-blog-mcp` + `resource=<…/mcp>` and both are checked.
- The consent screen must show the redirect URI's host. ✔ ("ส่งกลับไปที่ claude.ai", plus a warning for loopback.)
- `iss` on the authorization response (RFC 9207) is a SHOULD. ✔ sent on approve and deny.
- Token endpoint: `application/x-www-form-urlencoded`, `invalid_grant` for a dead refresh token, and **rotate refresh tokens** for public clients (MCP spec MUST). Claude refreshes on 401 and up to 5 minutes before expiry; it waits 10 s for discovery/registration/token and 30 s for refresh. ✔ access token 1 h, refresh token single use (30 days); a replayed refresh token revokes the whole connection.
- Anthropic's outbound traffic comes from `160.79.104.0/21` — discovery, registration and token calls included, so a WAF must not challenge them (section 3).

Steps (Pro/Max plan; on Team/Enterprise an Owner does this under Organization settings → Connectors):

1. Make sure the production env vars below are set and the API is deployed.
2. claude.ai → **Customize → Connectors → Add custom connector**.
3. Name: `Noey Studio blog`. **MCP server URL:** `https://api.noeystudio.com/mcp`.
4. Authentication / OAuth client: leave **Advanced settings → OAuth Client ID / Secret empty** (or choose "Register automatically") — Claude registers through DCR. Do not choose "Use Claude's published identity" (we do not offer CIMD). Transport: leave the default.
5. Click **Add**, then **Connect**. A browser tab opens on `admin.noeystudio.com/connect?...`.
6. Sign in to the admin (password + emailed 6-digit code). Arriving from claude.ai, the browser withholds the admin's SameSite=Strict cookies on that first cross-site hop, so the login page shows "เข้าสู่ระบบอยู่แล้ว? ดำเนินการต่อ" — click it if already signed in.
7. Check the client name and **ส่งกลับไปที่ claude.ai**, click **อนุญาต**. The tab returns to Claude and the connector shows as connected.
8. In a chat, enable the connector (**+ → Connectors**) and ask: "เรียก get_site_info แล้วสรุปกฎการเขียน" to check.
9. To cut it off at any time: admin → **บทความ → ตัวเชื่อมต่อ AI ที่ได้รับอนุญาต → ยกเลิก** (tokens die on the next call), or switch off auto-publish so posts wait for approval.

## 3. Production setup

### Railway env vars

**Noey Api** (the MCP server runs inside it; migrations run on deploy):

| Variable | Example | Notes |
|---|---|---|
| `API_PUBLIC_URL` | `https://api.noeystudio.com` | Issuer + `<this>/mcp` resource. No trailing slash. **Required** (default is localhost). |
| `ADMIN_URL` | `https://admin.noeystudio.com` | Where /authorize sends the browser for consent. **Required.** |
| `BLOG_REVALIDATE_URL` | `https://www.noeystudio.com/api/revalidate-blog` | Full URL of the site route. Unset → `SITE_URL` + `/api/revalidate-blog`. |
| `BLOG_REVALIDATE_SECRET` | 48+ random chars | The SAME value on **Noey Studio** (site). Unset → revalidation skipped (ISR catches up in 10 min). |
| `BLOG_MEDIA_PUBLIC_URL` | *(leave unset)* | Unset → images are `https://api.noeystudio.com/blog/media/<sha256>.webp`, read from the existing bucket's `blog/` prefix; the bucket stays private and Cloudflare caches `.webp`. Only set it to a public bucket domain that serves **nothing but `blog/`** (e.g. `https://media.noeystudio.com/blog`) — a public bucket domain would otherwise expose users' videos. |
| `BLOG_MAX_PUBLISH_PER_DAY` | `2` | Default; the admin can override it. |
| `BLOG_AUTO_PUBLISH` | `true` | Default; the admin can override it. |
| `BLOG_MIN_WORDS` | `600` | Optional. |
| `BLOG_MCP_CALLS_PER_MIN` | `60` | Optional. |
| `BLOG_MCP_ALLOW_LOOPBACK_REDIRECTS` | *(unset = false)* | Set `true` only to connect Claude Code / MCP Inspector. |
| `BLOG_EMBED_PUBLIC_URL` | `https://embed.noeystudio.com` | Default shown. The cookieless origin of visuals + fonts; requests whose Host is this host are answered by `services/api/embed.py` only. |
| `BLOG_EMBED_DEV_ANCESTORS` | *(leave unset)* | Extra `frame-ancestors` for local testing only (e.g. `http://localhost:3260`). |
| `BLOG_COVER_CALLS_PER_MIN` | `6` | Optional. |
| `BLOG_COVER_NODE` | `node` | Optional; the image ships `/usr/local/bin/node`. |
| `BLOG_COVER_IDLE_SEC` | `300` | Optional; the renderer process stops after this long without a cover. |

Existing variables it relies on: `JWT_SECRET` (signs MCP tokens and derives
the key that encrypts confidential clients' secrets — rotating it disconnects
every connector), `REDIS_URL`, `S3_*`, `SITE_URL`, `TRUSTED_PROXY_HOPS`.

**Noey Dashboard** (admin): optionally `BLOG_MEDIA_PUBLIC_URL` = the media base
the API uses (e.g. `https://api.noeystudio.com/blog/media`) so the article
preview may load images (`img-src` gains exactly that origin). Its `API_URL`
and `ADMIN_URL` are unchanged.

**Noey Studio** (site): `BLOG_REVALIDATE_SECRET` (same value) and the existing
`API_URL` — per `BLOG_CONTRACT.md`. Its CSP / `next/image` must allow the media
origin (`https://api.noeystudio.com` with the default above). Optional
`BLOG_EMBED_PUBLIC_URL` (default `https://embed.noeystudio.com`, read at BUILD
time) — CSP `frame-src` gains exactly that origin. `BLOG_EMBED_ALLOW_HTTP=1`
only for a local http embed origin; never in production.

### The embed origin `embed.noeystudio.com` (owner's steps — not done from code)

1. **Railway** → service **Noey Api** → Settings → Networking → **Custom Domain** →
   `embed.noeystudio.com` (same service as `api.noeystudio.com`; no new service).
   Railway shows the CNAME target.
2. **Cloudflare DNS** (zone noeystudio.com) → add `CNAME embed → <the Railway target>`,
   **Proxied** (orange cloud), like `api`.
3. **Cloudflare cache rule** (Caching → Cache Rules → Create):
   - Name `Blog visuals + media immutable`
   - Expression: `(http.host eq "embed.noeystudio.com" and (starts_with(http.request.uri.path, "/visual/") or starts_with(http.request.uri.path, "/fonts/"))) or (http.host eq "api.noeystudio.com" and starts_with(http.request.uri.path, "/blog/media/"))`
   - Action: **Eligible for cache**, Edge TTL **use origin cache-control** (the origin
     sends `public, max-age=31536000, immutable`), Browser TTL respect origin. (HTML is
     not cached by default on Cloudflare, so the `/visual/` HTML needs this rule.)
4. Nothing else: no cookie, no login and no WAF exception is needed on `embed`.
   Do **not** add `embed.noeystudio.com` to any Cloudflare Access policy.
5. Check: `curl -sI https://embed.noeystudio.com/visual/<id>` → 200 with the CSP of §4
   and no `set-cookie`; `curl -sI https://embed.noeystudio.com/blog/categories` → 404.

### Deployment changes (image, build, memory)

- **No Chromium/Playwright on the server.** The only addition to `backend/Dockerfile` is
  a digest-pinned `node:22-bookworm-slim` build stage that runs `npm ci` on
  `backend/cover_renderer/package-lock.json`; the runtime image copies just
  `/usr/local/bin/node` (122 MB) and the renderer's `node_modules` (37 MB: satori,
  resvg's prebuilt binary, juice). Measured on the local arm64 build (2026-10-02):
  image **2.51 GB → 2.73 GB** on disk (+0.22 GB), compressed **613 MB → 669 MB** (+56 MB);
  the two new layers build in ~20–30 s (cached Python layers: 97 s → 78 s rebuild).
- **The worker service** (same Dockerfile, `python -m services.worker`) never starts the
  renderer — it only runs inside the API process, on the first `render_cover` call.
- **RAM** (Linux container, measured): the renderer process is **86 MB** once its fonts
  are loaded, **119 MB** after the first cover, **142 MB** after 31 covers (plateau;
  ~140 MB after 60 on macOS too), V8 heap capped (`--max-old-space-size=96
  --max-semi-space-size=2`). The API process itself: **282 → 279 MB** around 20 covers
  (no growth; the PNG/WebP work is small). With `API_WORKERS = N` the worst case is
  N × ~145 MB extra while covers are being drawn; it falls back to 0 after
  `BLOG_COVER_IDLE_SEC` idle. Railway guidance: keep ≥ 150 MB headroom per API worker
  on the API service; nothing changes on the worker service.
- **Timing**: first cover after idle ~0.35–0.9 s (process start + fonts), then 60–120 ms.

### Cloudflare (dashboard only — cannot be done from code)

1. **AI crawlers on the site:** Security → Bots (or *AI Crawl Control*): turn **off** "Block AI bots" / set GPTBot, ClaudeBot, PerplexityBot, Google-Extended… to **Allow** for `noeystudio.com`. `robots.txt` (noey-frontend `src/lib/crawl.ts`) already allows them.
2. **Bot Fight Mode:** Security → Bots. The free *Bot Fight Mode* cannot be bypassed by WAF rules — if it is on, turn it **off** (it challenges the claude.ai backend and crawlers). With *Super Bot Fight Mode* (Pro+), keep "Definitely automated" at Allow or skip it with the rule below.
3. **WAF skip rule for the MCP surface** (Security → WAF → Custom rules → Create):
   - Name: `Skip MCP + OAuth discovery`
   - Expression:
     `(http.host eq "api.noeystudio.com" and (starts_with(http.request.uri.path, "/mcp") or starts_with(http.request.uri.path, "/.well-known/oauth-")))`
   - Action: **Skip** → all remaining custom rules, rate limiting rules, managed rules, Super Bot Fight Mode, and (under "More components") Browser Integrity Check, Security Level, User Agent Blocking.
   - Place it **first**. The app enforces auth itself (every `/mcp` call needs a bearer token; OAuth endpoints are rate-limited per IP). Anthropic's egress range is `160.79.104.0/21` if you want an extra, tighter rule — but the owner's browser also hits `/mcp/oauth/authorize`, so do not restrict that path to it.
   - Also make sure no Cache Rule caches `/mcp*` or `/.well-known/*` with a long TTL (default Cloudflare does not cache them).
4. **Verify** (each must print `200`; the MCP endpoint must print `401` with a `www-authenticate` header, never a challenge page):

```bash
curl -s -o /dev/null -w "%{http_code}\n" -A "GPTBot" https://www.noeystudio.com/blog
curl -s -o /dev/null -w "%{http_code}\n" -A "ClaudeBot" https://www.noeystudio.com/blog
curl -s -o /dev/null -w "%{http_code}\n" -A "ClaudeBot" https://www.noeystudio.com/robots.txt
curl -s -o /dev/null -w "%{http_code}\n" -A "Claude-User" https://api.noeystudio.com/.well-known/oauth-protected-resource/mcp
curl -s -o /dev/null -w "%{http_code}\n" -A "Claude-User" https://api.noeystudio.com/.well-known/oauth-authorization-server
curl -s -D - -o /dev/null -X POST -A "Claude-User" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' https://api.noeystudio.com/mcp | grep -i -E "^HTTP|www-authenticate"
```

## 4. Pictures: visuals, covers, the media library (2026-10-02)

Spec: `BLOG_MEDIA_PROMPT.md` (the second version — no Chromium, no
render_graphic / render_animation). Contract changes: `BLOG_CONTRACT.md`
"Changes 2026-10-02".

### Visuals — HTML that behaves like an image (`create_visual`)

- **Checked, not rendered.** `packages/blog/markup.py` parses the HTML with the
  standard library's tokenizer and the CSS with a CSS Syntax Level 3 tokenizer
  (no regex decides anything). Refused, each named with its line: `<script>` in
  html (JS goes in `js`), `<iframe>`, `<frame>`, `<form>`, `<a>`, form controls,
  `<object>`, `<embed>`, `<base>`, `<meta>` (refresh included), `<link>`,
  `<audio>/<video>`, `<noscript>`, `<template>`, `<math>`, `<style>` inside `<svg>`,
  `on*=` handlers, `srcset`/`srcdoc`, `@import`, `@font-face`, `expression()`,
  `behavior`, any `<` in CSS, and every URL (attribute, `url()`, `image-set()`, SVG
  `href`) that is not `#fragment`, `data:image/*` or a media-store WebP that exists;
  in `js`, `</script`/`<!--` and literal outside URLs. ≤ 200 KB, canvas 200–2400 px a
  side, ratio 1:4–4:1.
- **What is stored is the re-serialisation** of the parse (attributes quoted and
  escaped, comments/doctype/CDATA dropped, SVG names restored), wrapped once:
  fonts (`@font-face` from the font origin), the canvas at its designed size scaled
  by a CSS transform to the frame width, then — after the writer's CSS, with
  `!important` — no margin/scrollbars/selection/callout/cursor, `pointer-events:none`
  everywhere; context menu, drag and select cancelled; `postMessage({type:"pause"|"play"})`
  from the parent pauses CSS animations (`animation-play-state`), Web Animations and
  `requestAnimationFrame`; `prefers-reduced-motion: reduce` keeps it paused whatever
  the parent sends. Stored under the bucket's `visual/` prefix (or `DATA_DIR/visual`),
  id = `sha256(connection + document)[:32]` → immutable.
- **Served from the embed origin** by `services/api/embed.py`, the outermost ASGI layer
  of the API: a request whose Host is `BLOG_EMBED_PUBLIC_URL`'s host gets `/visual/<id>`,
  `/fonts/<file>` (`Access-Control-Allow-Origin: *` — an opaque-origin frame loads fonts
  in CORS mode) or `/robots.txt` (`Disallow: /`), and nothing else; the API's routes,
  middleware and cookies never see it. The layer reads no header but `Host` and sends no
  `set-cookie`. Visual headers, exactly the spec's:
  `Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src <media origin> data:; font-src <embed origin>; connect-src 'none'; form-action 'none'; frame-ancestors https://noeystudio.com https://www.noeystudio.com`,
  `X-Content-Type-Options: nosniff`, `Cache-Control: public, max-age=31536000, immutable`
  (+ `Referrer-Policy: no-referrer`).
- **Why the API and not the site**: the API already owns the bucket the visuals live
  in and authenticates with bearer tokens only, so it has no cookies; the site sets
  session cookies on its host. Host routing on the same Railway service keeps it
  cookieless and on the same infrastructure — one custom domain, no new service.
- **On the page** (`noey-frontend/src/components/blog/BlogVisual.tsx`): the spec's
  markup — `<figure class="visual" style="aspect-ratio: W / H">`, `<iframe
  sandbox="allow-scripts" loading="lazy" tabindex="-1" aria-hidden="true" scrolling="no"
  referrerpolicy="no-referrer" title="" style="…pointer-events:none">`, the alt as
  `.sr-only` text, the caption. The iframe URL is built from the id and the site's own
  embed origin. IntersectionObserver sends `pause` off screen and `play` back on;
  reduced motion only ever sends `pause`. Same frame and corners as the article's
  images, a pale brand ground while loading, a fade-in when drawn.
- **Containment** is the sandbox (no `allow-same-origin` → opaque origin: no cookies,
  no storage, no access to the parent; no `allow-top-navigation`, `allow-popups`,
  `allow-forms`) + CSP (`connect-src 'none'`, images/fonts only from our origins) +
  a cookieless origin. Tested in Chromium in `tests/test_blog_visual.py` with an
  attack script injected unchecked (reads of `document.cookie`, `parent.document.cookie`,
  `parent.location`, `top.location`, `localStorage`; `fetch`, XHR, an image beacon,
  `window.open`, `top.location =`, a created `<form>` submit) — every one fails and no
  request leaves the browser; pause/play, reduced motion and `frame-ancestors` are
  checked there too.
- **Limits**: ≤ 3 animated visuals per post (create_post refuses more); a post may
  only use visuals made by its own connection.

### Covers (`render_cover`)

- `packages/blog/cover.py` checks the markup (mode "cover": also refuses CSS grid,
  inline/table layouts, animation/@keyframes/transition, float, fixed/sticky,
  `@media`, `<style>` in html, `<foreignObject>`, and characters the brand fonts do not
  have — emoji — naming each spot), turns media-store images into PNG data URLs, and
  sends the job to `backend/cover_renderer/worker.mjs`: juice inlines the CSS,
  satori-html builds the element tree, **satori** lays it out and draws text as
  paths (shaped with HarfBuzz — Thai marks stack correctly), **resvg** rasterises
  1600×900; Pillow writes WebP q90 → media store (`origin = render_cover`).
- **Why a Node child**: satori is JavaScript (yoga + HarfBuzz in WebAssembly); one
  small long-lived `node` process per API process, JSON lines over stdin/stdout, is the
  lightest reliable bridge. Fonts are read once at start; one job at a time (an asyncio
  lock is the queue, ≤ 3 waiting, the rest told to retry); hard 10 s timeout → the child
  is killed and the next call starts a fresh one; a crash or garbled answer → restart;
  stopped after `BLOG_COVER_IDLE_SEC`; it exits by itself when stdin closes (API gone —
  verified: no orphan after stopping uvicorn). Its global `fetch` is disabled.
- Supported CSS (told to the writer in the tool description and `brand.cover`):
  flexbox, relative/absolute position, sizes, padding/margin, linear/radial
  gradients, border, border-radius, box-shadow, text-shadow, opacity, transform,
  the two Thai families at 400–700, inline `<svg>` (get_icons), media-store `<img>`.

### Media library (admin → คลังสื่อ, `list_media`)

- Upload screenshots / logos (PNG/JPEG/WebP ≤ 10 MB → WebP ≤ 2400 px, metadata
  gone), demo clips (MP4/MOV ≤ 40 MB, ≤ 120 s, ≤ 2160 px → H.264 yuv420p, audio
  and all metadata dropped, `+faststart`, first frame → WebP poster), PDFs (`%PDF-`
  … `%%EOF`, ≤ 20 MB → served only as `attachment` with CSP `sandbox`). Every check is
  on the bytes. Alt, description and tags are editable; "ซ่อนจาก AI" archives an item
  (it stays valid where already used).
- On the page a clip is `<video muted loop playsinline preload poster>` in the image
  frame; the first clip preloads metadata, the rest none. **Autoplay is applied by the
  client only when motion is allowed** (and only while on screen); the server HTML has
  no `autoplay`, so a reduced-motion reader never sees it move, even before hydration —
  they get the poster and controls (the owner's rule; the spec's `autoplay` attribute is
  set on the element by the client).
- JSON-LD: `BlogPosting.image` = cover + library images; clips = `VideoObject`
  (name, description, contentUrl, thumbnailUrl, uploadDate, duration).

### Brief, content plan, brand

- Admin → บทความ: **Writing brief** (tone, focus / avoid topics, length, pictures,
  this month's note; last edited) and **Content plan** (ordered topics, status
  รอเขียน / กำลังเขียน / เขียนแล้ว / ข้าม, reorder, link to a post).
- `get_site_info` returns `brief` (+ `updated_at`), `content_plan` (open topics, in
  order) and `brand`. The logo is the site's mark rasterised once by resvg into the
  media store (origin `brand`, content-addressed, idempotent).
- Colours come from `noey-frontend/src/app/globals.css` via
  `scripts/build_brand_info.py` (`--check` in the tests, like site_info).

## 5. Prompt for the scheduled task ("เขียนบทความทุก 2 วัน")

claude.ai → create a scheduled task (every 2 days) with the **Noey Studio blog** connector enabled, and this prompt:

```text
คุณคือผู้เขียนบล็อกของ Noey Studio (noeystudio.com) ใช้ตัวเชื่อมต่อ "Noey Studio blog" เท่านั้น ทำตามลำดับนี้ทุกครั้ง:

1. เรียก get_site_info แล้วอ่าน writing_rules, scope, guides, brand, brief และ content_plan ให้ครบ ทำตามกฎและ brief ทุกข้อ
2. เลือกหัวข้อ: ถ้า content_plan มีหัวข้อที่ยังไม่ได้เขียน ให้เขียนหัวข้อแรก (เก็บ id ไว้)
   ถ้าไม่มี ให้เรียก list_posts (ทุกสถานะ ไล่ next_cursor จนหมด) แล้วเลือกหัวข้อใหม่ที่ครีเอเตอร์ TikTok Affiliate ไทย
   ค้นหาจริง ไม่ซ้ำกับบทความที่มีและคู่มือใน guides (ถ้าใกล้กับคู่มือ ให้ลิงก์ไปหาคู่มือแทน)
3. ภาพ (บังคับ):
   - เรียก list_media ดูภาพหน้าจอ/คลิปสาธิตจริงที่ใช้ได้ก่อน
   - ปก: render_cover 1600×900 ใช้สีและฟอนต์จาก brand (flexbox เท่านั้น ไม่มี grid/animation/emoji) แล้วใช้ url เป็น cover_image_url พร้อม cover_alt
   - ในเนื้อหาอย่างน้อย 2 ชิ้น: create_visual (infographic/แผนภาพ/ภาพเคลื่อนไหวในแบรนด์ ขนาดเช่น 1600×1000)
     วาง markdown ที่ได้ (::visual[alt](id)) ไว้บรรทัดของมันเอง และ/หรือรูป/คลิปจาก list_media เป็น ![alt](url)
   - ไอคอนใช้ get_icons แล้ววาง <svg> ลงใน html, ภาพเคลื่อนไหวไม่เกิน 3 ชิ้น, ทุกภาพต้องมี alt ภาษาไทยที่บอกว่าภาพแสดงอะไร
   - ห้ามแต่งตัวเลขในกราฟ ห้ามลอกหน้าจอผลิตภัณฑ์ขึ้นมาเอง (ใช้ภาพหน้าจอจริงจาก list_media)
4. เรียก create_post หนึ่งครั้ง:
   - slug ภาษาอังกฤษตัวเล็ก-ขีดกลาง, title/excerpt/meta ภาษาไทย ตามความยาวที่กำหนด
   - ย่อหน้าแรกตอบคำถามของหัวข้อตรง ๆ, ใช้หัวข้อ ## / ###, ย่อหน้าสั้น
   - ลิงก์ภายในอย่างน้อย 2 ลิงก์ (เช่น /pricing, /scope หรือหน้าใน guides) และปิดท้ายด้วย CTA ไป /signup
   - faq 3–6 ข้อ เป็นข้อความล้วน, เลือก category ที่มีอยู่, tags ไม่เกิน 8
   - ห้ามแต่งตัวเลข/สถิติ/รีวิวลูกค้า ห้ามอ้างความสามารถที่ scope บอกว่าทำไม่ได้ ห้ามเอ่ยชื่อผู้ให้บริการ AI
   ถ้าถูกปฏิเสธ (create_post, create_visual หรือ render_cover) ให้แก้ตามรายการที่ได้รับแล้วเรียกใหม่ (สูงสุด 3 ครั้งต่อเครื่องมือ)
5. ถ้าเขียนจากหัวข้อใน content_plan ให้เรียก mark_topic_done(topic_id, slug)
6. เรียก publish_post กับ slug นั้น
   - ถ้าตอบว่ารอเจ้าของอนุมัติ หรือเกินเพดานรายวัน ให้หยุดและรายงาน ห้ามพยายามเลี่ยง
7. สรุปสั้น ๆ: หัวข้อ, slug, สถานะ, ลิงก์, ภาพที่ใช้ และเหตุผลที่เลือกหัวข้อนี้
ห้ามแก้บทความที่ source เป็น human และห้ามถอนบทความใด ๆ เว้นแต่เจ้าของสั่ง
```

## 6. End-to-end results

### Pictures (local, 2026-10-02)

API on :8030 (scratch database, no bucket, `BLOG_EMBED_PUBLIC_URL=http://127.0.0.1:8030` —
a different host name than the API's `localhost:8030`, so host routing is exercised),
the production build of the site on :3260 (`BLOG_EMBED_ALLOW_HTTP=1`), real
revalidation. `scripts/blog_media_e2e.py` (MCP SDK client + admin API):

```text
  ✓ admin library: screenshot 860×1520 (a real screenshot of the site) → …/blog/media/46d9…webp
  ✓ admin library: demo clip 960×540 5.1 s (recorded from the site) → …/b710…mp4 (poster 1211…)
  ✓ admin library: PDF → …/e24e…pdf
  ✓ admin library: an EXE named .pdf → 400 รองรับเฉพาะ PNG / JPEG / WebP, วิดีโอ MP4 และ PDF (ตรวจจากเนื้อไฟล์ ไม่ใช่ชื่อไฟล์)
  ✓ admin: brief saved, plan topic #2
  ✓ get_site_info: brand primary #b68235, fonts ['Noto Sans Thai', 'IBM Plex Sans Thai'], logo …/71eb…webp
  ✓ get_site_info: brief updated_at 2026-10-01T21:02:59Z, open topics ['ตัดคลิปรีวิวสินค้าให้ไวขึ้น', …]
  ✓ list_media / get_icons
  ✓ render_cover → 1600×900 in 0.51 s (Thai title, gradient, text-shadow, box-shadow, Lucide icon)
  ✓ render_cover refused: display:grid · <script> · animation · 🎬 (U+1F3AC) — each named
  ✓ create_visual → a still infographic (3 steps + the real screenshot in a phone frame) and an animation
  ✓ create_visual refused: <iframe> · <a> · @import — each named
  ✓ create_post + publish_post → published; mark_topic_done → done
  ✓ create_post refused: <iframe> · an outside image · 4 animated visuals · no cover / 0 pictures
  ✓ performance post: 6 visuals, 3 animated → published
  ✓ GET /blog/posts/<slug> media: ['visual', 'image', 'visual', 'video']
  ✓ audit log (ok, refused): create_post [2, 4], create_visual [7, 1], render_cover [1, 2], admin_media_upload [6, 2], mark_topic_done [1, 0]
PASS
```

`scripts/blog_media_page_check.py` on the published page (Chromium, desktop 1280 px, phone 390 px):

- each visual: `sandbox="allow-scripts"` only, `loading=lazy`, `tabindex=-1`, `aria-hidden`,
  0 px border, `pointer-events:none`; scales with the column (658 px wide on desktop,
  358 px on the phone, exact aspect ratio); no scrollbar inside; a click in the middle
  lands on the `<figure>`; alt in `.sr-only`; caption under the box.
- scrolled off screen → both visuals report `paused`; back on → running; reduced motion →
  paused with 0 running animations, the clip not autoplaying (poster + controls).
- the clip: `autoplay` (set by the client), muted, loop, playing, poster, first one
  `preload=metadata`.
- every content image has alt text (the only empty alt is a related-post card's cover,
  decorative by design next to its linked title).
- JSON-LD: `image` = [cover, library screenshot], one `VideoObject` (name, contentUrl,
  thumbnailUrl, uploadDate, `PT5S`), no visual URL. No console errors.
- CLS: 0 on load. While scrolling the only layout shifts come from the site's own header
  condensing (`.hdr__bar`) and its scroll timeline (`.stl__playhead`) — none from a
  visual, image or clip.
- **6 visuals, 3 animated, mid-range phone** (412×869 @2.625, mobile + touch, CPU 4×
  slower through CDP), scrolling the whole article: median frame 16.7 ms, p95 18–32 ms
  over two runs, 0 frames over 50 ms, **0 long tasks**, CLS 0.

Screenshots: `cover.webp`, `visual-1.png`, `visual-2.png`, `page-desktop-*.png`,
`page-mobile-visual.png`, `video-frame.png`, `perf-phone.png`, `page-check.json` (in the
`--out` folder).

### OAuth + posting (local, 2026-10-01)

`backend/scripts/blog_mcp_e2e.py` drives the **official MCP SDK client with its
OAuth provider** against a real uvicorn API (`API_PUBLIC_URL=http://localhost:8010`,
scratch database, no bucket) plus a mock site on `127.0.0.1:3999`. The consent
click is replaced by the same admin API call the consent page makes, with a
temporary admin signed in through the database (local databases only). Output:

```text
blog MCP e2e against http://localhost:8010/mcp
  ✓ POST /mcp without a token → 401, WWW-Authenticate: Bearer error="invalid_token", error_description="Authentication required", scope="blog:write", resource_metadata="http://localhost:8010/.well-known/oauth-protected-resource/mcp"
  ✓ protected resource http://localhost:8010/mcp → authorization server http://localhost:8010
  ✓ AS metadata: PKCE ['S256'], registration http://localhost:8010/mcp/oauth/register
  ✓ /authorize → 302 to the admin consent page http://localhost:3011/connect
  ✓ consent shows client 'Noey blog e2e' returning to claude.ai
  ✓ admin approved → redirect to https://claude.ai/api/mcp/auth_callback with code, state and iss=http://localhost:8010
  ✓ DCR client 2ecdf5aa-08c6-4618-9346-d8451a7ab241 · token scope 'blog:write' · expires_in 3600s
  ✓ tools: create_post, get_post, get_site_info, list_categories, list_posts, list_tags, publish_post, unpublish_post, update_post, upload_image
  ✓ get_site_info: Noey Studio, 6 guides, 11 writing rules, prices mock
  ✓ list_posts: 0 existing posts
  ✓ upload_image → http://localhost:8010/blog/media/ef3965ab…aa25.webp (1600×900 WebP)
  ✓ create_post → {'slug': 'e2e-1790855302', 'status': 'draft', 'message': 'Saved as a draft. Call publish_post to publish.'}
  ✓ publish_post → published https://noeystudio.com/blog/e2e-1790855302
  ✓ GET /blog/posts/e2e-1790855302 → 200 · 12 min read · category editing-tips · Cache-Control public, max-age=60
  ✓ GET /blog/slugs contains e2e-1790855302
  ✓ mock site got POST /api/revalidate-blog {'slugs': ['e2e-1790855302']} with the bearer secret
PASS
```

The same chain runs in pytest without a server (`tests/test_blog_mcp.py::
test_end_to_end_create_publish_public_api_and_revalidate`, SDK client over an
in-process ASGI transport), alongside the OAuth tests (metadata, DCR allow-list,
PKCE wrong/missing/`plain`, foreign `resource`, single-use code, audience
separation between app/admin/MCP tokens, refresh rotation + reuse revocation,
admin revoke, password change) and the content/publish rules
(`tests/test_blog_service.py`, `tests/test_blog_validation.py`).

`blog_mcp_e2e.py` now also draws its cover with render_cover and adds a visual
(the picture rules apply to every post). Run it yourself:

```bash
cd backend
API_PUBLIC_URL=http://localhost:8010 ADMIN_URL=http://localhost:3001 \
BLOG_REVALIDATE_URL=http://127.0.0.1:3999/api/revalidate-blog BLOG_REVALIDATE_SECRET=e2e-secret \
S3_BUCKET= STRIPE_SECRET_KEY= uvicorn services.api.main:app --port 8010 &
python scripts/blog_mcp_e2e.py --api http://localhost:8010
```

## Maintenance notes

- `get_site_info` facts come from `backend/packages/blog/site_info.json`, extracted from noey-frontend by `python scripts/build_site_info.py` (Node ≥ 22.18). Re-run it whenever `site.ts`, `scope.ts`, `guide.ts`, `plans.ts` or `modes.ts` change; `test_site_info_json_matches_the_site` fails until you do.
- Categories are seeded by the migration; adding one is a new migration (data), never an MCP call.
- `/admin/blog/*` routes live in `routers/admin_blog.py`, included at the app's top level: the denial walk in `tests/test_admin_security.py` does not see the parent prefix of a router nested inside another router.
- `backend/packages/blog/brand.json` and `render_assets/brand/noey-mark.svg` come from the site via `python scripts/build_brand_info.py`; `tests/test_blog_media.py::test_brand_json_matches_the_site` fails until it is re-run after a palette or mark change.
- The cover renderer's dependencies are pinned by `backend/cover_renderer/package-lock.json`. To bump: `cd backend/cover_renderer && npm install --save-exact <pkg>@<version>`, run `tests/test_blog_cover.py` (Thai rendering, timeouts, RAM), commit the lockfile. Local tests need `npm ci` there once; without it the cover tests skip and `render_cover` answers "renderer unavailable".
- Fonts: `render_assets/fonts/*.ttf` (static, for covers — Noto Sans Thai instanced from the variable font with fontTools) and `fonts/web/*.woff2` (for visuals); `fonts/cover-coverage.json` lists the code points the cover fonts draw (regenerate it with fontTools if a font changes).
