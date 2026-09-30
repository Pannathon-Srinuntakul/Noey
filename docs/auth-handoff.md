# Sign-in handoff: one login for the site and the editor

Code: `backend/packages/auth/handoff.py` (the code store),
`backend/services/api/routers/auth_handoff.py` (routes), tests
`backend/tests/test_auth_handoff.py`; site: `noey-frontend/src/lib/editor-handoff.ts`
+ `src/app/api/editor/open/route.ts`; editor: `web/src/lib/handoff.ts` (wired in
`main.tsx` and `App.tsx`).

## Why

The account site (`www.noeystudio.com`, Next.js BFF: tokens in HttpOnly cookies
its server holds) and the web editor (`app.noeystudio.com`, Vite SPA: its own
tokens in browser storage) are different origins with different session
storage. Nothing is shared, so a user signed in on the site used to meet a
second login screen in the editor. The fix is the standard one for two apps on
different subdomains: a one-time handoff code. Not a shared parent-domain
cookie (the editor keeps its tokens in storage, and a `.noeystudio.com` cookie
would reach every subdomain), and never a token in a URL.

## Flow

1. Every "เปิดห้องตัดต่อ" button on the site links to `GET /api/editor/open`
   (a plain `<a>`, never a prefetching `<Link>`).
2. That Route Handler, when the visitor has a site session, calls
   `POST /auth/handoff {"target":"editor"}` server-side with the user's access
   token (refreshing it first if needed, like any authed site call) and answers
   `303 Location: ${NEXT_PUBLIC_APP_URL}/#handoff=<code>` with
   `Referrer-Policy: no-referrer`. No session, a cross-site start, or any
   failure → `303` to the plain editor URL (its own login screen).
3. The editor's `main.tsx` calls `captureHandoff()` before monitoring starts and
   before React renders: the code is read from the fragment and the fragment is
   removed with `history.replaceState`.
4. App's boot redeems it: `POST /auth/handoff/redeem {"code","target":"editor"}`
   → the same `{access_token, refresh_token, token_type}` `/auth/login` returns,
   then `/auth/me`, then the session is stored exactly like a login.
5. If the browser already held a session for a DIFFERENT account, the handoff
   wins: the old refresh token is revoked (`POST /auth/logout` with it), storage
   and the media service worker are cleared, and the per-account project store
   switches owner (`ensureStoreOwner`). A stored session of the SAME account is
   just replaced, not revoked, so an editor tab already open keeps working.
6. Any redeem failure shows the login screen with one Thai line
   (expired/used, offline, or rate limited). The stored session is not
   silently restored in that case — it might be another account than the one
   the person just came from.

## API contract

    POST /auth/handoff          Authorization: Bearer <access token>
        {"target": "editor"}  →  200 {"code": "<43 chars>", "expires_in": 60}
        401 no session · 422 unknown target · 429 · 503 store down

    POST /auth/handoff/redeem   (no credentials — the code is the credential)
        {"code": "...", "target": "editor"}  →  200 TokenOut (as /auth/login)
        401 unknown / expired / used / wrong target / account changed since
        422 malformed body · 429 · 503 store down

Rate limits (`services/api/ratelimit.py`, fail closed): `handoff_mint:account`
30 per 15 min, `handoff_redeem:ip` 60 per 15 min.

## Security properties

- **Random and short-lived**: 256 bits from `secrets.token_urlsafe(32)`, Redis
  `EX 60`. Guessing is hopeless; the redeem rate limit is flood hygiene.
- **Stored hashed**: the Redis key is `noey:handoff:<target>:<sha256(code)>`;
  the value is only `{uid, tv}`. A store dump holds nothing redeemable.
- **Single use, atomically**: redeem is `GETDEL`. Two concurrent redeems cannot
  both win; a code whose redeem then fails (e.g. the refresh store is down) is
  still spent.
- **Bound to the user, the session generation and the client**: the record
  carries the minting user's id and `token_version`; the key carries the
  target. Redeem re-checks `is_active`, `deleted_at IS NULL` and
  `token_version` (a password change or reset between mint and redeem, which
  signs out every session, voids the code), then issues through `auth._tokens_for` —
  the one function `/auth/login` and Google sign-in also end in (refresh
  token registered in the rotation store). No forked token logic.
- **Cross-user impossible**: minting takes no user argument — the code is
  always for the caller's own account. Redeem ignores any `Authorization`
  header, so a code can only ever sign in its minter; it never merges into or
  switches to the presenter's account.
- **Never in a server log or Referer**: the code travels only in the URL
  FRAGMENT, which browsers do not send to servers or put in `Referer`; the
  303 also carries `Referrer-Policy: no-referrer`. The editor strips the
  fragment before its error monitoring instruments history, and
  `web/src/lib/monitoring.ts` masks `handoff=<code>` in any text as a second
  line. The code is never logged by the API, site or editor.
- **Why the site route is a GET link, not a POST form**: it mints only for the
  session in the visitor's own cookie and sends the code only to the visitor's
  own browser. A cross-site page that triggers it achieves nothing beyond
  opening the victim's editor as the victim — it cannot sign anyone in as
  someone else (no login CSRF) and learns nothing (a cross-site `fetch` gets
  no `SameSite=Lax` cookie and cannot read the redirect). Minting has no other
  side effect. As defence in depth the route refuses to mint when
  `Sec-Fetch-Site: cross-site`. A link also keeps middle-click / new tab and
  no-JavaScript working. Because no FORM submission redirects to the editor,
  the site's CSP `form-action` list needs no editor origin.

## Not covered

- **Editor → site**: the editor has no links to the site's account pages
  (plan, billing and profile are managed inside the editor's own settings), so
  there is no reverse handoff. `packages/auth/handoff.py:TARGETS` and the
  router's `HandoffTarget` hold only `"editor"`; a `"site"` target would be redeemed server-side by the site and
  turned into its cookies if that ever changes.
- **Desktop app**: a separate Electron login, not a subdomain — no handoff.
  That is a platform difference, not drift (no PARITY row).
