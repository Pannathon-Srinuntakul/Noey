# Error monitoring (Sentry)

Written 2026-09-30. Backend: `backend/packages/core/monitoring.py`, called from
`services/api/main.py:create_app` (service tag `api`) and
`services/worker/__main__.py` (service tag `worker`). Tests:
`backend/tests/test_monitoring.py`.

Docs used (fetched 2026-09-30):
<https://docs.sentry.io/platforms/python/integrations/fastapi/>,
<https://docs.sentry.io/platforms/python/integrations/arq/>,
<https://docs.sentry.io/platforms/python/configuration/options/>,
<https://docs.sentry.io/platforms/python/configuration/filtering/>,
<https://docs.sentry.io/platforms/python/data-management/sensitive-data/>,
<https://docs.sentry.io/concepts/key-terms/dsn-explainer/>.

## When it reports

Only when `SENTRY_DSN` is set, and never under pytest or with
`LOADTEST_FAKE_AI=1` (a load test would flood the project with fake-vendor
noise). Startup logs `monitoring_on` / `monitoring_off` with the reason.

What reaches Sentry:
- API: every unhandled exception (a 500) via the auto-enabled FastAPI /
  Starlette integration.
- Worker: every arq job that raises (auto-enabled arq integration).
- Both: every structlog line at `error` / `critical` (`forward_errors_to_sentry`
  in `packages/core/logging.py`) — most failures here are caught and logged
  (a job ending in status `error`), so without this they would never reach
  Sentry. Fields ride as `extra`, fingerprinted by the event name.

## Privacy

`send_default_pii=False`, `max_request_body_size="never"`,
`include_local_variables=False`, and `scrub_event` as both `before_send` and
`before_send_transaction`: drops request body/cookies/env, drops
`Authorization`, `Cookie`, `X-Api-Key`, `Stripe-Signature` and forwarding/IP
headers, blanks every key that looks like a credential (token, secret,
password, cookie, api key, session, dsn, otp, signature, `code`, `state`…)
anywhere in the event, strips `token=`/`code=`/`state=` query values (also
inside messages), masks bearer tokens/JWTs and email addresses in text, and
keeps only `user.id`. Source-code context lines are kept (they are the repo's
code, which holds no secrets).

## Environment variables (api AND worker services)

| Variable | Default | Meaning |
|---|---|---|
| `SENTRY_DSN` | unset | The project's DSN. Unset → off. |
| `SENTRY_ENVIRONMENT` | `RAILWAY_ENVIRONMENT_NAME`, else `development` | Environment tag. |
| `SENTRY_RELEASE` | `RAILWAY_GIT_COMMIT_SHA` | Release tag. |
| `SENTRY_TRACES_SAMPLE_RATE` | `0` | Performance tracing share (0 = errors only). |

## Frontends (web editor, admin, marketing site)

They add their own Sentry SDKs. A DSN is public by design (it only allows
submitting events), so a browser build may carry it — as a build-time
variable (e.g. `VITE_SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`), optional, with the
SDK not initialised when it is empty. Use a separate Sentry project per
frontend. Keep `sendDefaultPii` off and do not enable Session Replay without
masking (the editor shows customers' footage and scripts).

CSP: the browser SDK POSTs to the DSN's host — `connect-src` must allow it
(e.g. `https://o<org>.ingest.<region>.sentry.io`, or `https://*.ingest.sentry.io`
/ `https://*.ingest.us.sentry.io` / `https://*.ingest.de.sentry.io` by
region). The web build derives its CSP from env (`VITE_BACKEND_URL`,
`VITE_UPLOAD_ORIGIN`), so add the ingest origin the same way. Alternatively the
SDK's `tunnel` option can post through our own origin (no CSP change, not
blocked by ad-blockers) — that needs a small proxy route, not built.

### Web editor (`web/`) — built

`web/src/lib/monitoring.ts`, initialised from `web/src/main.tsx` before the
first render. Build-time variables (Docker `ARG`s in `web/Dockerfile`, set on
the Railway "Noey Frontend" service):

| Variable | Default | Effect |
|---|---|---|
| `VITE_SENTRY_DSN` | empty | Empty = off: the SDK chunk is never fetched and the CSP names no ingest host. |
| `VITE_SENTRY_ENVIRONMENT` | `production` | Environment tag. |
| `VITE_SENTRY_RELEASE` | empty | Release tag (e.g. the commit SHA). |

`vite.config.ts` adds the DSN's origin to `connect-src` only when the DSN is
set, so it is a REBUILD, not a restart, like `VITE_BACKEND_URL`. SDK 11
(`@sentry/react`) no longer has `sendDefaultPii`; its `dataCollection` option is
set to collect nothing optional (no user info, cookies, headers, bodies, query
strings or stack-frame variables), no tracing, no Session Replay. `scrubEvent`
/ `scrubBreadcrumb` also mask e-mail addresses, bearer tokens, JWTs and every
URL query (the Google callback URL carries a one-time `code` for a moment).
Use a separate Sentry project (platform: React) from the backend's.

Web owner check: rebuild with the DSN, open the editor, run
`setTimeout(() => { throw new Error('sentry test') })` in the browser console,
and confirm the event arrives with no e-mail, token or query string.

## Owner checklist

1. Create a Sentry project (platform: Python/FastAPI); copy its DSN.
2. Set `SENTRY_DSN` on the Railway **api** and **worker** services
   (optionally `SENTRY_TRACES_SAMPLE_RATE`).
3. Deploy; check the logs for `monitoring_on`.
4. Trigger a test error (e.g. temporarily hit a route that raises on a staging
   environment) and confirm the event has no request body, no Authorization or
   Cookie header, and `environment` / `release` set.
