# Security review — 2026-09-30

A security sweep across the backend, the web editor, the desktop app, the
marketing/account site (`noey-frontend/`), the owner admin (`admin/`) and the
infrastructure config. This file records every confirmed finding, what was
done about it and the test that proves the fix, what is still open, and how
many candidate findings were refuted.

Nothing from this sweep has been committed, pushed or deployed. No production
system or real third-party account was changed.

Severity scale: critical > high > medium > low > info. Several findings were
reported more than once by different reviewers; duplicates are merged below
and the merged ids are listed.

## Summary

Counts are per entry below (duplicates merged, filed under the highest
severity among the merged ids).

| Severity | Entries | Fixed | Partly fixed | Open |
|---|---|---|---|---|
| Critical | 2 | 2 | 0 | 0 |
| High | 2 | 2 | 0 | 0 |
| Medium | 7 | 6 | 1 | 0 |
| Low | 19 | 15 | 1 | 3 |
| Info | 5 | 3 | 1 | 1 |

Refuted during verification: 13 candidate findings (see the last section).

## Owner actions (things code cannot do)

1. **Review and untrack `backend/.env.production`.** It is tracked in git.
   `.gitignore` now covers `.env.*`, but ignoring does not untrack. Review the
   file, `git rm --cached backend/.env.production`, and rotate anything real
   it ever held.
2. **Test uploads reached the real bucket.** Before `tests/conftest.py` was
   changed to force `S3_BUCKET=""`, two early test runs of the existing
   `tests/test_transfer.py` pushed tiny objects to the bucket configured in
   `backend/.env` under `scratch/transfer/<random token>/`. The housekeeping
   sweep should reclaim that prefix; nothing else was written. The suite can no
   longer reach a real bucket.
3. **Set `ADMIN_IP_ALLOWLIST` in production** (Railway variable) — the code fix
   for the admin lock-out stands on its own, the allowlist closes the admin
   login surface entirely.
4. **Recreate the local datastore containers** (`docker compose up -d`) so the
   running `noey_redis` / `noey_postgres` pick up the loopback-only bindings.
5. **Verify the bucket enforces a signed `Content-Length`** on presigned PUTs
   (Railway Buckets / R2); see `presigned-put-unbounded-size`.
6. **Desktop release chain**: code-signing certificate, auto-update feed,
   Electron upgrade, and a release-only bucket key (see the open items).

## Critical

### upload-sources-rmtree-escape — FIXED
A user-writable `upload_sources.json` let `DELETE /videos/{uid}` (and account
deletion) `rmtree` the whole `DATA_DIR` or another user's project folder: the
manifest is writable through `PUT /videos/{uid}/files/upload_sources.json`, and
`_collect_project_dirs` joined its entries (e.g. `video_outputs/..`) under the
data root unchecked. Reproduced: a scratch `DATA_DIR` was emptied, including
other users' folders.

- Fix (`backend/packages/video/storage.py`): deletion no longer reads the
  client-writable manifest at all. Cross-project links come only from the
  database's `source_files`. Every folder name must fully match a strict
  pattern and resolve to exactly one level under `video_uploads/` or
  `video_outputs/`; this is re-checked immediately before each `rmtree`.
- Tests: `tests/test_delete_project_manifest.py::test_a_hostile_manifest_cannot_delete_data_dir_or_another_project`,
  `::test_source_files_cannot_escape_the_project_parents`,
  `::test_the_manifest_is_client_writable_so_its_cross_references_are_ignored`.
  `tests/test_video_storage.py` moved the legacy upload path from the manifest
  to `source_files`.

### s3-key-dotdot-worker-write — FIXED
`PUT /videos/{uid}/files/clips/a\..\..\..\..\X` passed `_web_file_path` (split
on `/` only); `push_output_file` translated `\` to `/`, producing the object key
`videos/{uid}/outputs/clips/a/../../../../X`; every worker task starts with
`pull_project_files`, which wrote that key outside the project folder. Proven
end to end against a local fake S3: an arbitrary file write on the worker,
which holds every secret (code execution after restart via a `.pth` or source
overwrite).

- Fix: `_web_file_path` (`routers/videos_local.py`) refuses backslashes and
  control characters (Thai names such as `music/เพลง (1).mp3` still pass).
  `packages/video/s3.py` no longer translates `\` to `/`; a new `safe_relpath`
  refuses empty, `.`, `..`, `\` and control-character segments; downloads skip
  any key that would resolve outside the target folder; uploads skip unsafe
  local names.
- Tests: `tests/test_s3_key_containment.py` (8 tests, including a traversal
  key already sitting in the bucket).

## High

### oauth-link-survives-reset-prehijack — FIXED
Pre-account takeover: an attacker registers the victim's address (no
verification gate), links their own Google identity, and that link survived the
victim's password reset, so Google sign-in with the attacker's `sub` returned
the victim's account.

- Fix (`routers/auth_google.py`, `routers/auth.py`): linking Google (start and
  callback) returns 403 `email_not_verified` until the email is verified.
  `reset_password` deletes every linked Google identity in the same transaction
  as the session revoke, and so does the first email verification.
- Behaviour change: a password reset unlinks Google; the user links again.
- Tests: `tests/test_google_oauth.py::test_an_unverified_account_cannot_link_google`,
  `::test_a_squatters_google_link_does_not_survive_the_owners_reset`,
  `::test_first_email_verification_drops_links_made_before_it`. The existing
  explicit-link test now uses a verified account.

### next-dot-segment-open-redirect — FIXED
`sanitizeNextPath` (`noey-frontend/src/lib/session.ts`) checked for `//` on the
raw input but returned the WHATWG-normalised pathname, so `/.//evil.com`,
`/..//evil.com/x` and `/%2e//evil.com` came back as `//evil.com`. Every sink
(proxy on `/login`, `/api/auth/refresh`, `loginAction`, Google callback) turned
it into an off-site redirect — zero-click for a signed-in visitor.

- Fix: the normalised path (the value actually returned) is re-checked; `//`
  or `/\` prefixes fall back to `/account`. All four sinks share the function.
- Test: `noey-frontend/src/lib/session.test.ts` — "rejects dot-segment paths
  that normalise to a protocol-relative URL" (`/.//evil.com`, `/..//evil.com/x`,
  `/%2e//evil.com`, `/%2E%2E//evil.com`, `/a/..//evil.com`). Fails on the old
  code. A local production build now redirects `GET /login?next=/.//evil.com`
  (signed in) to `/account`.

## Medium

### transfer-unauth-upload-no-quota / transfer-unbounded-storage / transfer-ticket-disk-dos — FIXED (merged)
Any account could mint unlimited phone-transfer tickets; each accepted
unauthenticated uploads of 20 × 4 GB outside the storage quota, kept on the API
volume until the sweep; the manifest update was an unlocked read-modify-write.

- Fix (`routers/transfer.py`, `ratelimit.py`): ticket creation limited to 6 per
  account per hour; phone uploads to 60 per IP per 15 minutes; a per-ticket
  byte budget = the plan's storage allowance capped at 16 GB (Free: 1 GB);
  507 when the data volume has under 2 GB free; at most 60 upload attempts per
  ticket; file names from a Redis slot counter and the manifest updated under a
  Redis lock that fails closed (503); the local copy is deleted after the S3
  push when a bucket is configured.
- Behaviour change: a Free-plan ticket relays at most 1 GB.
- Tests: 7 new tests in `tests/test_transfer.py`.

### plan-dub-no-slot — FIXED
Synchronous `POST /videos/{uid}/plan-dub` never took a concurrency slot, so N
parallel calls each saw the same quota snapshot and overspent the window; the
free-run counter was check-then-increment.

- Fix: `billing_start.acquire_inline_slot` takes the plan's slot; when busy the
  run is released and the route answers 429 `busy`. A per-account rule
  (30 / 15 min, fail-closed like the other paid-work rules). Free runs are
  counted atomically (increment, compare, give back on refusal).
- Tests: `tests/test_billing_start.py::test_parallel_plan_dub_calls_do_not_share_one_quota_snapshot`,
  `::test_free_runs_are_claimed_atomically_with_the_daily_cap`.

### presigned-put-unbounded-size — PARTLY FIXED
The presigned PUT bound neither size nor time tightly (1 h, any size up to
5 GB, reusable), bypassing the per-file cap and storage quota when
`/uploads/complete` was skipped or raced.

- Fix (`packages/video/s3.py`, `routers/videos_local.py`): the declared byte
  count is signed into the URL as `Content-Length` (the web client already
  sends `file.size`).
- Tests: `tests/test_direct_upload.py::test_the_declared_size_is_signed_into_the_url`,
  `::test_the_presigned_put_signs_content_length`.
- Open: (1) whether Railway Buckets / R2 enforce a signed `Content-Length`
  could not be verified offline — owner to confirm against the real bucket;
  (2) no sweep yet for objects that were signed but never completed.

### no-navigation-guard (desktop) — FIXED
A dropped `.html` file navigated the privileged window to `file://…` and the
preload bridge attached to it — the one concrete vector found for attacker
script in the renderer.

- Fix: `will-navigate` / `will-redirect` handlers in
  `desktop/app/src/main/index.ts` allow only the app's own `index.html` or the
  dev-server origin; document-level `dragover`/`drop` `preventDefault` in
  `renderer/src/main.tsx`. Recorded in `PARITY.md` as desktop-only.
- Test: `desktop/app/src/main/ipcGuards.test.ts` (`isAppNavigation`).

### ipc-openpath-exec (desktop) — FIXED
`projects:openFolder` passed an unvalidated `relPath` to `shell.openPath`;
combined with `projects:writeFile` it could write and launch a `.bat`.

- Fix: `openFolderTarget` resolves inside the project (`.` = root, escapes
  throw); directories open with `shell.openPath`, files are only revealed with
  `shell.showItemInFolder`.
- Test: `ipcGuards.test.ts` (`openFolderTarget`: `x.bat` → reveal,
  `../../..` throws).

### ipc-apifetch-arbitrary / desktop-apifetch-arbitrary-file-url / desktop-apiproxy-open-fetch — FIXED (merged; medium/low/info)
`api:fetch` was an unrestricted main-process HTTP client that read any
`formFiles` path and posted it to any URL, outside the renderer CSP.

- Fix: `vetApiFetchJob` (`desktop/app/src/main/ipcGuards.ts`) runs first —
  URL origin must be the configured backend (`VITE_BACKEND_URL` or the
  production default; `localhost`/`127.0.0.1` only when not packaged);
  `formFiles` must resolve (after realpath) inside the projects root or LAN
  inbox, or be a file the user picked (`fileGrants.ts`).
- Tests: `ipcGuards.test.ts` (`isAllowedApiUrl`, `vetApiFetchJob`: foreign
  host, `~/.ssh/id_rsa`, symlink escaping the library, user-picked file).

### ipc-unconstrained-paths (desktop) — FIXED for the visible surface
`importMusic` copied any file into the project (then served by `media://`);
sidecar jobs took arbitrary `projectDir` / output paths.

- Fix: `importMusic` accepts only audio/video extensions from user-picked or
  in-library paths (grants persisted in `userData/file-grants.json`, max 500,
  so a pending import survives a restart). `checkSidecarJob` requires
  `projectDir` to be a safe uid directly under the projects root and `output` /
  `outName` inside the project.
- Tests: `ipcGuards.test.ts` (`checkSidecarJob`, `hasMediaExtension`).
- Not covered: sidecar input paths (ingest must read source footage from
  anywhere), and the effects / proxy-one / filmstrip job schemas, which are not
  in this tree.

## Low

### job-id-prefix-collision — FIXED
Job ids used 32 bits of the uid (`vlocal_<uid[:8]>`), and the upsert re-stamped
`user_id` while keeping `tenant_id`.

- Fix: `local_job_id(uid)` = `vlocal_<full uid>` (and `style_<full uid>`); the
  upsert answers 409 instead of reassigning another account's row.
- Test: `tests/test_cross_user.py::test_a_job_id_never_re_stamps_another_accounts_row`
  (`test_resume.py`, `test_billing_start.py` updated to the new id format).

### admin-lockout-dos — FIXED (allowlist is an owner action)
Failed-login counting keyed on email alone let anyone keep the admin locked out.

- Fix (`routers/admin.py`): a valid remembered-device token bypasses the
  email-keyed lock and gets its own rate-limit bucket; without it the lock
  still applies.
- Test: `tests/test_admin_security.py::test_a_stranger_cannot_lock_the_admin_out_of_a_remembered_device`.
- Owner: set `ADMIN_IP_ALLOWLIST` in production.

### sub-dispute-keeps-plan — FIXED
A dispute or refund on a subscription charge was ignored.

- Fix (`packages/billing/webhooks.py`): a dispute on a non-top-up charge
  cancels the customer's subscriptions, re-syncs the plan and audits; a refund
  is audited only.
- Tests: `tests/test_billing.py::test_a_disputed_subscription_charge_cancels_the_plan_and_is_audited`,
  `::test_a_refunded_subscription_charge_is_audited_not_cancelled`.

### topup-chargeback-other-lots — FIXED (no schema change)
A spent, disputed top-up only logged the shortfall.

- Fix (`packages/billing/wallet.py`, `topup.py`): the shortfall is taken from
  the user's other live top-ups first; the rest becomes a debt entry that
  reduces the balance and blocks wallet spending; the next credit (including an
  admin `adjust`) pays the debt first.
- Tests: `tests/test_wallet.py::test_a_spent_disputed_top_up_is_clawed_back_from_other_lots_then_carried_as_debt`,
  `::test_debt_blocks_wallet_spending_until_it_is_paid`.

### refund-then-dispute-undercount — FIXED
- Fix: refunds and disputes are tracked separately, total capped at the lot.
- Test: `tests/test_wallet.py::test_a_dispute_after_a_partial_refund_reverses_the_whole_disputed_amount`.

### reversal-before-credit — FIXED
- Fix (`topup.py`): at credit time the charge is read back from Stripe and any
  refund/dispute already on it is reversed immediately. Behaviour change: one
  extra Stripe call per top-up credit; if it fails the webhook retries.
- Test: `tests/test_wallet.py::test_a_refund_processed_before_the_credit_is_applied_at_credit_time`.

### free-credit-farming — PARTLY FIXED
- Fix: `canonical_email` (`packages/auth/accounts.py`) strips `+tag` and folds
  Gmail dots; the first account per mailbox is remembered in the free-tier
  Redis store for a year, so aliases and delete/re-register do not mint new
  credit.
- Tests: `tests/test_free_tier.py::test_canonical_email_folds_aliases_of_one_inbox`,
  `::test_one_free_credit_per_mailbox_across_aliases_and_re_registration`.
- Open: requiring the device header (would break older desktop clients),
  failing closed when Redis is down (deliberately fail-open today), and a
  durable database record of granted identities. Catch-all domains remain
  possible; the per-IP limit is still the main control.

### verify-email-display-name-spoof — FIXED
- Fix: the display name is no longer used in mail to an unverified address
  (verification mail, reset mail for unverified accounts, change-email
  confirmation) — neither in the greeting nor the `To` display name.
- Test: `tests/test_email_flows.py::test_a_registrants_display_name_never_reaches_an_unproven_mailbox`.

### alembic-fileconfig-disables-uvicorn-logs — FIXED
- Fix: `main.py` runs migrations with `configure_logger=False`, which
  `packages/db/alembic/env.py` honours; the CLI keeps `fileConfig` with
  `disable_existing_loggers=False`; `alembic.ini`'s handler writes to stdout.
- Test: `tests/test_alembic_logging.py`.

### openexternal-unvalidated / desktop-openexternal-any-scheme — FIXED (merged; low/info)
- Fix: `setWindowOpenHandler` opens only `https:` to `checkout.stripe.com` /
  `billing.stripe.com`; everything else is denied and logged.
- Test: `ipcGuards.test.ts` (`isAllowedExternalUrl`: `file:`, `ms-msdt:`,
  `search-ms:`, `http:`, look-alike host).

### preload-electronapi-raw-ipc — FIXED
- Fix: `window.electron` exposes only `webUtils.getPathForFile` (which also
  registers a file grant); the raw `electronAPI` (any-channel ipcRenderer,
  `process.env`) is gone; `sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false`.
- Test: `desktop/app/src/preload/index.test.ts` (fails against the HEAD
  preload).
- Caveat: `sandbox: true` has not been run in a real packaged app — the
  desktop tree on the review machine is incomplete (see "Suites"). The preload
  imports only `electron`, so it should work sandboxed. Smoke-test before
  shipping. `@electron-toolkit/preload` is now unused but left in
  `package.json` to avoid a lockfile change.

### transfer-token-to-sentry — FIXED
- Fix (`web/src/lib/monitoring.ts`): `/transfer/<32hex>` is replaced with
  `/transfer/[Filtered]`, and `transaction` is scrubbed too.
- Test: `web/src/lib/monitoring.test.ts` ("masks the phone-transfer token…").

### desktop-csp-dev-origins — FIXED
- Fix: the `%DEV_ORIGINS%` `transformIndexHtml` plugin now lives in
  `desktop/app/electron.vite.config.ts` as on web; the packaged CSP no longer
  allows `localhost:8000`. Both clients match, so no parity note.
- Test: `desktop/app/src/main/cspDevOrigins.test.ts`.

### compose-exposed-datastores — FIXED
- Fix (`docker-compose.yml`): Redis and Postgres publish on `127.0.0.1` only;
  Redis supports an opt-in `REDIS_PASSWORD` (`requirepass`, healthcheck via
  `REDISCLI_AUTH`, api/worker `REDIS_URL` carry it); documented in
  `.env.example`. Empty password keeps today's local setup working.
- Tests: `tests/test_infra_config.py::test_compose_datastores_publish_on_loopback_only[redis|postgres]`,
  `::test_compose_redis_password_reaches_server_and_clients`.

### lock-without-hashes — FIXED
- Fix: `scripts/lock_requirements.py` writes `--hash=sha256:` for every pin
  (sdist + cp312/abi3/py3 wheels); `requirements.lock` regenerated with the
  same versions; `backend/Dockerfile` installs with `--require-hashes`; the
  unhashed `pip install --upgrade pip` was removed (the digest-pinned base's
  pip is used). The image was built and both entry points import inside it.
- Tests: `test_infra_config.py::test_backend_image_installs_the_lock_hash_checked`,
  `::test_every_locked_requirement_carries_a_hash`,
  `::test_lock_script_hashes_the_files_the_image_can_select[...]`.

### unpinned-base-images — FIXED
- Fix: every `FROM` in `web/`, `admin/`, `noey-frontend/` and
  `loadtest/runner/` Dockerfiles is pinned to a manifest-list digest, with a
  bump comment.
- Test: `test_infra_config.py::test_every_base_image_is_digest_pinned[...]`.

### web-refresh-token-localstorage — OPEN
The 14-day refresh token is in `localStorage`; the media service worker keeps
the access token in OPFS. No XSS was found (strict CSP, no HTML sinks). The
proper fix is backend-issued HttpOnly `SameSite=Strict` refresh cookies scoped
to `/auth/refresh`, which is a cross-cutting auth change for both clients —
deferred. Dropping the service worker's OPFS copy alone would break media
after a worker restart for almost no gain while the refresh token is in
`localStorage`.

### unsigned-no-update-old-electron / electron-vulnerable-version — OPEN (merged)
Unsigned per-machine NSIS installer, no auto-updater, default fuses, Electron
39.8.10 (npm audit: fixed at ≥ 41.10.6). Reachability of the listed advisories
is limited (all windows denied, strict CSP, no HTML sinks). Needs a
code-signing certificate, an update feed and an Electron upgrade verified with
`npm run build:unpack` on a machine with the complete desktop tree. The new CI
`audit` job runs the desktop audit with `continue-on-error` until the upgrade;
remove that flag afterwards.

### unsigned-installer-shared-bucket — OPEN
`desktop/app/scripts/upload-release.mjs` writes the public installer with the
same read-write bucket key the API and worker use. Needs a release-only key or
bucket (Railway) plus installer signing and a published SHA-256 — owner work.

## Info

### frontend-csp-unsafe-inline-on-dynamic-pages — FIXED
- Fix: `noey-frontend/src/lib/csp.ts` builds a per-request nonce policy
  (`'nonce-X' 'strict-dynamic'`, the pre-paint theme script allowed by hash)
  that `src/proxy.ts` sets on `/account/*` and `/checkout/*` in production;
  `next.config.ts` applies the static policy everywhere else, so no response
  carries two policies. Verified on a local production build: `/account/billing`
  returns exactly one CSP header, the nonce policy, and every script on the page
  is allowed.
- Test: `noey-frontend/src/lib/csp.test.ts` (8 tests).

### admin-signout-get-csrf — FIXED
- Fix (`admin/src/app/signout/route.ts`): cookies are cleared only when
  `isSameSiteNavigation(request.headers)` holds (as `/export` does); a
  cross-site GET still redirects to `/login` but clears nothing.
- Test: `admin/src/app/signout/route.test.ts` (3 tests; the cross-site test
  fails without the fix).

### ci-no-supply-gates — FIXED
- Fix (`.github/workflows/ci.yml`): `permissions: contents: read`; actions
  pinned to commit SHAs; backend installs with `--require-hashes`; new
  `desktop` (lint + vitest), `next` (noey-frontend + admin: typecheck, lint,
  test, build) and `audit` (`pip-audit`, `npm audit --omit=dev
  --audit-level=high`) jobs.
- Tests: `test_infra_config.py::test_ci_token_is_read_only`,
  `::test_ci_actions_are_pinned_to_commit_shas`,
  `::test_ci_audits_dependencies_and_checks_every_js_package`.

### committed-env-production — PARTLY FIXED (owner action)
`backend/.env.production` is tracked. `.gitignore` now ignores `.env.*` with
`!.env.example` (test: `test_infra_config.py::test_gitignore_covers_every_env_variant[...]`).
The file is still tracked and its contents were not read during the review;
the owner must review it, untrack it and rotate anything real.

### arq-pickle-serializer — OPEN
arq uses its default pickle job serializer; code execution would need write
access to Redis, which users do not have. The serializer must change on the
enqueue side (`services/api/arq_pool.py`, `services/worker/queue.py`, the
`create_pool` calls in `services/worker/tasks.py`) and the worker side
(`WorkerSettings` / `run_worker`) in one deploy, after draining pickled jobs
from Redis — deferred as a coordinated change rather than risk every queued job
failing to deserialize. Redis is now loopback-only locally and supports a
password.

## Refuted

13 candidate findings were refuted during verification (exploit path not
reachable, already guarded elsewhere, or behaviour working as designed). The
per-finding one-line reasons were not carried into this gate's input and are
not reproduced here; the verification transcripts hold them. Within the
confirmed findings, one sub-claim was also refuted: in
`transfer-ticket-disk-dos`, concurrent uploads do not exceed `MAX_FILES` — they
compute the same index and overwrite `file_NNN` (fixed anyway by the Redis slot
counter).

## Suites (final gate)

Run on 2026-09-30 against the working tree with every fix applied, the tests
kept at full strength (none skipped or weakened), and `S3_BUCKET=` so no test
could touch a real bucket.

| Suite | Command | Result |
|---|---|---|
| Backend tests | `cd backend && S3_BUCKET= pytest -q` | `1403 passed, 481 warnings in 134.53s (0:02:14)`; exit 0 |
| Backend lint (changed + new files) | `ruff check <changed .py>` | No new findings. New test files: `All checks passed!`. The 48 findings left in the changed files (B008 `Depends` defaults and similar) are the same per file and rule as at HEAD. One regression the fixes introduced, an unsorted import block in `services/api/main.py` (I001), was fixed with `ruff --select I001 --fix`, which also sorted the import block in `routers/videos_local.py`. |
| Web typecheck | `cd web && npm run typecheck` | exit 0 |
| Web lint | `npm run lint` | exit 0: `✖ 8 problems (0 errors, 8 warnings)`. The warnings are `react-hooks/exhaustive-deps` in files this sweep did not touch. |
| Web tests | `npx vitest run` | `Test Files 74 passed (74)`, `Tests 1507 passed (1507)` |
| Web build | `npm run build` | exit 0, `✓ built in 2.35s` (chunk-size advisory only) |
| Desktop lint | `cd desktop/app && npm run lint` | exit 0 |
| Desktop tests | `npm run test` | `Test Files 12 passed (12)`, `Tests 151 passed (151)` |
| noey-frontend | `npm run typecheck` / `lint` / `test` / `build` | all exit 0. Tests: `Test Files 21 passed (21)`, `Tests 215 passed (215)` |
| admin | `npm run typecheck` / `lint` / `test` / `build` | all exit 0. Tests: `Test Files 5 passed (5)`, `Tests 49 passed (49)` |

Known pre-existing failures that this sweep cannot fix, because the source is
not in the repository:

- **Desktop typecheck** (`npm run typecheck`, not part of the gate or of CI)
  exits 2 with 11 × TS2307. The desktop main-process modules `lanReceive`,
  `remoteAccess`, `notify`, `prefs`, `storage`, `unsavedGuard` and `tasteLog`
  have never been committed: `index.ts` and `media.ts` imported them at HEAD
  (9 errors). The fixes add two imports of `lanInboxDir` from `./lanReceive`
  (in `apiProxy.ts` and `projects.ts`). That is the same symbol `media.ts`
  already imports at HEAD, so no new unresolvable symbol was introduced. It
  resolves on the machine that has the complete desktop tree.
- **Desktop sidecar tests** (`cd desktop/sidecar && pytest tests/`): 8 pass
  and 4 files fail to collect with `ModuleNotFoundError: No module named
  'sidecar.atomic'`. `sidecar/atomic.py` has never been committed. The sweep
  did not touch the sidecar.
- Because of the missing desktop files, the Electron runtime changes
  (navigation guard, `sandbox: true`, IPC guards) are proven by unit tests
  only. Smoke-test them with `npm run build:unpack` on the complete tree before
  the next release.
