# Load testing Noey Studio

How many concurrent editor sessions the deployed stack (API + arq worker +
Postgres + Redis + object storage) serves — measured **without paying a single
AI vendor** and **without the load generator sitting on the owner's laptop**.

Three pieces:

| Piece | Where | What it does |
| --- | --- | --- |
| Fake AI | `backend/packages/llm/fake.py` (+ `LOADTEST_FAKE_AI`) | Every model call, Files-API upload and speech-to-text request returns a canned, parseable answer after a realistic delay. Nothing else is stubbed. |
| Seed | `backend/scripts/seed_loadtest.py` | Creates `lt-<n>@loadtest.noey.local` accounts on the pro / studio / max plans and (optionally) mints their tokens. |
| Load | `loadtest/k6/editor.js` + `loadtest/runner/Dockerfile` | One virtual user = one web editor session, driving the endpoints `web/src` really calls. |

---

## 1. Fake AI

`LOADTEST_FAKE_AI=1` replaces exactly three vendor round trips:

* `litellm.acompletion` inside `packages/llm/gateway.py` (both `acompletion` and
  `acompletion_stream_thinking`, the streamed path included — fake thinking
  chunks reach `on_thinking` like the real ones),
* the Anthropic / Gemini Files API upload + delete in `packages/llm/files.py`,
* the Scribe POST in `packages/video/elevenlabs_stt.py`.

Everything else is the real system: the verified-email gate, the plan
reservation (`packages/billing/runs.py`), the per-call budget guard, the Redis
vendor rate limits, the durable usage rows in `core.llm_usage_logs` /
`core.stt_usage_logs`, the arq queue, ffmpeg, Postgres, Redis and S3. A run
therefore exercises metering and billing for real — only the vendor's latency is
a `sleep` and its answer a canned one.

Answers are shaped per caller (detected from the response schema the caller
sends or a marker in its prompt), so every parser downstream accepts them:

| Caller | Fake answer |
| --- | --- |
| `dub_ai.generate_dub_edit_script_video` | Edit script with `clipBounds`, distinct short cuts inside each clip's REAL duration, `alternates` |
| `dub_ai.generate_dub_reedit_script_video` | The current script echoed back, scoped to the selected `voiceoverLineId`s |
| `dub_ai.plan_dub_timeline_cuts` | Timeline cuts summing to the voiceover length |
| `dub_ai.generate_dub_edit_script` (legacy frames) | One cut per sampled frame |
| `speech_select.select_scenes` / `select_highlights` / `trim_span_content` | Picks and per-sentence verdicts inside the transcript's real numbering |
| `effects_ai.generate_effects_placement` | `zoomPunches` / `transitions` / `sceneDrifts` |
| `effects_style` / `cut_style` distillation | A full observation checklist built from the schema |
| `elevenlabs_stt.transcribe_clip` | A Scribe reply sized to the WAV, with real pauses so the silence cut has something to do |

Token counts come from the guard's own input estimate (so a video call bills like
a video call) plus a per-caller output size, capped by any `max_tokens` the
guard set.

**It cannot run in production.** `Settings` refuses to load with
`LOADTEST_FAKE_AI` on when `RAILWAY_ENVIRONMENT_NAME`, `RAILWAY_ENVIRONMENT`,
`ENVIRONMENT` or `APP_ENV` says `production` / `prod`; the API and the worker
re-check at startup (`announce_fake_ai`, which also logs a loud banner), and
`fake.active()` re-checks before every faked call.

Tuning (seconds): `LOADTEST_FAKE_AI_DELAY_SEC` (default 75, the cut call),
`LOADTEST_FAKE_AI_JITTER` (0.3), `LOADTEST_FAKE_STT_DELAY_SEC` (15),
`LOADTEST_FAKE_UPLOAD_SEC` (2).

## 2. Accounts

```bash
cd backend
python scripts/seed_loadtest.py --count 200 --tokens     # create + mint tokens
python scripts/seed_loadtest.py --reset-usage            # clear their usage windows between runs
python scripts/seed_loadtest.py --remove                 # delete the accounts and their projects
```

Idempotent; refuses to run unless `LOADTEST_FAKE_AI=1` and nothing says the
environment is production. Passwords are random and written only to
`loadtest/.secrets/users.json` (mode 0600, never printed, never committed —
this repo has no git anyway). `--tokens` also writes `tokens.json` with an
access + refresh pair per account, minted exactly like `POST /auth/login`.

**Mind the token windows.** A fake analysis bills REAL tokens (that is the
point — metering and reservations must run), ~48k for the 8 s fixture clip. Each
plan's 5-hour window therefore allows about **7 runs on pro, 15 on studio, 53 on
max** before `POST …/analyze-video` answers 402 `limit_reached` — which k6 counts
as `starts_refused`, not a failure, but which stops measuring capacity. For a
long capacity run either seed far more accounts than VUs, run
`--reset-usage` between stages, or seed with `--plans enterprise` (unlimited
tokens, 5 concurrent jobs per account) and accept that you are then not
measuring the plan limits at all.

Use the tokens, not logins, for anything above ~50 VUs: login is rate-limited to
100 per IP per 15 minutes (`services/api/ratelimit.py`), and a single runner is
a single IP — you would be measuring the rate limiter. Seed at least as many
accounts as the peak VU count, or several VUs share a user and pile up on that
plan's job concurrency (pro 2, studio 3, max 5).

## 3. The load

`k6/editor.js` — each VU loops one editor session:

1. `GET /auth/me`, `GET /usage/me`, `GET /videos?limit=200&offset=0`, `GET /effect-styles?kind=cut`
2. `POST /usage/estimate` (the wizard's preview)
3. `POST /videos/local` → project uid
4. `GET /videos/{uid}/files`, `PUT …/files/project.json`, `PUT …/files/normalized/clip0.mp4`
5. `POST /videos/{uid}/analyze-video` with the 8 s 270×480 proxy in `fixtures/clip0.mp4` + manifest → `job_id`
6. `GET /jobs/{job_id}` every `POLL_SEC` until `ok` / `error` / `JOB_TIMEOUT_SEC`
7. `GET /videos/{uid}/edit-script`, `PATCH …/local-status`, three ranged `GET …/files/normalized/clip0.mp4`
8. idle browsing for `IDLE_SEC` with think time, then `DELETE /videos/{uid}` (`CLEANUP=0` to keep them)

Metrics: `job_queue_wait` (start → the job stops being queued/waiting for a plan
slot), `job_run_time`, `job_total_time`, `jobs_completed` / `jobs_failed` /
`jobs_timed_out`, `starts_refused` (402/429/503 — the product refusing, not a
failure), and per-endpoint request counts, error rate and p50/p90/p95/p99.

The summary is one line on stdout: `LOADTEST_SUMMARY {…}` (plus `SUMMARY_FILE`
if set), so it can be read out of Railway logs.

Regenerate the fixture clip (already committed-in-place, ~100 KB):

```bash
cd loadtest/fixtures
ffmpeg -v error -y -f lavfi -i "testsrc=size=270x480:rate=30" -f lavfi -i "sine=frequency=440:sample_rate=44100" \
  -t 8 -c:v libx264 -preset veryfast -crf 32 -pix_fmt yuv420p -c:a aac -b:a 64k -ac 1 -movflags +faststart clip0.mp4
```

### Run it locally (smoke)

```bash
docker compose up -d postgres redis
cd backend
export LOADTEST_FAKE_AI=1 LOADTEST_FAKE_AI_DELAY_SEC=2 LOADTEST_FAKE_STT_DELAY_SEC=1
export GEMINI_API_KEY= ELEVENLABS_API_KEY= S3_BUCKET=          # a leak fails instead of billing
uvicorn services.api.main:app --port 8011 &
python -m services.worker &
python scripts/seed_loadtest.py --count 3 --tokens

cd ../loadtest
docker run --rm -v "$PWD":/lt -v "$PWD/.secrets":/secrets:ro -w /lt/k6 \
  -e BASE_URL=http://host.docker.internal:8011 -e TOKENS_FILE=/secrets/tokens.json \
  -e RAMP=3 -e RAMP_SEC=5 -e HOLD_SEC=55 -e IDLE_SEC=10 -e JOB_TIMEOUT_SEC=120 \
  grafana/k6 run --quiet editor.js
```

### Run it on Railway (the real measurement)

The runner is a service in a **new `loadtest` environment** — never in
`production`, and never the owner's laptop as the generator.

1. Duplicate the environment (API + worker + Postgres + Redis) into `loadtest`.
2. Set on the API **and** the worker: `LOADTEST_FAKE_AI=1`, a `JWT_SECRET` of its
   own, its own storage bucket, and empty vendor keys (`GEMINI_API_KEY`,
   `ELEVENLABS_API_KEY`) so a missed call fails loudly instead of billing.
3. Seed the accounts against that database (`railway run --environment loadtest
   python scripts/seed_loadtest.py --count 500 --tokens` from `backend/`).
4. Deploy this folder as a runner service built from `runner/Dockerfile`, with
   `BASE_URL` = the loadtest API's domain and `TOKENS_B64` =
   `base64 < .secrets/tokens.json`. Keep the token blob small — a few hundred
   accounts is ~100 KB; past that, mount the file instead.
5. Start the run, then read the summary out of the logs:
   `railway logs --service loadtest-runner | grep LOADTEST_SUMMARY`.

Watch the API and worker metrics (CPU, memory, DB connections) next to the
summary: the number the test produces is "concurrent sessions at this ramp with
these service sizes", and it means nothing without what the containers were
doing at the time.
