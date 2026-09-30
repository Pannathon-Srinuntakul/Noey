#!/usr/bin/env node
/**
 * Crawl a running build of this site and save what a visitor can read on
 * every route and state — one text file per state, optionally with
 * screenshots. The content-parity check (scripts/content-parity.mjs) compares
 * two of these crawls sentence by sentence.
 *
 *   node scripts/crawl-text.mjs --base http://127.0.0.1:3100 --out .redesign-current \
 *        [--shots <dir>] [--widths 390,1024,1440] [--themes light,dark] \
 *        [--only home,pricing] [--motion reduce|no-preference] [--full]
 *
 * Needs:
 *   - `playwright`, which is NOT a dependency of the site. Point
 *     PLAYWRIGHT_MODULE at an installed copy (…/node_modules/playwright), or
 *     install one with `npm i --no-save playwright`.
 *   - the site started against scripts/mock-backend.mjs (API_URL), because
 *     signed-in states are reached with that mock's tokens.
 *
 * Screenshots are taken only for states marked `shot` unless --full is given.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { SCENARIOS, mintSession } from "./mock-backend.mjs";

const require = createRequire(import.meta.url);

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

const BASE = String(arg("base", "http://127.0.0.1:3100")).replace(/\/+$/, "");
const OUT = resolve(String(arg("out", ".redesign-current")));
const SHOTS = arg("shots", null);
const WIDTHS = String(arg("widths", "390,1024,1440")).split(",").map(Number);
const THEMES = String(arg("themes", "light,dark")).split(",");
const ONLY = arg("only", null);
const MOTION = String(arg("motion", "reduce"));
const FULL = arg("full", false) === true;

/**
 * Every state a visitor can land in. `scn` signs in as a mock scenario;
 * `click` opens a dialog by its button's accessible name; `wait` waits longer
 * (ms) for client-side states; `shot` marks the states screenshotted by
 * default.
 */
const STATES = [
  { id: "home", path: "/", shot: true },
  { id: "scope", path: "/scope", shot: true },
  { id: "pricing", path: "/pricing", shot: true },
  { id: "pricing-checkout-canceled", path: "/pricing?checkout=canceled" },
  { id: "guide", path: "/guide", shot: true },
  { id: "guide-ai-cut-tiktok", path: "/guide/ai-cut-tiktok", shot: true },
  { id: "guide-thai-subtitles", path: "/guide/thai-subtitles", shot: true },
  { id: "guide-product-review", path: "/guide/product-review", shot: true },
  { id: "guide-long-to-shorts", path: "/guide/long-to-shorts", shot: true },
  { id: "guide-choose-ai-editor", path: "/guide/choose-ai-editor", shot: true },
  { id: "guide-help", path: "/guide/help", shot: true },
  { id: "about", path: "/about", shot: true },
  ...["sent", "invalid", "rate-limited", "unavailable", "captcha", "error"].map((outcome) => ({
    id: `about-contact-${outcome}`,
    path: `/about?contact=${outcome}`,
  })),
  { id: "signup", path: "/signup", shot: true },
  { id: "signup-plan", path: "/signup?plan=pro" },
  { id: "signup-google-captcha", path: "/signup?google=captcha_required" },
  { id: "login", path: "/login", shot: true },
  { id: "login-forgot", path: "/login?forgot=1", shot: true },
  { id: "login-google-cancelled", path: "/login?google=cancelled" },
  { id: "terms", path: "/terms", shot: true },
  { id: "privacy", path: "/privacy", shot: true },
  { id: "account-deleted", path: "/account-deleted", shot: true },
  { id: "reset-password", path: "/reset-password", shot: true },
  { id: "reset-password-token", path: "/reset-password?token=ok", shot: true },
  { id: "verify-email-missing", path: "/verify-email", shot: true },
  { id: "verify-email-ok", path: "/verify-email?token=ok", shot: true },
  { id: "verify-email-change", path: "/verify-email?token=change" },
  { id: "verify-email-used", path: "/verify-email?token=used", shot: true },
  { id: "verify-email-used-signed-in", path: "/verify-email?token=used", scn: "free" },
  { id: "verify-email-used-unverified", path: "/verify-email?token=used", scn: "unverified" },
  { id: "verify-email-taken", path: "/verify-email?token=taken" },
  { id: "verify-email-taken-signed-in", path: "/verify-email?token=taken", scn: "free" },
  { id: "verify-email-slow", path: "/verify-email?token=slow" },
  { id: "verify-email-error", path: "/verify-email?token=boom" },
  { id: "not-found", path: "/this-page-does-not-exist", shot: true },
  { id: "account", path: "/account", scn: "free", shot: true },
  { id: "account-unverified", path: "/account", scn: "unverified", shot: true },
  { id: "account-pro", path: "/account", scn: "pro" },
  { id: "account-notice-password-reset", path: "/account?notice=password-reset", scn: "free" },
  { id: "account-notice-google-welcome", path: "/account?notice=google-welcome", scn: "googleonly" },
  { id: "account-nodata", path: "/account", scn: "nodata" },
  { id: "quota", path: "/account/quota", scn: "free", shot: true },
  { id: "quota-pro", path: "/account/quota", scn: "pro", shot: true },
  { id: "quota-spent", path: "/account/quota", scn: "spent" },
  { id: "quota-starter", path: "/account/quota", scn: "pastdue" },
  { id: "quota-wallet", path: "/account/quota", scn: "wallet" },
  { id: "quota-cancel", path: "/account/quota", scn: "cancel" },
  { id: "quota-unlimited", path: "/account/quota", scn: "unlimited" },
  { id: "quota-nodata", path: "/account/quota", scn: "nodata" },
  { id: "billing", path: "/account/billing", scn: "free", shot: true },
  { id: "billing-pro", path: "/account/billing", scn: "pro", shot: true },
  { id: "billing-cancel", path: "/account/billing", scn: "cancel" },
  { id: "billing-pastdue", path: "/account/billing", scn: "pastdue" },
  { id: "billing-lapsed", path: "/account/billing", scn: "lapsed" },
  { id: "billing-off", path: "/account/billing", scn: "billingoff" },
  { id: "billing-nodata", path: "/account/billing", scn: "nodata" },
  { id: "billing-plan-change-done", path: "/account/billing?plan_change=done", scn: "pro" },
  { id: "billing-from-signup", path: "/account/billing?plan=pro&from=signup", scn: "unverified" },
  { id: "billing-upgrade-dialog", path: "/account/billing?plan=pro", scn: "free", shot: true },
  { id: "billing-change-dialog", path: "/account/billing", scn: "pro", click: "เปลี่ยนแพลน" },
  { id: "billing-cancel-dialog", path: "/account/billing", scn: "pro", click: "ยกเลิกแพลน" },
  { id: "profile", path: "/account/profile", scn: "free", shot: true },
  { id: "profile-google-only", path: "/account/profile", scn: "googleonly" },
  { id: "profile-google-linked", path: "/account/profile", scn: "googlelinked" },
  { id: "profile-delete-dialog", path: "/account/profile", scn: "free", click: "ลบบัญชี…", shot: true },
  { id: "profile-delete-dialog-google", path: "/account/profile", scn: "googleonly", click: "ลบบัญชี…" },
  { id: "profile-nodata", path: "/account/profile", scn: "nodata" },
  { id: "checkout-success", path: "/checkout/success?session_id=cs_test_mock", scn: "pro", shot: true },
  { id: "checkout-waiting", path: "/checkout/success?session_id=cs_test_mock", scn: "free", wait: 300 },
  { id: "checkout-slow", path: "/checkout/success?session_id=cs_test_mock", scn: "free", wait: 33_000 },
];

const BETA_DISMISSED = `try{localStorage.setItem("noey.beta-notice.v1",JSON.stringify({dismissedAt:Date.now(),forever:true}))}catch(e){}`;

function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, "playwright"].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // try the next one
    }
  }
  console.error("playwright not found: set PLAYWRIGHT_MODULE=/path/to/node_modules/playwright or `npm i --no-save playwright`.");
  process.exit(2);
}

async function sessionCookies(scn) {
  const tokens = mintSession(scn);
  const name = SCENARIOS[scn]?.name ?? "";
  const url = BASE;
  const cookies = [
    { name: "noey_at", value: tokens.access_token, url },
    { name: "noey_rt", value: tokens.refresh_token, url },
    { name: "noey_si", value: "1", url },
  ];
  if (name) cookies.push({ name: "noey_name", value: encodeURIComponent(name), url });
  return cookies;
}

/** What a visitor can read, split by landmark. innerText honours CSS (hidden text is skipped). */
function readPage() {
  const section = (element) => (element ? element.innerText.trim() : "");
  const header = document.querySelector("body > header, header.site-header, header[data-site-header]");
  const main = document.querySelector("main");
  const footer = document.querySelector("body > footer, footer.site-footer, footer[data-site-footer]");
  const dialogs = [...document.querySelectorAll("dialog[open]")].map((dialog) => dialog.innerText.trim()).join("\n");
  const rest = [...document.body.children]
    .filter((element) => !["HEADER", "MAIN", "FOOTER", "SCRIPT", "DIALOG", "NOSCRIPT", "STYLE"].includes(element.tagName))
    .filter((element) => !element.contains(main))
    .map((element) => element.innerText.trim())
    .filter(Boolean)
    .join("\n");
  return { header: section(header), main: section(main), footer: section(footer), dialogs, rest, title: document.title };
}

async function settle(page, state) {
  await page.waitForLoadState("networkidle").catch(() => {});
  if (state.click) {
    await page.getByRole("button", { name: state.click, exact: true }).first().click();
    await page.waitForSelector("dialog[open]", { timeout: 5_000 }).catch(() => {});
  }
  await page.waitForTimeout(state.wait ?? 700);
}

async function capture(browser, state) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", locale: "th-TH" });
  await context.addInitScript(BETA_DISMISSED);
  if (state.scn) await context.addCookies(await sessionCookies(state.scn));
  const page = await context.newPage();
  const response = await page.goto(`${BASE}${state.path}`, { waitUntil: "domcontentloaded" });
  await settle(page, state);
  const text = await page.evaluate(readPage);
  const lines = [
    `# state: ${state.id}`,
    `# url: ${state.path}${state.scn ? ` (signed in: ${state.scn})` : ""}${state.click ? ` (clicked: ${state.click})` : ""}`,
    `# status: ${response?.status() ?? "?"} · final: ${new URL(page.url()).pathname}`,
    `# title: ${text.title}`,
    "## header",
    text.header,
    "## main",
    text.main,
    "## dialogs",
    text.dialogs,
    "## footer",
    text.footer,
    "## other",
    text.rest,
    "",
  ];
  await writeFile(join(OUT, `${state.id}.txt`), lines.join("\n"));
  await context.close();
}

async function captureBetaNotice(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForSelector("dialog[open]", { timeout: 8_000 }).catch(() => {});
  const text = await page.evaluate(readPage);
  await writeFile(join(OUT, "beta-notice.txt"), ["# state: beta-notice (first visit, modal open)", "## dialogs", text.dialogs, "## other", text.rest, ""].join("\n"));
  await context.close();
}

async function screenshots(browser, state) {
  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      const context = await browser.newContext({
        viewport: { width, height: width < 700 ? 844 : 900 },
        deviceScaleFactor: 1,
        reducedMotion: MOTION === "reduce" ? "reduce" : "no-preference",
        colorScheme: theme === "dark" ? "dark" : "light",
      });
      await context.addInitScript(`${BETA_DISMISSED};try{localStorage.setItem("noey-theme","${theme}")}catch(e){}`);
      if (state.scn) await context.addCookies(await sessionCookies(state.scn));
      const page = await context.newPage();
      await page.goto(`${BASE}${state.path}`, { waitUntil: "domcontentloaded" });
      await settle(page, { ...state, wait: Math.min(state.wait ?? 900, 2_000) });
      // Walk the page once so anything that reveals on scroll has been seen.
      await page.evaluate(async () => {
        const step = window.innerHeight * 0.8;
        for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await new Promise((done) => setTimeout(done, 60));
        }
        window.scrollTo(0, 0);
        await new Promise((done) => setTimeout(done, 300));
      });
      await page.screenshot({ path: join(String(SHOTS), `${state.id}--${width}--${theme}.png`), fullPage: true });
      await context.close();
    }
  }
}

async function main() {
  const { chromium } = loadPlaywright();
  await mkdir(OUT, { recursive: true });
  if (SHOTS) await mkdir(String(SHOTS), { recursive: true });
  const only = ONLY ? new Set(String(ONLY).split(",")) : null;
  const states = STATES.filter((state) => !only || only.has(state.id));
  const browser = await chromium.launch();
  const queue = [...states];
  const failures = [];
  const worker = async () => {
    for (let state = queue.shift(); state; state = queue.shift()) {
      try {
        await capture(browser, state);
        if (SHOTS && (FULL || state.shot)) await screenshots(browser, state);
        process.stdout.write(`✓ ${state.id}\n`);
      } catch (error) {
        failures.push(state.id);
        process.stdout.write(`✗ ${state.id}: ${error.message.split("\n")[0]}\n`);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  if (!only || only.has("beta-notice")) await captureBetaNotice(browser);
  await browser.close();
  console.log(`\n${states.length - failures.length}/${states.length} states saved to ${OUT}`);
  if (failures.length) process.exitCode = 1;
}

await main();
