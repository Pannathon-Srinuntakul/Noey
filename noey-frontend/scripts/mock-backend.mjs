#!/usr/bin/env node
/**
 * Contract-shaped mock of the FastAPI backend, for local screenshots, the
 * content crawl (scripts/crawl-text.mjs) and hand-testing signed-in pages
 * without Postgres, Redis or Stripe. Development tooling only: nothing in the
 * site imports it, and it holds no real data.
 *
 *   node scripts/mock-backend.mjs            # http://localhost:8765
 *   MOCK_PORT=8765 MOCK_SITE=http://127.0.0.1:3100 MOCK_GOOGLE=1 MOCK_BETA=1
 *
 * Stateless on purpose: the signed-in "scenario" travels inside the unsigned
 * JWT payload (`scn` claim). Signing in with <scenario>@x.test picks it
 * (free, unverified, pro, studio, cancel, pastdue, lapsed, googleonly,
 * googlelinked, wallet, unlimited, billingoff, nodata, spent); the password
 * "wrong" is refused. `mintSession()` gives the crawler the same tokens.
 *
 * Token-driven outcomes: /auth/verify-email token ok | change | used | taken
 * | slow (anything else fails); /auth/reset-password token ok (anything else
 * is expired); a contact message containing fail503 / fail429 fails that way.
 */
import http from "node:http";
import { pathToFileURL } from "node:url";

const BETA_PRICES = { lite: 99, starter: 199, pro: 499, studio: 999, agency: 1999, max: 3499 };
const FULL_PRICES = { lite: 199, starter: 399, pro: 990, studio: 1990, agency: 3990, max: 6990 };

export const SCENARIOS = {
  free: { plan: "free", name: "นอย", verified: true },
  unverified: { plan: "free", name: "มิ้นท์", verified: false },
  pro: { plan: "pro", name: "นอย", verified: true, status: "active" },
  studio: { plan: "studio", name: "ทีมสตูดิโอ", verified: true, status: "active" },
  cancel: { plan: "pro", name: "นอย", verified: true, status: "active", cancel: true },
  pastdue: { plan: "starter", name: "นอย", verified: true, status: "past_due" },
  lapsed: { plan: "free", name: "นอย", verified: true, status: "unpaid" },
  googleonly: { plan: "free", name: "กูเกิล", verified: true, google: true, noPassword: true },
  googlelinked: { plan: "lite", name: "นอย", verified: true, status: "active", google: true },
  wallet: { plan: "pro", name: "นอย", verified: true, status: "active", wallet: 12550 },
  unlimited: { plan: "max", name: "แอดมิน", verified: true, status: "active", unlimited: true },
  billingoff: { plan: "free", name: "นอย", verified: true, billingOff: true },
  nodata: { plan: "free", name: "", verified: true, broken: true },
  spent: { plan: "free", name: "นอย", verified: true, spent: true },
};

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (payload) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.bW9jaw`;

/** The token pair the mock hands out for a scenario (also used by the crawler to set cookies). */
export function mintSession(scn) {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: jwt({ sub: "1", scn, exp: now + 3600 }),
    refresh_token: jwt({ sub: "1", scn, exp: now + 14 * 86400, typ: "refresh" }),
    token_type: "bearer",
  };
}

function scenarioOf(request) {
  const token = (request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const scn = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")).scn;
    return SCENARIOS[scn] ? { key: scn, ...SCENARIOS[scn] } : null;
  } catch {
    return null;
  }
}

const inDays = (days) => new Date(Date.now() + days * 86_400_000).toISOString();

function me(s) {
  return {
    user_id: 1,
    email: `${s.key}@x.test`,
    tenant_id: 1,
    tenant_slug: "t1",
    role: "owner",
    is_admin: false,
    display_name: s.name || null,
    email_verified: s.verified,
    has_password: !s.noPassword,
    google_linked: !!s.google,
    google_email: s.google ? `${s.key}@gmail.test` : null,
  };
}

function usage(s) {
  const limits = [];
  if (s.plan === "free") limits.push({ key: "lifetime", used_pct: s.spent ? 100 : 46, resets_at: null, active: true, resets: false });
  // One window per paid account since 2026-09-30 (backend limits.py rule 1):
  // the monthly one, reset on the billing date.
  else limits.push({ key: "monthly", used_pct: s.plan === "lite" || s.plan === "starter" ? 63 : 84, resets_at: inDays(12), active: true });
  return {
    plan: s.plan,
    unlimited: !!s.unlimited,
    limits,
    concurrency: { max: { pro: 2, studio: 3, agency: 4, max: 5 }[s.plan] ?? 1, running: 0, queued: 0 },
    wallet: s.wallet ? { balance_satang: s.wallet, next_expiry: inDays(200) } : null,
    pending_plan: s.cancel ? { plan: "free", at: inDays(12) } : null,
    by_task: [
      { task: "cut", pct: 78.4 },
      { task: "effects", pct: 12.1 },
      { task: "style", pct: 9.5 },
    ],
    // As the backend does (usage.py): the tightest window's percentage.
    usage_pct: limits.reduce((top, limit) => Math.max(top, limit.used_pct), 0),
  };
}

function billing(s) {
  const live = !!s.status && ["active", "trialing", "past_due"].includes(s.status);
  return {
    plan: live ? s.plan : "free",
    status: s.status || null,
    lookup_key: live ? `noey_${s.plan}_monthly` : null,
    current_period_end: live ? inDays(12) : null,
    cancel_at_period_end: !!s.cancel,
    payment_method: live ? { brand: "visa", last4: "4242" } : null,
    billing_enabled: !s.billingOff,
  };
}

function send(response, status, body) {
  if (status === 204) return response.writeHead(204).end();
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

export function createMockBackend({ site = "http://127.0.0.1:3100", google = true, beta = true, log = false } = {}) {
  return http.createServer(async (request, response) => {
    const path = new URL(request.url, "http://mock").pathname;
    const method = request.method;
    const body = method === "GET" ? {} : await readBody(request);
    const s = scenarioOf(request);
    if (log) console.log(method, path, s?.key ?? "-");

    if (path === "/billing/plans") {
      const ladder = beta ? BETA_PRICES : FULL_PRICES;
      return send(response, 200, {
        currency: "thb",
        source: "stripe",
        plans: Object.entries(ladder).map(([tier, baht]) => ({ tier, unit_amount: baht * 100, interval: "month", lookup_key: `noey_${tier}_monthly` })),
      });
    }
    if (path === "/auth/google/config") return send(response, 200, { enabled: google });
    if (path === "/auth/login") {
      const local = String(body.email || "").split("@")[0];
      if (!SCENARIOS[local] || body.password === "wrong") return send(response, 401, { detail: "Invalid credentials" });
      return send(response, 200, mintSession(local));
    }
    if (path === "/auth/register") {
      if (String(body.email || "").startsWith("taken")) return send(response, 409, { detail: "exists" });
      return send(response, 201, mintSession("unverified"));
    }
    if (path === "/auth/refresh") return s ? send(response, 200, mintSession(s.key)) : send(response, 401, { detail: "no" });
    if (path === "/auth/forgot-password") return send(response, 202, { ok: true });
    if (path === "/auth/reset-password") return body.token === "ok" ? send(response, 200, mintSession("free")) : send(response, 400, { detail: "expired" });
    if (path === "/auth/verify-email") {
      const outcomes = {
        ok: [200, { email: "noey@x.test", purpose: "verify" }],
        change: [200, { email: "new@x.test", purpose: "change_email" }],
        used: [400, { detail: "expired" }],
        taken: [409, { detail: "taken" }],
        slow: [429, { detail: "slow" }],
      };
      const [status, payload] = outcomes[body.token] ?? [500, { detail: "boom" }];
      return send(response, status, payload);
    }
    if (path === "/contact") {
      const message = String(body.message || "");
      if (message.includes("fail503")) return send(response, 503, { detail: "no mail" });
      if (message.includes("fail429")) return send(response, 429, { detail: "slow" });
      return send(response, 202, { ok: true });
    }

    // Everything below is signed in.
    if (!s) return send(response, 401, { detail: "Not authenticated" });
    if (s.broken && path !== "/auth/me") return send(response, 503, { detail: "down" });

    if (path === "/auth/me" && method === "GET") return send(response, 200, me(s));
    if (path === "/auth/me" && method === "PATCH") return send(response, 200, { ...me(s), display_name: body.display_name });
    if (path === "/usage/me") return send(response, 200, usage(s));
    if (path === "/videos/storage") {
      const quota = ({ free: 1, lite: 3, starter: 5, pro: 10, studio: 30, agency: 60, max: 100 }[s.plan] ?? 1) * 1024 ** 3;
      return send(response, 200, { used_bytes: Math.round(quota * 0.37), quota_bytes: s.unlimited ? 0 : quota, plan: s.plan, project_count: 7 });
    }
    if (path === "/billing/me") return send(response, 200, billing(s));
    if (["/billing/checkout", "/billing/change-plan", "/billing/portal"].includes(path)) {
      return send(response, 200, { url: `${site}/checkout/success?session_id=cs_test_mock` });
    }
    if (path === "/billing/cancel" || path === "/billing/resume") return send(response, 200, { ok: true });
    if (path === "/auth/resend-verification") return send(response, 202, { ok: true });
    if (path === "/auth/change-email") return body.current_password === "wrong" ? send(response, 400, { detail: "wrong" }) : send(response, 202, { ok: true });
    if (path === "/auth/change-password") {
      return body.current_password === "wrong" ? send(response, 400, { detail: "wrong" }) : send(response, 200, mintSession(s.key));
    }
    if (path === "/auth/google" && method === "DELETE") {
      return s.noPassword ? send(response, 409, { detail: { code: "password_required" } }) : send(response, 204);
    }
    if (path === "/auth/google/start") {
      return send(response, 200, { authorization_url: "https://accounts.google.com/o/oauth2/v2/auth?mock=1", state: "mockstate" });
    }
    if (path === "/auth/delete-account") {
      if (s.wallet && !body.forfeit_wallet_balance) return send(response, 409, { detail: { code: "wallet_balance", balance_satang: s.wallet } });
      if (body.password === "wrong") return send(response, 400, { detail: { code: "wrong_password" } });
      return send(response, 204);
    }
    if (path === "/auth/handoff") return send(response, 200, { code: "hNd0ffC0de_hNd0ffC0de_hNd0ffC0de_hNd0ffC0de" });
    return send(response, 404, { detail: "not found" });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.MOCK_PORT || 8765);
  createMockBackend({
    site: process.env.MOCK_SITE || "http://127.0.0.1:3100",
    google: process.env.MOCK_GOOGLE !== "0",
    beta: process.env.MOCK_BETA !== "0",
    log: !!process.env.MOCK_LOG,
  }).listen(port, () => console.log(`mock backend on http://localhost:${port}`));
}
