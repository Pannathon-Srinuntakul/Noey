// Noey Studio load test — one virtual user = one web editor session.
//
// The request sequence mirrors what web/src actually sends for a dub_first
// project (lib/api.ts, lib/videosLocalApi.ts, lib/projectSync.ts,
// lib/useProjectPipeline.ts):
//
//   app open     GET /auth/me, GET /usage/me, GET /videos?limit=200&offset=0,
//                GET /effect-styles?kind=cut
//   wizard       POST /usage/estimate
//   start        POST /videos/local
//   import sync  GET /videos/{uid}/files, PUT files/project.json,
//                PUT files/normalized/clip0.mp4
//   analyze      POST /videos/{uid}/analyze-video (multipart proxy + manifest)
//   wait         GET /jobs/{job_id} every POLL_SEC until ok / error / timeout
//   result       GET /videos/{uid}/edit-script, PATCH local-status waiting_vo,
//                GET files/normalized/clip0.mp4 with Range (seek in the editor)
//   idle         think time + GET /usage/me + GET /videos list, IDLE_SEC long
//   cleanup      DELETE /videos/{uid} (CLEANUP=1, default) so runs are repeatable
//
// Run against a backend started with LOADTEST_FAKE_AI=1 — the analysis job
// then costs nothing (packages/llm/fake.py). See loadtest/README.md.
//
// Env:
//   BASE_URL        API origin (required), e.g. https://api-loadtest.up.railway.app
//   RAMP            VU targets per stage, "10,50,100,200,500"      (default "3")
//   RAMP_SEC        seconds to ramp to each target                  (default 30)
//   HOLD_SEC        seconds to hold each target                     (default 120)
//   POLL_SEC        job poll interval; the web app uses 2           (default 2)
//   JOB_TIMEOUT_SEC give up waiting for one job after this          (default 900)
//   IDLE_SEC        idle browsing after the job                     (default 60)
//   THINK_MIN/MAX   seconds between idle requests                   (default 5 / 15)
//   CLEANUP         1 = delete the project at the end               (default 1)
//   ENGINE/PRECISION quality tier sent with the run                 (default lite / standard)
//   Credentials (one of):
//     TOKENS_B64 / TOKENS_FILE  JSON list of {access_token?, refresh_token}
//                               (scripts/seed_loadtest.py --tokens)
//     USERS_B64 / USERS_FILE    seed file {users:[{email,password}]} — logs in
//                               (login is rate-limited to 100 / IP / 15 min)
//   SUMMARY_FILE    also write the JSON summary to this path

import http from 'k6/http'
import encoding from 'k6/encoding'
import { sleep } from 'k6'
import exec from 'k6/execution'
import { Counter, Rate, Trend } from 'k6/metrics'

const BASE = (__ENV.BASE_URL || '').replace(/\/+$/, '')
if (!BASE) throw new Error('BASE_URL is required')

const num = (name, def) => {
  const v = Number(__ENV[name])
  return Number.isFinite(v) && __ENV[name] !== '' && __ENV[name] !== undefined ? v : def
}
const POLL_SEC = num('POLL_SEC', 2)
const JOB_TIMEOUT_SEC = num('JOB_TIMEOUT_SEC', 900)
const IDLE_SEC = num('IDLE_SEC', 60)
const THINK_MIN = num('THINK_MIN', 5)
const THINK_MAX = num('THINK_MAX', 15)
const CLEANUP = (__ENV.CLEANUP || '1') !== '0'
const ENGINE = __ENV.ENGINE || 'lite'
const PRECISION = __ENV.PRECISION || 'standard'
const RAMP_SEC = num('RAMP_SEC', 30)
const HOLD_SEC = num('HOLD_SEC', 120)
const TARGETS = (__ENV.RAMP || '3')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => n > 0)

const CLIP_SEC = 8
const CLIP = open('../fixtures/clip0.mp4', 'b')

// ── credentials ──────────────────────────────────────────────────────────────
function loadJson(b64Var, fileVar) {
  if (__ENV[b64Var]) return JSON.parse(encoding.b64decode(__ENV[b64Var], 'std', 's'))
  if (__ENV[fileVar]) return JSON.parse(open(__ENV[fileVar]))
  return null
}
const TOKENS = loadJson('TOKENS_B64', 'TOKENS_FILE')
const USERS_DOC = loadJson('USERS_B64', 'USERS_FILE')
const USERS = USERS_DOC ? USERS_DOC.users || USERS_DOC : null
if (!TOKENS && !USERS) throw new Error('give TOKENS_B64/TOKENS_FILE or USERS_B64/USERS_FILE')
const ACCOUNTS = TOKENS || USERS

// ── metrics ──────────────────────────────────────────────────────────────────
const jobQueueWait = new Trend('job_queue_wait', true)
const jobRunTime = new Trend('job_run_time', true)
const jobTotalTime = new Trend('job_total_time', true)
const jobsCompleted = new Counter('jobs_completed')
const jobsFailed = new Counter('jobs_failed')
const jobsTimedOut = new Counter('jobs_timed_out')
const startsRefused = new Counter('starts_refused')
const sessions = new Counter('sessions_completed')
const apiErrors = new Rate('api_errors')

const ENDPOINTS = [
  'POST /auth/login',
  'POST /auth/refresh',
  'GET /auth/me',
  'GET /usage/me',
  'GET /videos',
  'GET /effect-styles',
  'POST /usage/estimate',
  'POST /videos/local',
  'GET /videos/{uid}/files',
  'PUT /videos/{uid}/files/*',
  'POST /videos/{uid}/analyze-video',
  'GET /jobs/{id}',
  'GET /videos/{uid}/edit-script',
  'PATCH /videos/{uid}/local-status',
  'GET /videos/{uid}/files/* (range)',
  'DELETE /videos/{uid}'
]

// A trivially-true threshold per endpoint makes k6 keep per-endpoint
// sub-metrics, so the summary can report p50/p95/p99 and errors per route.
const thresholds = {}
for (const e of ENDPOINTS) {
  thresholds[`http_req_duration{name:${e}}`] = ['max>=0']
  thresholds[`api_errors{name:${e}}`] = ['rate>=0']
}

const stages = []
for (const t of TARGETS) {
  stages.push({ duration: `${RAMP_SEC}s`, target: t })
  stages.push({ duration: `${HOLD_SEC}s`, target: t })
}
stages.push({ duration: '30s', target: 0 })

export const options = {
  scenarios: {
    editor: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages,
      // A session in flight finishes its job instead of being cut mid-poll.
      gracefulRampDown: `${JOB_TIMEOUT_SEC + IDLE_SEC + 60}s`,
      gracefulStop: `${JOB_TIMEOUT_SEC + IDLE_SEC + 60}s`
    }
  },
  thresholds,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  discardResponseBodies: false,
  noConnectionReuse: false,
  userAgent: 'noey-loadtest-k6'
}

// ── session plumbing ─────────────────────────────────────────────────────────
const state = { access: null, refresh: null }

function account() {
  return ACCOUNTS[(exec.vu.idInTest - 1) % ACCOUNTS.length]
}

function record(res, name, okStatuses) {
  const ok = okStatuses ? okStatuses.includes(res.status) : res.status >= 200 && res.status < 400
  apiErrors.add(!ok, { name })
  return ok
}

function signIn() {
  const acc = account()
  if (acc.refresh_token && !acc.password) {
    if (acc.access_token && !state.access) {
      state.access = acc.access_token
      state.refresh = acc.refresh_token
      return true
    }
    return refreshTokens(acc.refresh_token)
  }
  const res = http.post(`${BASE}/auth/login`, JSON.stringify({ email: acc.email, password: acc.password }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'POST /auth/login' }
  })
  if (!record(res, 'POST /auth/login')) return false
  state.access = res.json('access_token')
  state.refresh = res.json('refresh_token')
  return true
}

function refreshTokens(token) {
  const res = http.post(`${BASE}/auth/refresh`, null, {
    headers: { Authorization: `Bearer ${token || state.refresh}` },
    tags: { name: 'POST /auth/refresh' }
  })
  if (!record(res, 'POST /auth/refresh')) return false
  state.access = res.json('access_token')
  state.refresh = res.json('refresh_token')
  return true
}

// Every API call: bearer auth, one refresh-and-retry on 401 (like the web app).
function api(method, path, body, name, { headers = {}, ok = null } = {}) {
  const send = () =>
    http.request(method, `${BASE}${path}`, body, {
      headers: { Authorization: `Bearer ${state.access}`, ...headers },
      tags: { name },
      timeout: '120s'
    })
  let res = send()
  if (res.status === 401 && state.refresh && refreshTokens()) res = send()
  record(res, name, ok)
  return res
}

const json = (obj) => [JSON.stringify(obj), { 'Content-Type': 'application/json' }]

function think() {
  sleep(THINK_MIN + Math.random() * Math.max(0, THINK_MAX - THINK_MIN))
}

function browse() {
  api('GET', '/usage/me', null, 'GET /usage/me')
  api('GET', '/videos?limit=200&offset=0', null, 'GET /videos')
}

// ── one editor session ───────────────────────────────────────────────────────
export default function () {
  if (!state.access && !signIn()) {
    sleep(5)
    return
  }

  // App open.
  api('GET', '/auth/me', null, 'GET /auth/me')
  browse()
  api('GET', '/effect-styles?kind=cut', null, 'GET /effect-styles')
  sleep(2 + Math.random() * 3)

  // Wizard: the estimate preview (debounced once per settled form).
  let [body, headers] = json({
    mode: 'dub_first',
    engine: ENGINE,
    precision: PRECISION,
    clips: [{ duration_sec: CLIP_SEC, has_audio: true }]
  })
  api('POST', '/usage/estimate', body, 'POST /usage/estimate', { headers })

  // Start: create the server-side project.
  ;[body, headers] = json({
    mode: 'dub_first',
    brief: 'loadtest',
    user_script: null,
    target_duration_sec: null,
    engine: ENGINE,
    precision: PRECISION,
    clips: [{ id: 'clip0', durationSec: CLIP_SEC, width: 270, height: 480, fps: 30 }]
  })
  const created = api('POST', '/videos/local', body, 'POST /videos/local', { headers })
  if (created.status !== 201) {
    sleep(10)
    return
  }
  const uid = created.json('uid')

  // Import sync: the manifest, then what the server does not have yet.
  api('GET', `/videos/${uid}/files`, null, 'GET /videos/{uid}/files')
  const projectJson = JSON.stringify({ uid: `lt-${uid}`, mode: 'dub_first', step: 'analyzing', clips: [{ id: 'clip0', file: 'clip0.mp4', durationSec: CLIP_SEC }] })
  api('PUT', `/videos/${uid}/files/project.json`, { file: http.file(projectJson, 'project.json', 'application/json') }, 'PUT /videos/{uid}/files/*')
  api('PUT', `/videos/${uid}/files/normalized/clip0.mp4`, { file: http.file(CLIP, 'clip0.mp4', 'video/mp4') }, 'PUT /videos/{uid}/files/*')

  // Analyze: proxy upload + manifest → job id.
  const startedAt = Date.now()
  const start = api(
    'POST',
    `/videos/${uid}/analyze-video`,
    {
      manifest: JSON.stringify([{ clip_id: 'clip0', file: 'clip0.mp4', durationSec: CLIP_SEC, order: 0 }]),
      engine: ENGINE,
      precision: PRECISION,
      files: http.file(CLIP, 'clip0.mp4', 'video/mp4')
    },
    'POST /videos/{uid}/analyze-video',
    { ok: [202] }
  )
  if (start.status !== 202) {
    // 402 limit / 429 slot or rate / 503 paused: the product refusing, counted
    // apart from failures.
    if ([402, 429, 503].includes(start.status)) startsRefused.add(1, { status: String(start.status) })
    cleanup(uid)
    sleep(10)
    return
  }
  const jobId = start.json('job_id')

  // Poll until the job ends.
  let queuedUntil = null
  let outcome = 'timeout'
  while ((Date.now() - startedAt) / 1000 < JOB_TIMEOUT_SEC) {
    sleep(POLL_SEC)
    const res = api('GET', `/jobs/${jobId}`, null, 'GET /jobs/{id}')
    if (res.status !== 200) continue
    const status = res.json('status')
    const step = res.json('result.step')
    if (queuedUntil === null && status !== 'queued' && step !== 'waiting_slot') queuedUntil = Date.now()
    if (status === 'ok' || status === 'error') {
      outcome = status
      break
    }
  }
  const endedAt = Date.now()
  if (queuedUntil !== null) {
    jobQueueWait.add(queuedUntil - startedAt)
    if (outcome !== 'timeout') jobRunTime.add(endedAt - queuedUntil)
  } else if (outcome !== 'timeout') {
    // Finished between two polls without ever being seen running.
    jobQueueWait.add(endedAt - startedAt)
  }
  if (outcome === 'ok') {
    jobsCompleted.add(1)
    jobTotalTime.add(endedAt - startedAt)
  } else if (outcome === 'error') {
    jobsFailed.add(1)
  } else {
    jobsTimedOut.add(1)
  }

  if (outcome === 'ok') {
    api('GET', `/videos/${uid}/edit-script`, null, 'GET /videos/{uid}/edit-script')
    ;[body, headers] = json({ status: 'waiting_vo' })
    api('PATCH', `/videos/${uid}/local-status`, body, 'PATCH /videos/{uid}/local-status', { headers })
  }

  // The editor seeks in the synced clip: ranged reads, like <video> does.
  const size = CLIP.byteLength
  for (const [a, b] of [
    [0, 65535],
    [Math.floor(size / 2), Math.floor(size / 2) + 65535],
    [Math.max(0, size - 32768), size - 1]
  ]) {
    api('GET', `/videos/${uid}/files/normalized/clip0.mp4`, null, 'GET /videos/{uid}/files/* (range)', {
      headers: { Range: `bytes=${a}-${Math.min(b, size - 1)}` },
      ok: [206, 200]
    })
  }

  // Idle browsing.
  const idleEnd = Date.now() + IDLE_SEC * 1000
  while (Date.now() < idleEnd) {
    think()
    browse()
  }

  cleanup(uid)
  sessions.add(1)
}

function cleanup(uid) {
  if (CLEANUP) api('DELETE', `/videos/${uid}`, null, 'DELETE /videos/{uid}', { ok: [204, 404] })
}

// ── summary: one JSON line prefixed LOADTEST_SUMMARY ─────────────────────────
function trend(m) {
  if (!m) return null
  const v = m.values
  const r = (x) => (typeof x === 'number' ? Math.round(x) : null)
  const out = { avg: r(v.avg), p50: r(v.med), p90: r(v['p(90)']), p95: r(v['p(95)']), p99: r(v['p(99)']), max: r(v.max) }
  if (typeof v.count === 'number') out.samples = v.count
  return out
}

export function handleSummary(data) {
  const m = data.metrics
  const count = (name) => (m[name] ? m[name].values.count : 0)
  const endpoints = {}
  for (const e of ENDPOINTS) {
    const d = m[`http_req_duration{name:${e}}`]
    const err = m[`api_errors{name:${e}}`]
    const reqs = err ? err.values.passes + err.values.fails : 0
    if (!reqs) continue
    endpoints[e] = {
      requests: reqs,
      error_rate: err ? Number(err.values.rate.toFixed(4)) : 0,
      ms: trend(d)
    }
  }
  const summary = {
    base_url: BASE,
    ramp: TARGETS,
    ramp_sec: RAMP_SEC,
    hold_sec: HOLD_SEC,
    max_vus: m.vus_max ? m.vus_max.values.max : null,
    duration_sec: Math.round(data.state.testRunDurationMs / 1000),
    http: {
      requests: count('http_reqs'),
      rps: m.http_reqs ? Number(m.http_reqs.values.rate.toFixed(2)) : 0,
      error_rate: m.api_errors ? Number(m.api_errors.values.rate.toFixed(4)) : 0,
      ms: trend(m.http_req_duration)
    },
    jobs: {
      completed: count('jobs_completed'),
      failed: count('jobs_failed'),
      timed_out: count('jobs_timed_out'),
      starts_refused: count('starts_refused'),
      queue_wait_ms: trend(m.job_queue_wait),
      run_ms: trend(m.job_run_time),
      total_ms: trend(m.job_total_time)
    },
    sessions_completed: count('sessions_completed'),
    endpoints
  }
  const line = `LOADTEST_SUMMARY ${JSON.stringify(summary)}\n`
  const out = { stdout: line }
  if (__ENV.SUMMARY_FILE) out[__ENV.SUMMARY_FILE] = JSON.stringify(summary, null, 2)
  return out
}
