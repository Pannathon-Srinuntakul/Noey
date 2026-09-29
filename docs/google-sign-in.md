# Sign in with Google

Code: `backend/packages/auth/google_oauth.py` (protocol + the Google docs it was
written from), `backend/services/api/routers/auth_google.py` (routes + the
account-linking policy), tests `backend/tests/test_google_oauth.py` (Google
faked). Account deletion, which uses the Google re-auth for Google-only
accounts: `backend/packages/auth/account_deletion.py`.

## What the owner still has to do

1. Google Cloud Console → APIs & Services → OAuth consent screen: app name
   "Noey Studio", support email, the `openid email profile` scopes (all
   non-sensitive — no verification review needed), publish the app.
2. Credentials → Create OAuth client → **Web application**. Authorized
   redirect URIs — one per frontend, EXACTLY as the frontends send them:
   - marketing site: `https://<SITE_URL host>/auth/google/callback`
   - web editor: `https://<editor host>/auth/google/callback`
   - local dev (optional): `http://localhost:3000/auth/google/callback`,
     `http://localhost:5174/auth/google/callback`
3. Set on the API service (Railway): `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URIS` (the same URIs,
   comma-separated). The worker does not need them.
4. Test: `GET /auth/google/config` → `{"enabled": true, ...}`, then sign in
   from each frontend with a fresh Google account (creates an account), an
   address that already has a VERIFIED password account (links), and one whose
   account is unverified (refused with the "sign in with your password and
   link from settings" message).

Until step 3, every `/auth/google/*` route answers 503 with
`detail.code = "not_configured"` naming the missing variable, and
`/auth/google/config` says `enabled: false` so the frontends hide the button.

## Web editor (`web/`) — built

- Login screen: `GET /auth/google/config`; the "เข้าสู่ระบบด้วย Google" button
  appears only when `enabled` (`web/src/pages/LoginPage.tsx`).
- `redirect_uri` = `${location.origin}/auth/google/callback`; `state` is kept
  in `sessionStorage['noey.google']` (`web/src/lib/googleAuth.ts`). nginx's SPA
  fallback already serves `index.html` for that path.
- The return is handled once per page load in `web/src/lib/googleReturn.ts`:
  the query is stripped at once (`history.replaceState`), an `error` return
  never calls the API, the state is compared exactly, then
  `POST /auth/google/callback`.
- Settings → บัญชี (`web/src/components/settings/AccountSecurity.tsx`):
  เชื่อมต่อ Google (intent link) / ยกเลิกการเชื่อมต่อ (`DELETE /auth/google`), and
  ลบบัญชี (password, or intent reauth for a Google-only account; the wallet
  second confirmation; on 204 the browser's project copy is cleared).
- The desktop app has none of this yet — see `PARITY.md`.

## Flow

```
client ──POST /auth/google/start {redirect_uri, intent}──▶ API
       ◀── {authorization_url, state} ─────────────────────
client keeps `state` (HttpOnly cookie / sessionStorage), redirects the browser
browser ──▶ Google ──▶ <redirect_uri>?code=…&state=…   (or ?error=access_denied)
client checks state == kept state, then
client ──POST /auth/google/callback {code, state, redirect_uri}──▶ API
       ◀── tokens (signin) | {google_email} (link) | {reauth_token} (reauth)
```

PKCE verifier and nonce stay server-side (Redis, single use, 10 minutes);
`state` is a signed, expiring JWT naming that record. The ID token is verified
against Google's JWKS: RS256 signature, `iss`, `aud`, `exp`, `nonce`;
`email_verified` decides linking. Identities are keyed on Google's `sub`
(`core.oauth_identities`), never on email.
