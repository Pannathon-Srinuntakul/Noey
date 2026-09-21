# noey-frontend — Noey Studio marketing and account site

The public website for Noey Studio. It is built with Next.js 16 (App Router),
React 19 and TypeScript. Visitors use it to read about the product, sign up on
the free plan (no card), buy a monthly plan through Stripe Checkout and manage
their plan, card and profile. From here they open the editor web app
(`NEXT_PUBLIC_APP_URL`) with the same account.

The site holds **no secrets and no Stripe keys**. The FastAPI backend creates
every Stripe session and sends every email (SendGrid). This site is a
Backend-for-Frontend (BFF): browsers only ever talk to this site, and this
site's server talks to the backend.

- The design source is `website.dc.html` + `ds-styles.css` + `logo/`. The
  design's `support.js` and `image-slot.js` are not shipped.
- The site is Thai only (`lang="th"`, `og:locale` `th_TH`). It has light and
  dark themes.
- The UI, metadata, `llms.txt` and `pricing.md` never name an AI vendor. A unit
  test scans the source for vendor names.

---

## Quick start

Requirements: Node 22. For signed-in features, run the backend on
`http://localhost:8000` (see `backend/`). The editor web app runs on
`http://localhost:5174` (see `web/`).

```bash
cd noey-frontend
npm install
cp .env.example .env.local      # then edit (see "Environment")
npm run dev                     # http://localhost:3000
```

Without the backend, the marketing pages still work, with the design's prices
as a fallback. Sign-in, sign-up and the account area need the backend.

| Script | What it does |
|---|---|
| `npm run dev` | Dev server on port 3000 |
| `npm run build` | Production build (static marketing pages are prerendered here) |
| `npm run start` | Serve the production build on port 3000 |
| `npm run lint` | ESLint (`eslint-config-next`, including the React Compiler rules) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Vitest unit tests (`src/**/*.test.ts`) |

## Environment

`NEXT_PUBLIC_*` values are **inlined at build time**. After you change one, run
the build again. `next build` prints a warning when one of them is missing.

| Variable | Needed | Default | Purpose |
|---|---|---|---|
| `NEXT_PUBLIC_SITE_URL` | production | `https://noeystudio.com` | Public origin. Drives canonicals, the sitemap, `og:url`, JSON-LD and `robots.txt`. It is also an allowed `Origin` for Route Handler POSTs. |
| `API_URL` | yes | `http://localhost:8000` | The FastAPI backend. Only this site's server calls it. On Railway, use the **private network** address (see "Visitor IP and rate limits"). |
| `NEXT_PUBLIC_APP_URL` | production | `http://localhost:5174` | The editor web app ("ไปที่แอป", "เปิดแอปตัดต่อ"). |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | optional | empty | Cloudflare Turnstile site key. When it is empty, no widget and no third-party script is rendered, and the backend decides whether a token is required (its `TURNSTILE_SECRET_KEY`). |
| `CONTACT_EMAIL` | optional | `hello@noeystudio.com` | The address shown under the contact form. It is also the `mailto:` fallback when the backend cannot send email (503). |
| `GOOGLE_SITE_VERIFICATION` | optional | empty | Content of the Search Console `<meta>` verification tag. |
| `BING_SITE_VERIFICATION` | optional | empty | Content of the Bing `msvalidate.01` tag. |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | multi-instance | — | A Next.js variable. Set the same value on every instance when you run more than one, or Server Actions fail across instances. |

Do not put Stripe keys or email-provider keys here. Those belong to the backend.

---

## Routes

| Path | Rendering | Indexed | Purpose |
|---|---|---|---|
| `/` | static, ISR 600 s | yes | Home: hero, how it works, modes, work sample, price cards, FAQ |
| `/examples` | static | yes | Example clip and how it was made |
| `/pricing` | static, ISR 600 s | yes | Plans, quota explainer, comparison `<table>`, FAQ |
| `/about` | static | yes | Story and the contact form (`#contact`) |
| `/signup` | static | yes | Free sign-up. `?plan=<tier>` goes straight on to Checkout. |
| `/login` | static | **noindex** | Sign-in and the "forgot password" dialog (`?forgot=1` opens it) |
| `/terms`, `/privacy` | static | **noindex while drafts** | Thai DRAFTS, visibly marked as drafts (`LEGAL_PAGES_ARE_DRAFTS` in `src/lib/site.ts`) |
| `/account` | dynamic | noindex, robots-disallowed | Summary: plan, quota, storage |
| `/account/quota` | dynamic | noindex | Real `/usage/me` numbers only |
| `/account/billing` | dynamic | noindex | Plan, card, upgrade and cancel dialogs, resume, portal |
| `/account/profile` | dynamic | noindex | Name, email change, password change, account-deletion pointer |
| `/checkout/success` | dynamic | noindex | Polls `/billing/me` until the webhook lands |
| `/reset-password?token=` | dynamic, `no-store` | noindex, robots-disallowed | New password from the emailed link |
| `/verify-email?token=` | dynamic, `no-store` | noindex, robots-disallowed | Confirms the emailed link server-side |
| 404 | static | noindex | Custom not-found page |
| `/robots.txt`, `/sitemap.xml`, `/manifest.webmanifest` | static | — | Crawling and PWA metadata |
| `/llms.txt`, `/pricing.md` | static, ISR 600 s | — | Machine-readable summaries for AI agents |
| `/opengraph-image` (+ per page), `/icons/*`, `/favicon.ico`, `/apple-icon`, `/icon.svg` | static | — | Generated at build time (no binaries in the repo) |
| `/api/contact` (POST) | route handler | — | Contact form, Origin-checked |
| `/api/auth/refresh` (GET) | route handler | — | Token refresh for server renders |
| `/api/billing/me` (GET) | route handler | — | The polling endpoint for `/checkout/success` |

`/account/*` and `/checkout/*` redirect to `/login?next=<page>` when there is no
session. A signed-in visitor who opens `/login` or `/signup` goes to `/account`,
or to the billing page with the plan they picked.

---

## Architecture

### Code map

```
src/
  proxy.ts                 Next 16 Proxy (formerly middleware): session gate + token refresh
  app/                     Routes (see above), Server Actions in app/actions/
    actions/auth.ts        login, signup, sign-out, forgot-password, reset-password
    actions/account.ts     profile name, change password, change email, resend verification
    actions/billing.ts     plan buttons, portal, cancel, resume
    api/                   Route Handlers: contact, auth/refresh, billing/me
  components/              UI: header/footer, price cards, forms, account panels, Dialog, MediaSlot
  lib/                     Pure, unit-tested logic (plans, billing decisions, session, SEO, JSON-LD, …)
  lib/server/              server-only: backend client, session cookies, prices, OG rendering
  assets/og/               Static Noto Sans Thai subsets for OG images (OFL)
```

### BFF: the browser never calls the backend

- `src/lib/server/api.ts` (`apiRequest`) is the **only** place that calls
  `API_URL`. It sends `Accept: application/json`, uses `cache: "no-store"` and
  a 10 s timeout, and **forwards the visitor's `X-Forwarded-For`**. A network
  failure comes back as `status: 0`, so callers can tell "backend down" (keep
  the session and show a calm error) apart from "401" (end the session).
- Writes run as **Server Actions**, which have Next.js's built-in CSRF check
  (Origin against Host). The one **Route Handler POST**, `/api/contact`, checks
  `Origin` itself (`src/lib/origin.ts`) and rejects a missing or foreign one.
- The static price list (`GET /billing/plans`) is fetched with plain `fetch`
  and ISR caching, because it is public and not tied to a visitor.

### Session

| Cookie | HttpOnly | Content | Lifetime |
|---|---|---|---|
| `noey_at` | yes | access JWT | the JWT's `exp` |
| `noey_rt` | yes | refresh JWT | the JWT's `exp` |
| `noey_si` | no | `1`, a hint that someone is signed in (no data) | as `noey_rt` |
| `noey_name` | no | display name for the header greeting | as `noey_rt` |

- Every cookie is `SameSite=Lax` and `Path=/`. It is `Secure` when
  `NODE_ENV=production`. **Tokens never reach client JavaScript.**
- The marketing pages are static. A tiny inline pre-paint script reads
  `noey_si` and `noey_name` (and the theme from `localStorage` key
  `noey-theme`). It sets `data-theme`, `data-auth` and a CSS variable before
  first paint. The header can then show the signed-in variant and the greeting
  with no hydration and no flash (`src/lib/prepaint.ts`, unit-tested).
- **Refresh.**
  1. `src/proxy.ts` refreshes an expired access token *before* a protected
     page renders. It sets the new cookies on the response and on the request,
     so the render already sees them.
  2. Server Actions and Route Handlers use `callWithRefresh`
     (`src/lib/auth-flow.ts`). It refreshes when the token is stale, and once
     more on a 401.
  3. A Server Component render cannot write cookies. When a render gets a
     401, it redirects through `GET /api/auth/refresh?next=`. That handler
     refreshes, checks the new token against `/auth/me` (so no redirect loop
     is possible) and goes back. When the backend is down, it answers with a
     503 page instead of redirecting.
- A change or reset of the password returns a new token pair. The cookies are
  replaced, and every other session is revoked by the backend (`tv` claim).
- `?next=` is always sanitised (`sanitizeNextPath`). It must be a same-site
  path, and never `//`, a scheme, `/login`, `/signup` or `/api/*`.
- Route Handler redirects use a **relative `Location`**
  (`src/lib/server/redirect.ts`). When the site is self-hosted behind a proxy,
  a handler's `request.url` is the internal listen address.

### Prices

`getPriceTable()` (`src/lib/server/prices.ts`) serves every surface that shows
a price: the cards, the `<table>`, the answer-first paragraph, the JSON-LD
`Offer`s, `/pricing.md`, `/llms.txt` and the upgrade dialog. The ISR pages
revalidate every 600 s. When `GET /billing/plans` fails:

- during `next build` or in dev, the design's prices are used (190 / 290 /
  930 / 1,890 THB, which equal the backend's mock catalog);
- at production runtime on an ISR page, the fetch throws, so Next.js keeps
  serving the last good page and never swaps real prices for mock ones;
- on dynamic account pages, the fallback prices are used.

### Security headers

The site sends these headers:

- on every response: `X-Content-Type-Options`, `Referrer-Policy:
  strict-origin-when-cross-origin`, `X-Frame-Options: DENY` and a restrictive
  `Permissions-Policy`;
- in production: HSTS, and a CSP that allows only `'self'`, Turnstile
  (`challenges.cloudflare.com`) and a form-action to Stripe Checkout and the
  portal (the no-JS path);
- on the token pages: `Referrer-Policy: no-referrer`.

`'unsafe-inline'` is needed for scripts, because static pages carry the
pre-paint script and JSON-LD and cannot use a per-request nonce. If the backend
ever uses a Stripe custom domain, add it to `form-action` in `next.config.ts`.

---

## Backend API contract (what this site calls)

Errors are FastAPI's `{"detail": …}`. Auth is `Authorization: Bearer <access>`.
The backend's own reference is in `docs/billing-stripe.md` §10 and
`docs/email-sendgrid.md` §6. Messages shown to users are Thai, from
`src/lib/messages.ts`; the backend's English `detail` is never shown.
**Any 429** shows "ส่งถี่เกินไป ลองใหม่อีกครั้งภายหลัง".

| Endpoint | Used by | Handling |
|---|---|---|
| `POST /auth/login` | login form | 401 wrong credentials · 403 account unusable · 422 · 429 |
| `POST /auth/refresh` | Proxy, `callWithRefresh`, `/api/auth/refresh` | 401/403 ends the session (cookies cleared, then `/login?next=`). Any other failure keeps the session. |
| `GET /auth/me` | account layout, profile, verify page | Uses `display_name` (nullable) and `email_verified` |
| `PATCH /auth/me` `{display_name}` | profile | Updates the greeting cookie too |
| `POST /auth/register` `{email, password, display_name?, turnstile_token?}` | signup | 201 TokenOut signs in. 403 (and 501, the legacy stub) shows a calm "registration closed" message. 409 email exists · 422 · 400 captcha · 429 |
| `POST /auth/forgot-password` `{email, turnstile_token?}` | forgot dialog | Always 202, with the neutral message "ถ้ามีบัญชีที่ใช้อีเมลนี้ เราส่งลิงก์ตั้งรหัสผ่านใหม่ให้แล้ว" · 400 captcha · 422 · 429 · 503 |
| `POST /auth/reset-password` `{token, new_password}` | `/reset-password` | 200 TokenOut: cookies set, then `/account?notice=password-reset`. 400 shows "ลิงก์หมดอายุหรือถูกใช้ไปแล้ว" and a link for a new one. 422 shows the password rule. |
| `POST /auth/verify-email` `{token}` | `/verify-email` (server-side) | 200 `{email, purpose}` shows the verify or change message. 400 shows expired, with a resend button when signed in. 409 means the address was taken meanwhile. 429 |
| `POST /auth/resend-verification` | banner, verify page | 202 sent · 409 already verified (page refreshes) · 429 · 503 |
| `POST /auth/change-email` `{new_email, current_password}` | profile | 202 shows "ส่งลิงก์ยืนยันไปที่อีเมลใหม่แล้ว" · 400 wrong password · 409 taken · 429 · 503 |
| `POST /auth/change-password` `{current_password, new_password}` | profile | **200 TokenOut, and the cookies are replaced** · 400 wrong current · 422 · 429 |
| `POST /contact` `{name, email, message, turnstile_token?, company}` | `/api/contact` | 202 success · 422 field errors · 400 captcha · 429 · 503 shows the `mailto:CONTACT_EMAIL` fallback. `company` is the honeypot and is passed through; the backend answers 202 and sends nothing. |
| `GET /usage/me` | account, quota | Only real fields are rendered |
| `GET /videos/storage` | account, quota | Used vs allowed bytes |
| `GET /billing/plans` | prices | See "Prices" |
| `GET /billing/me` | billing page, plan buttons, checkout poll | `billing_enabled: false`, 404 or 503 shows a calm "not configured" notice with pay buttons disabled |
| `POST /billing/checkout` `{lookup_key}` | plan buttons | 200 `{url}`: redirect to Stripe. 409: retry once via change-plan. 503/404: not configured. |
| `POST /billing/change-plan` `{lookup_key}` | plan buttons, upgrade dialog | 200 `{url}` (portal confirm page). 409: retry once via checkout. When both give 409 (for example, a downgrade is already scheduled), a specific message is shown. |
| `POST /billing/cancel`, `POST /billing/resume` | billing page | 200 re-renders the page in the same response · 409 · 503 |
| `POST /billing/portal` | card button | 200 `{url}` · 409 no customer yet |

Redirects the backend builds from its `SITE_URL`:

- Checkout success goes to `/checkout/success?session_id=…`. That page polls
  `/api/billing/me` every 2 s, for at most 30 s.
- Checkout cancel goes to `/pricing?checkout=canceled`, which shows a "nothing
  was charged" notice.
- The portal returns to `/account/billing`.
- A confirmed plan change returns to `/account/billing?plan_change=done`, which
  shows a notice. The notice says upgrades apply now and downgrades at period
  end, as the seed script sets up the portal.
- Email links go to `/verify-email?token=…` and `/reset-password?token=…`.

**Plan-button rule** (`decidePlanAction` in `src/lib/billing.ts`, unit-tested):

| Case | Action |
|---|---|
| Signed out | `/signup?plan=<tier>` |
| Billing not configured | Calm notice |
| Live subscription (`active`, `trialing`, `past_due`: the backend's `LIVE_STATUSES`), same tier | "Already on this plan", or "use resume" if it is ending |
| Live subscription, other tier | change-plan |
| No live subscription | checkout |

"เริ่มใช้ฟรี" always goes to `/signup`.

### Visitor IP and rate limits

The backend rate-limits per IP. It reads the IP from `X-Forwarded-For`,
`TRUSTED_PROXY_HOPS` entries from the right. Every BFF call forwards the
chain it received, unchanged. This covers Server Actions, page renders, the
Proxy's refresh and the contact route. When no proxy is in front of Next.js,
Next.js adds the socket address itself. For this to be correct in production:

- Call the backend over **Railway's private network**
  (`API_URL=http://<api-service>.railway.internal:<PORT>`). If the BFF goes
  through the API's public domain, the edge replaces the header, and every
  visitor shares the BFF's IP.
- Set `TRUSTED_PROXY_HOPS` on the backend to the number of proxies in front of
  **this** site: 1 for Railway's edge, plus 1 for a CDN. Browsers that call the
  API directly (the web app) pass through the API's own edge. Keep both paths
  at the same hop count.

---

## User flows

- **Sign-up.** The name is optional; email and password are required. The
  password must be at least 8 characters and at most 72 UTF-8 bytes (about 24
  Thai letters), as the backend requires. The form checks the rule first and
  shows a Thai message. Turnstile appears only when a site key is set.
  - Success signs the visitor in.
  - With `?plan=<paid tier>`, sign-up goes straight to Checkout. If Checkout
    cannot start, the visitor goes to `/account/billing?plan=…&from=signup`
    with an explanation.
  - Otherwise sign-up goes to `/account`. It shows the verify-email banner:
    "ยืนยันอีเมลเพื่อเริ่มใช้งาน AI — เราส่งลิงก์ไปที่ <email> แล้ว".
- **Verify email.** The banner shows only while `email_verified === false`. It
  blocks nothing on this site; the backend gates the AI endpoints. Its resend
  button calls `/auth/resend-verification`.
  - `/verify-email` sends the token once, server-side, and never logs it.
  - A used link for an account that is signed in and already verified shows
    "อีเมลนี้ยืนยันแล้ว" rather than "expired". This is because link-preview
    scanners can open the link before the person does.
- **Forgot and reset password.** "ลืมรหัสผ่าน" opens the design's in-app
  dialog. It always shows the neutral 202 message. The reset page asks for the
  new password and a confirmation. Success signs the visitor in, and
  `/account` confirms it with a notice.
- **Change email.** The new address and the current password are required. The
  address changes only after the visitor opens the link sent to the new
  address.
- **Change password.** Replaces this browser's cookies with the new pair.
  Other browsers are signed out.
- **Billing page.** Shows the plan card with a status line: renewal date,
  scheduled end, "card failed" for `past_due`, or "lapsed" for `unpaid`,
  `paused` and `incomplete`.
  - The upgrade and change dialog lists the plans with live prices. The
    current plan is disabled, and the next tier up is preselected.
  - The cancel dialog closes on success. Resume is available while
    `cancel_at_period_end` is true.
  - The card button opens the portal. A free user's "เพิ่มบัตรเครดิต" opens
    the upgrade dialog.
- **Contact** (`/about#contact`). JavaScript posts JSON. Without JavaScript,
  a plain form POST gets a 303 back to `/about?contact=<outcome>#contact`.
  - The form has a hidden honeypot and length limits (name ≤ 100, message
    10–4000).
  - Success shows only after the backend returns 202. It is never faked.
- **Theme.** The toggle stores `noey-theme` in `localStorage`. Without a
  stored value, the site follows `prefers-color-scheme`. The theme is applied
  before paint, so there is no flash.
- **Dialogs.** All dialogs use the native `<dialog>` element with the design's
  `.dialog` style (`src/components/ui/Dialog.tsx`). The site never uses
  `window.confirm`, `alert` or `prompt`.

---

## SEO, AEO and GEO decisions

- **One intent per page.** Each indexable page has its own Thai title (60
  characters or fewer) and description (160 characters or fewer). Each has an
  absolute self-canonical, Open Graph and Twitter `summary_large_image` tags,
  and exactly one `<h1>`. The page registry in `src/lib/site.ts` is
  unit-tested for these rules.
- **OG images** are generated at build time with Noto Sans Thai.
  - Each of home, examples, pricing, about and signup has its own image; the
    other pages use the default.
  - Satori needs static TTF/WOFF files, and distinct family names, or it tries
    to fetch fonts from Google during the build.
  - Satori also drops tone marks stacked on Thai upper vowels. A test keeps
    the OG copy free of those combinations (`src/lib/og-copy.ts`).
- **JSON-LD** (`src/lib/jsonld.ts`) describes only what is visible on the page:

  | Page | JSON-LD types |
  |---|---|
  | Home | Organization (logo `/icons/icon-512.png`), WebSite, SoftwareApplication with Offers priced from the same table as the page, WebPage, FAQPage |
  | Pricing | WebPage, BreadcrumbList, SoftwareApplication, FAQPage |
  | Examples | CollectionPage, BreadcrumbList |
  | About | AboutPage, BreadcrumbList, Organization with contactPoint |
  | Legal pages | WebPage, BreadcrumbList |

  There is **no AggregateRating or Review** markup: no real ratings exist, and
  a test asserts this. There is no SearchAction either, because the site has no
  search.
- **Crawling** (`src/lib/crawl.ts`).
  - `robots.txt` allows everything except `/account`, `/checkout`,
    `/reset-password`, `/verify-email` and `/api`.
  - The search and AI crawlers are named explicitly: GPTBot, OAI-SearchBot,
    ChatGPT-User, PerplexityBot, ClaudeBot, Claude-SearchBot,
    Google-Extended, Bingbot and others. A named group replaces `*` for that
    crawler, so each group repeats the Disallow lines.
  - `sitemap.xml` lists only indexable pages, each with `lastModified`.
- **noindex.** These pages are noindex: `/login`, `/account/*`, `/checkout/*`,
  the token pages (also `nofollow`, `nocache` and no referrer), the 404 page,
  and `/terms` and `/privacy` while they are drafts. Set
  `LEGAL_PAGES_ARE_DRAFTS = false` once the lawyer-approved text is in; that
  also puts them in the sitemap.
- **Answer-first.** The home hero paragraph and the pricing lead paragraph each
  answer "what is it" and "what does it cost" in one quotable paragraph. The
  pricing page also has a real `<table>` with a caption, scopes and a price
  row. It shows a visible "อัปเดตล่าสุด" date (from `PAGES.pricing.updated`).
- **Machine-readable.**
  - `/llms.txt` gives a Thai and English summary, key facts and links.
  - `/pricing.md` is the Markdown twin of `/pricing`. The HTML page links to
    it with `<link rel="alternate" type="text/markdown">` and a `Link` header.
  - Both are ISR-refreshed from the live prices.
- **No RSS/Atom feed.** The site has no dated content, such as a blog or a
  changelog. An empty or fake feed would be worse than none. Add one only
  when real dated posts exist.
- **Performance.**
  - Marketing pages are static.
  - Client JavaScript covers only the theme toggle, forms and dialogs.
  - Every media slot reserves its aspect ratio, and fonts use `next/font`.
    Measured CLS is 0.028 or less on every page.
  - The only third-party script is Turnstile, loaded only when a site key is
    set. It loads on `/signup`, and on the contact and forgot-password forms
    when a field is first focused.
- **Thai and the AEO audit.** The audit script counts words by whitespace.
  Thai has no spaces between words, so it reports "thin content". With
  `Intl.Segmenter('th')`, the real counts are: home about 1,160 words, pricing
  about 860, terms and privacy about 700 each, examples, about, signup and
  login about 130–180.

### Keyword map

| Page | Primary query (Thai) | Supporting queries |
|---|---|---|
| `/` | ตัดคลิป TikTok ด้วย AI | ตัดต่อวิดีโอด้วย AI ในเบราว์เซอร์, ถอดเสียงไทยอัตโนมัติ, ใส่ซับไทยอัตโนมัติ, ตัดคลิปรีวิวสินค้า |
| `/examples` | ตัวอย่างคลิปรีวิวสินค้าที่ตัดด้วย AI | พากย์เสียงไทยด้วย AI, คลิปรีวิวสินค้า TikTok, โหมดพากย์ใหม่ |
| `/pricing` | ราคาแอปตัดต่อวิดีโอด้วย AI | แพลนฟรี ไม่ต้องผูกบัตร, ราคาตัดคลิป AI รายเดือน, เทียบแพลน |
| `/about` | Noey Studio (brand) | ติดต่อ Noey Studio, เครื่องมือตัดคลิปสำหรับครีเอเตอร์ |
| `/signup` | สมัครใช้งานแอปตัดคลิปฟรี | ตัดคลิปด้วย AI ฟรี ไม่ต้องผูกบัตร |
| `/login`, legal, account | — (navigational or noindex) | — |

### Copy changes against the design

268 of the design's 292 Thai text blocks are used word for word. Every
difference is listed here:

1. **Home `<title>`.** The design's single long title became per-page titles
   of 60 characters or fewer. The home title is "ตัดคลิป TikTok ด้วย AI ในเบราว์เซอร์ | Noey Studio".
2. **Hero paragraph.** It now reads "ห้องตัดต่อ**วิดีโอด้วย AI**" and ends
   "ดาวน์โหลดไปลง **TikTok ได้เลย**", so the answer-first sentence carries the
   main query.
3. **"ดูทั้งหมด"** became "ดูตัวอย่างงานทั้งหมด", which is descriptive link
   text.
4. **Breadcrumb eyebrows** ("หน้าแรก › …") were added to the inner pages.
5. **Pricing.**
   - A new answer-first paragraph lists the live prices.
   - A new "อัปเดตล่าสุด" line was added.
   - The comparison table gained a price row.
   - The design's quota illustration is labelled "ตัวอย่างการแสดงผล", because
     it is not anyone's real usage.
6. **Google sign-in and sign-up buttons** and the "หรือสมัครด้วยอีเมล" divider
   were removed, because the backend has no OAuth.
7. **Login side panel.** "เห็นทั้งโควตารอบ 5 ชั่วโมงและเพดานรายสัปดาห์เป็นเปอร์เซ็นต์"
   became "เห็นโควตาที่ใช้ไปในรอบปัจจุบันเป็นเปอร์เซ็นต์ พร้อมสัดส่วนงานแต่ละประเภท".
   The first version described meters the backend does not provide.
8. **Signup** shows a tag for the chosen plan when it arrives with `?plan=`.
9. **Account.**
   - The design's sample user "คุณนอย" is now the real display name.
   - The quota tab shows only real `/usage/me` data. The design's 5-hour and
     weekly meters, reset countdowns and weekly task counts were removed. A
     code comment explains why.
10. **Billing.**
    - Buttons and status lines have state-aware variants: upgrade or change,
      cancel or resume, renewal or end date, card failed, lapsed, and not
      configured.
    - The dialog radio labels show live prices.
    - The cancel text gained the end date.
11. **Profile.**
    - The email is editable: new address and current password.
    - Account deletion is a line pointing to "ช่องทางติดต่อ", because the
      backend has no deletion endpoint.
12. **New copy.** These texts were written for this site: the 404 page,
    `/reset-password`, `/verify-email`, `/checkout/success`, the verify banner
    (text from the contract), the password-reset notice, the plan-change and
    checkout-canceled notices, and every error message in
    `src/lib/messages.ts`.

---

## Media the owner must supply

The six design `<image-slot>`s are `MediaSlot`s. They are registered in
`src/lib/media.ts`. Until a file is set, each one shows a branded placeholder
at the right aspect ratio. To add a file:

1. Put the file in `public/media/`, or on a CDN (then add it to
   `images.remotePatterns`).
2. Set `src` and `alt` for the slot, and `poster` for a video.

| Slot | Where | Ratio | Needed |
|---|---|---|---|
| `heroClip` | Home hero | 9:16 video | A finished vertical clip cut from several raw files (MP4/WebM + poster JPG) |
| `stepImport` | Home, step 1 | 4:3 image | Screenshot: dragging footage into a project |
| `stepStyle` | Home, step 2 | 4:3 image | Screenshot: choosing length, cut style and voice |
| `stepTimeline` | Home, step 3 | 4:3 image | Screenshot: preview + timeline editor |
| `homeWork` | Home, work sample | 9:16 video or cover | A product-review clip made in voiceover mode |
| `examplesWork` | `/examples` | 9:16 video or cover | The same clip, or change the copy to match the real clip |

---

## Testing and verification

- **Unit tests.** There are 100 Vitest tests in 12 files. They cover plans and
  prices, billing decisions, session cookies, the refresh flow, contact
  mapping, formatting, the password rule, the pre-paint script, redirects, the
  ICO builder, the OG copy guard, and SEO. The SEO tests cover titles and
  descriptions, canonicals, OG image wiring, JSON-LD, `llms.txt` and
  `pricing.md`, the robots rules, the token pages and the vendor-name scan.
- **End-to-end checks** were run during development with Playwright against a
  contract-shaped mock backend. The mock is not shipped with the repo. 100
  checks passed. They covered:
  - every flow above;
  - cookie flags;
  - refresh and revocation;
  - `X-Forwarded-For` reaching the backend on actions, renders, the Proxy
    refresh and the contact route;
  - the token-page headers;
  - 429 handling.

---

## Deployment notes

- Build with the production `NEXT_PUBLIC_*` values set. Start with
  `npm run start`, which listens on port 3000. On Railway, point the service's
  target port at 3000.
- Set `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` when you run more than one instance.
  The ISR cache belongs to each instance, which is fine for prices that are at
  most 10 minutes old.
- Use the private-network `API_URL` and the backend's `TRUSTED_PROXY_HOPS`, as
  described above.
- On the backend, `SITE_URL` must be this site's origin. The backend builds
  every email link and Stripe return URL from it.
- The repo-root `.gitignore` covers `node_modules/`, `.env*` and
  `*.tsbuildinfo`, but **not `.next/`**, which is about 130 MB of build
  output. Add `noey-frontend/.next/` (and `noey-frontend/next-env.d.ts`, if
  you want) before anything is committed.

## Owner to-dos

- [ ] Set the production env vars (see "Environment") and rebuild after any
      `NEXT_PUBLIC_*` change.
- [ ] Add `.next/` to the root `.gitignore`.
- [ ] Supply the six media files (see "Media the owner must supply").
- [ ] Confirm the `hello@noeystudio.com` mailbox exists. Confirm the "ตอบกลับภายในหนึ่งวันทำการ"
      promise under the contact form, or change it.
- [ ] Have a lawyer finish `/terms` and `/privacy`: fill every highlighted
      `[…]`, then set `LEGAL_PAGES_ARE_DRAFTS = false`. State whether prices
      include VAT.
- [ ] Align the pricing copy with the backend. The design promises 5-hour
      windows, weekly caps, footage lengths and project counts. The backend
      today enforces a token limit per period (`/usage/me`) and a storage
      allowance per plan. Check the free plan's token limit against the paid
      tiers too (`docs/billing-stripe.md` notes that free is 10M and starter
      is 2M today).
- [ ] Replace the placeholder example and about-page facts with real ones. Add
      `sameAs` profiles (TikTok, Facebook, …) to the Organization JSON-LD in
      `src/lib/jsonld.ts` once they exist.
- [ ] Add real social proof only when it exists: testimonials, customer counts
      or ratings. None are invented here.
- [ ] Enable Stripe email receipts. If Checkout or the portal use a custom
      domain, add it to the CSP `form-action`.
- [ ] Submit the sitemap in Google Search Console and Bing Webmaster Tools, and
      set the two verification variables.
- [ ] Decide on email-link scanners. `/verify-email` confirms on page load, as
      the contract says. A scanner that opens the link first uses up the
      token, and the person then sees "expired", with a resend button when
      signed in. Two fixes are possible: the backend treats a repeat by an
      already-verified user as success, or the page asks for one click before
      it confirms.
- [ ] Add an RSS feed only once dated content exists (blog or changelog).
