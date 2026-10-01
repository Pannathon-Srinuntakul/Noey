# Blog MCP server — let Claude write noeystudio.com articles

A scheduled task in claude.ai writes an SEO article every two days and posts it
to noeystudio.com through a **Remote MCP server** added as a **custom
connector**. The owner monitors and can take any article down at any time from
the admin dashboard (tab **บทความ**).

Code: `backend/services/mcp/server.py` (MCP server, mounted inside the API
process), `backend/packages/blog/` (rules, OAuth, images, revalidation),
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
- `create_post({...})` — always a **draft**, `source = "ai"`. Validates: contract lengths, unique slug, Markdown with no raw HTML/script/iframe, headings from `##`, images only from the blog media store, ≥ 2 internal links, ≥ `BLOG_MIN_WORDS` words (Thai segmented), category exists (categories are fixed), 3–6 FAQ, no AI-vendor names anywhere.
- `update_post(slug, changes)` — only posts with `source = "ai"`; the owner's posts (`source = "human"`, i.e. anything edited in the admin) are out of reach. `new_slug` only before the first publish.
- `publish_post(slug)` — refuses when the owner switched auto-publish off (answers "waiting for the owner") or the per-day cap (Asia/Bangkok calendar day) is used up (answers when it can publish next). Sets `published_at` the first time, locks the slug, revalidates the site.
- `unpublish_post(slug)` — takes a post offline (kept, never deleted). **There is no delete tool.**
- `upload_image(image_base64, filename, alt)` — PNG/JPEG/WebP by magic bytes, ≤ 8 MB, ≤ 4096 px; re-encoded to WebP (EXIF/ICC/XMP gone, longest side ≤ 1600 px), named by its SHA-256 → `{url, width, height}`.
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

Existing variables it relies on: `JWT_SECRET` (signs MCP tokens and derives
the key that encrypts confidential clients' secrets — rotating it disconnects
every connector), `REDIS_URL`, `S3_*`, `SITE_URL`, `TRUSTED_PROXY_HOPS`.

**Noey Dashboard** (admin): optionally `BLOG_MEDIA_PUBLIC_URL` = the media base
the API uses (e.g. `https://api.noeystudio.com/blog/media`) so the article
preview may load images (`img-src` gains exactly that origin). Its `API_URL`
and `ADMIN_URL` are unchanged.

**Noey Studio** (site): `BLOG_REVALIDATE_SECRET` (same value) and the existing
`API_URL` — per `BLOG_CONTRACT.md`. Its CSP / `next/image` must allow the media
origin (`https://api.noeystudio.com` with the default above).

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

## 4. Prompt for the scheduled task ("เขียนบทความทุก 2 วัน")

claude.ai → create a scheduled task (every 2 days) with the **Noey Studio blog** connector enabled, and this prompt:

```text
คุณคือผู้เขียนบล็อกของ Noey Studio (noeystudio.com) ใช้ตัวเชื่อมต่อ "Noey Studio blog" เท่านั้น ทำตามลำดับนี้ทุกครั้ง:

1. เรียก get_site_info แล้วอ่าน writing_rules, scope และ guides ให้ครบ ทำตามกฎทุกข้อ
2. เรียก list_posts (ทุกสถานะ ไล่ next_cursor จนหมด) และ list_categories / list_tags
   เลือกหัวข้อใหม่ 1 หัวข้อที่ครีเอเตอร์ TikTok Affiliate ไทยค้นหาจริง ซึ่ง "ไม่ซ้ำ" กับบทความที่มีอยู่
   และไม่ซ้ำกับคู่มือใน guides (ถ้าใกล้กับคู่มือ ให้ลิงก์ไปหาคู่มือแทนการเขียนซ้ำ)
3. ถ้าจะมีรูปประกอบ ให้ใช้เฉพาะรูปที่คุณสร้างหรือมีสิทธิ์ใช้ อัปโหลดด้วย upload_image (ต้องมี alt) แล้วใช้ url ที่ได้
4. เรียก create_post หนึ่งครั้ง:
   - slug ภาษาอังกฤษตัวเล็ก-ขีดกลาง, title/excerpt/meta ภาษาไทย ตามความยาวที่กำหนด
   - ย่อหน้าแรกตอบคำถามของหัวข้อตรง ๆ, ใช้หัวข้อ ## / ###, ย่อหน้าสั้น
   - ลิงก์ภายในอย่างน้อย 2 ลิงก์ (เช่น /pricing, /scope หรือหน้าใน guides) และปิดท้ายด้วย CTA ไป /signup
   - faq 3–6 ข้อ เป็นข้อความล้วน, เลือก category ที่มีอยู่, tags ไม่เกิน 8
   - ห้ามแต่งตัวเลข/สถิติ/รีวิวลูกค้า ห้ามอ้างความสามารถที่ scope บอกว่าทำไม่ได้ ห้ามเอ่ยชื่อผู้ให้บริการ AI
   ถ้าถูกปฏิเสธ ให้แก้ตามรายการที่ได้รับแล้วเรียกใหม่ (สูงสุด 3 ครั้ง)
5. เรียก publish_post กับ slug นั้น
   - ถ้าตอบว่ารอเจ้าของอนุมัติ หรือเกินเพดานรายวัน ให้หยุดและรายงาน ห้ามพยายามเลี่ยง
6. สรุปสั้น ๆ: หัวข้อ, slug, สถานะ, ลิงก์ และเหตุผลที่เลือกหัวข้อนี้
ห้ามแก้บทความที่ source เป็น human และห้ามถอนบทความใด ๆ เว้นแต่เจ้าของสั่ง
```

## 5. End-to-end result (local, 2026-10-01)

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

Run it yourself:

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
