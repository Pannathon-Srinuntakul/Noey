#!/usr/bin/env node
/**
 * Loading states check (LOADING_PROMPT.md), against a site wired to the mock
 * backend (scripts/mock-backend.mjs), with the mock made slow while a check
 * needs a wait (GET <mock>/__mock/delay?ms=…). For every loading state it
 * proves, in the DOM and not only by eye, that the state is visible while the
 * page waits and gone once it is in — with motion and again with
 * `reducedMotion: 'reduce'` — and it measures what a visitor would notice:
 *
 *   - while waiting: the loading state is visible, says "กำลังโหลด" (or
 *     "กำลังเปิดห้องตัดต่อ") with role=status, its region is aria-busy, the wait
 *     clock is running (also with reduced motion), the header ruler is
 *     pending; with reduced motion nothing moves (no transform, sweep or
 *     stroke animation) but every state is still there;
 *   - afterwards: no loading state left, the ruler back to normal;
 *   - a fast navigation never shows any of it (sampled every frame);
 *   - layout shift from skeleton to page (CLS, PerformanceObserver);
 *   - "เปิดห้องตัดต่อ": the card on the click, gone after Back (bfcache);
 *   - no console error and no CSP violation anywhere;
 *   - without JavaScript: the loading state, then the page's content.
 *
 *   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright [CHROMIUM_PATH=…] \
 *     node scripts/loading-check.mjs --base http://127.0.0.1:3310 \
 *       --mock http://localhost:8769 [--shots dir] [--quick]
 *
 * --shots saves a screenshot of every state while it waits, as
 * <variant>-<theme>-<width>[-rm].png. --quick runs one theme. Exits 1 when a
 * check fails. Nothing leaves the machine: the editor (NEXT_PUBLIC_APP_URL,
 * expected at localhost:5199) is answered by a stub server started here.
 */
import { mkdirSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { mintSession, SCENARIOS } from "./mock-backend.mjs";

const require = createRequire(import.meta.url);
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const BASE = arg("base", "http://127.0.0.1:3310");
const MOCK = arg("mock", "http://localhost:8769");
const SHOTS = arg("shots", "");
const QUICK = process.argv.includes("--quick");
const EDITOR_PORT = Number(arg("editor-port", "5199"));
const DELAY = 2500;
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
// Playwright turns the back-forward cache off by default; Back must be able to restore a page from it here.
const browser = await chromium.launch({
  ignoreDefaultArgs: ["--disable-back-forward-cache"],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

// The editor's stand-in: a page the browser can leave for and come back from.
const editor = http
  .createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>editor</title><p>editor stub</p>");
  })
  .listen(EDITOR_PORT);

const setDelay = (ms) => fetch(`${MOCK}/__mock/delay?ms=${ms}`).then((response) => response.json());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
const problems = []; // console errors and CSP violations, everywhere
function record(check, ok, detail = {}) {
  results.push({ check, ok, ...detail });
  console.log(`${ok ? "pass" : "FAIL"}  ${check}${Object.keys(detail).length ? "  " + JSON.stringify(detail) : ""}`);
}

/** A visitor: theme, width, motion, optionally signed in as a mock scenario, optionally without JavaScript. */
async function visitor({ scn, width = 1440, theme = "light", still = false, js = true } = {}) {
  const context = await browser.newContext({
    viewport: { width, height: width < 600 ? 844 : 900 },
    reducedMotion: still ? "reduce" : "no-preference",
    colorScheme: theme,
    javaScriptEnabled: js,
  });
  await context.addInitScript((chosen) => {
    try {
      localStorage.setItem("noey.beta-notice.v1", JSON.stringify({ dismissedAt: Date.now(), forever: true }));
      localStorage.setItem("noey-theme", chosen);
    } catch {}
    window.__shifts = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__shifts.push({ value: entry.value, recent: entry.hadRecentInput, at: entry.startTime });
      }).observe({ type: "layout-shift", buffered: true });
    } catch {}
  }, theme);
  if (scn) {
    const tokens = mintSession(scn);
    await context.addCookies([
      { name: "noey_at", value: tokens.access_token, url: BASE },
      { name: "noey_rt", value: tokens.refresh_token, url: BASE },
      { name: "noey_si", value: "1", url: BASE },
      { name: "noey_name", value: encodeURIComponent(SCENARIOS[scn]?.name ?? ""), url: BASE },
    ]);
  }
  const page = await context.newPage();
  const label = `${scn ?? "visitor"} ${width} ${theme}${still ? " rm" : ""}${js ? "" : " nojs"}`;
  // Chrome reports a CSP violation as a console error too.
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`${label} ${page.url()} console: ${message.text().split("\n")[0].slice(0, 200)}`);
  });
  page.on("pageerror", (error) => problems.push(`${label} ${page.url()} pageerror: ${error.message.slice(0, 200)}`));
  return { context, page };
}

/** Visible to a person (any match): in the layout, not visibility:hidden, and opaque with every ancestor. */
async function shown(page, selector) {
  return page.evaluate((sel) =>
    [...document.querySelectorAll(sel)].some((element) => {
      if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true })) return false;
      let opacity = 1;
      for (let node = element; node && node.nodeType === 1; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
      const box = element.getBoundingClientRect();
      return opacity > 0.9 && box.width > 0 && box.height > 0;
    }),
  selector);
}

/** What the loading state says and announces, and whether its clock runs. */
async function loadingFacts(page, scope = "[data-loading='route']") {
  return page.evaluate((sel) => {
    const region = document.querySelector(sel);
    const status = region?.querySelector("[role='status']") ?? (region?.matches("[role='status']") ? region : null);
    const clock = region?.querySelector(".ld-tc");
    const clockStyle = clock ? getComputedStyle(clock, "::after") : null;
    return {
      busy: region?.getAttribute("aria-busy") === "true" || !!region?.closest("[aria-busy='true']"),
      status: status?.getAttribute("role") === "status" && status?.getAttribute("aria-live") === "polite",
      says: (status?.textContent ?? "").trim(),
      clock: !!clockStyle && clockStyle.animationName.includes("ld-f") && clockStyle.animationIterationCount.includes("infinite") && clockStyle.animationDuration.includes("1s"),
    };
  }, scope);
}

/** Anything that moves inside `selector` (animations other than the wait clock and the appear delay). */
async function moving(page, selector) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return [];
    const found = [];
    const look = (element, pseudo) => {
      const style = getComputedStyle(element, pseudo);
      const names = style.animationName.split(",").map((name) => name.trim());
      const durations = style.animationDuration.split(",").map((value) => parseFloat(value) * (value.trim().endsWith("ms") ? 1 : 1000));
      names.forEach((name, index) => {
        if (name === "none" || /^ld-(h|m|s|f|appear)$/.test(name)) return;
        if ((durations[index] ?? durations[0]) > 1) found.push(`${element.className?.baseVal ?? element.className}${pseudo ?? ""}:${name}`);
      });
    };
    for (const element of [root, ...root.querySelectorAll("*")]) {
      look(element);
      look(element, "::before");
      look(element, "::after");
    }
    return found.slice(0, 6);
  }, selector);
}

async function rulerPending(page) {
  return page.evaluate(() => {
    const scrub = document.querySelector(".stl__scrub");
    return !!scrub && Number(getComputedStyle(scrub).opacity) > 0.9 && getComputedStyle(scrub).visibility === "visible";
  });
}

async function cls(page) {
  return page.evaluate(() => window.__shifts.filter((shift) => !shift.recent).reduce((sum, shift) => sum + shift.value, 0));
}

async function shot(page, name, { theme, width, still }) {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${name}-${theme}-${width}${still ? "-rm" : ""}.png` });
}

/** Every check that must hold in one theme, width and motion setting. */
async function run({ theme, width, still }) {
  const mode = { theme, width, still };
  const tag = `${width} ${theme}${still ? " rm" : ""}`;

  // ── The account, its tabs, on a slow backend (full page loads) ──────────
  for (const [variant, path, real] of [
    ["account", "/account", ".acct-home"],
    ["account-quota", "/account/quota", ".acct-quota"],
    ["account-billing", "/account/billing", ".acct-billing"],
    ["account-profile", "/account/profile", ".acct-profile"],
  ]) {
    await setDelay(DELAY);
    const { context, page } = await visitor({ scn: "pro", ...mode });
    await page.goto(`${BASE}${path}`, { waitUntil: "commit" });
    await page.waitForTimeout(1100);
    const facts = await loadingFacts(page);
    const visible = await shown(page, "[data-loading='route'] .rl");
    const ruler = width >= 1024 || still ? await rulerPending(page) : true;
    const motion = still ? await moving(page, "[data-loading='route']") : [];
    await shot(page, variant, mode);
    record(`${variant} loading, ${tag}`, visible && facts.busy && facts.status && facts.says === "กำลังโหลด" && facts.clock && ruler && motion.length === 0, {
      visible, ...facts, ruler, ...(still ? { moving: motion } : {}),
    });
    await page.locator(`${real}:not([data-loading] *)`).first().waitFor({ timeout: 8000 });
    await page.waitForTimeout(700);
    const left = await page.locator("[data-loading='route']").count();
    const after = await rulerPending(page);
    const shift = await cls(page);
    record(`${variant} arrives, ${tag}`, left === 0 && !after && shift < 0.1, { loadingLeft: left, rulerPending: after, cls: Number(shift.toFixed(4)) });
    await context.close();
  }

  // ── Switching account tabs: only the panel's body waits ─────────────────
  {
    await setDelay(0);
    const { context, page } = await visitor({ scn: "pro", ...mode });
    await page.goto(`${BASE}/account`, { waitUntil: "networkidle" });
    await setDelay(DELAY);
    const greetingBefore = await page.locator(".acct-page__title").innerText();
    await page.locator(".tabs a[href='/account/quota']").click();
    await page.waitForTimeout(1100);
    const body = await shown(page, ".acct-page__body [data-loading='route'] .rl");
    const tab = await page.evaluate(() => {
      const skeleton = document.querySelector(".acct-skel__tab[data-tab='quota']");
      return skeleton ? getComputedStyle(skeleton).display : "absent";
    });
    const greeting = await page.locator(".acct-page__title").innerText();
    const facts = await loadingFacts(page);
    await shot(page, "account-tab-switch", mode);
    record(`tab switch loading, ${tag}`, body && tab === "grid" && greeting === greetingBefore && facts.clock && facts.says === "กำลังโหลด", { body, tab, greeting, ...facts });
    await page.locator(".acct-quota:not([data-loading] *)").first().waitFor({ timeout: 8000 });
    await page.waitForTimeout(700);
    const shift = await cls(page);
    record(`tab switch arrives, ${tag}`, (await page.locator("[data-loading='route']").count()) === 0 && shift < 0.1, { cls: Number(shift.toFixed(4)) });
    await context.close();
  }

  // ── The status pages ─────────────────────────────────────────────────────
  for (const [variant, path, scn, real] of [
    ["verify-email", "/verify-email?token=ok", null, ".status:not(.status--skel)"],
    ["checkout-success", "/checkout/success?session_id=cs_test_mock", "pro", ".status:not(.status--skel)"],
  ]) {
    await setDelay(DELAY);
    const { context, page } = await visitor({ scn, ...mode });
    await page.goto(`${BASE}${path}`, { waitUntil: "commit" });
    await page.waitForTimeout(1100);
    const visible = await shown(page, ".status--skel .rl");
    const facts = await loadingFacts(page);
    const motion = still ? await moving(page, "[data-loading='route']") : [];
    await shot(page, variant, mode);
    record(`${variant} loading, ${tag}`, visible && facts.busy && facts.status && facts.clock && motion.length === 0, { visible, ...facts, ...(still ? { moving: motion } : {}) });
    await page.locator(real).first().waitFor({ timeout: 8000 });
    await page.waitForTimeout(700);
    const shift = await cls(page);
    record(`${variant} arrives, ${tag}`, (await page.locator("[data-loading='route']").count()) === 0 && shift < 0.1, { cls: Number(shift.toFixed(4)) });
    await context.close();
  }

  // ── /reset-password renders without waiting on the backend (no loading
  //    state of its own); its wait is the new password being saved ──────────
  {
    await setDelay(DELAY);
    const { context, page } = await visitor(mode);
    await page.goto(`${BASE}/reset-password?token=ok`, { waitUntil: "networkidle" });
    await page.locator(".auth__form input[type='password']").nth(0).fill("password123");
    await page.locator(".auth__form input[type='password']").nth(1).fill("password123");
    const button = page.locator(".auth__form .pbtn").first();
    await button.click();
    await page.waitForTimeout(700);
    const state = await button.evaluate((element) => ({
      busy: element.getAttribute("aria-busy"),
      disabled: element.disabled,
      label: [...element.querySelectorAll(".pbtn__labels > span")].find((span) => getComputedStyle(span).visibility === "visible")?.textContent,
    }));
    const mark = await shown(page, ".auth__form .pbtn .pend");
    await shot(page, "reset-password", mode);
    record(`reset-password saving, ${tag}`, state.busy === "true" && state.disabled && state.label === "กำลังบันทึก…" && mark, { ...state, mark });
    await page.waitForURL((url) => !url.pathname.startsWith("/reset-password"), { timeout: 10000 });
    await context.close();
  }

  // ── Marketing to marketing, the page slow to come ──────────────────────
  {
    await setDelay(0);
    const { context, page } = await visitor(mode);
    // The page is slow to come, its prefetch included (a slow connection).
    await page.route(/\/about/, async (route) => {
      if (route.request().headers().rsc) await sleep(DELAY * 2);
      return route.continue();
    });
    await page.goto(`${BASE}/pricing`, { waitUntil: "load" });
    await page.waitForTimeout(600);
    if (width < 1024) {
      await page.locator(".menu > summary").click();
      await page.locator(".menu__nav a[href='/about']").click();
    } else {
      await page.locator(".hdr__nav a[href='/about']").click();
    }
    await page.waitForTimeout(1100);
    const pending = await page.evaluate(() => document.documentElement.hasAttribute("data-nav-pending"));
    const ruler = await rulerPending(page);
    const linkSel = width < 1024 ? ".menu__nav a[href='/about']" : ".hdr__nav a[href='/about']";
    const link = await shown(page, `${linkSel} .pend`);
    const busy = (await page.locator(linkSel).getAttribute("aria-busy")) === "true";
    const label = still && width < 1024 ? await shown(page, ".stl__wait") : true;
    await shot(page, "nav-marketing", mode);
    record(`marketing navigation pending, ${tag}`, pending && ruler && link && busy && label, { pending, ruler, link, busy, label });
    await page.waitForURL(/\/about$/, { timeout: 15000 });
    await page.waitForTimeout(800);
    const after = await rulerPending(page);
    const stillPending = await page.evaluate(() => document.documentElement.hasAttribute("data-nav-pending"));
    record(`marketing navigation done, ${tag}`, !after && !stillPending, { rulerPending: after, pendingAttr: stillPending });
    await context.close();
  }

  // ── A fast navigation shows nothing (every frame sampled) ───────────────
  for (const [from, to, scn] of [
    ["/pricing", "/about", null],
    ["/account", "/account/quota", "pro"],
  ]) {
    await setDelay(0);
    const { context, page } = await visitor({ scn, ...mode });
    await page.goto(`${BASE}${from}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500); // the destination is prefetched (in view)
    await page.evaluate(() => {
      window.__seen = { loader: 0, ruler: 0, link: 0, frames: 0 };
      const opacityOf = (element) => {
        let opacity = 1;
        for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.visibility === "hidden" || style.display === "none") return 0;
          opacity *= Number(style.opacity);
        }
        return opacity;
      };
      const sample = () => {
        const seen = window.__seen;
        seen.frames += 1;
        for (const element of document.querySelectorAll("[data-loading='route']")) seen.loader = Math.max(seen.loader, opacityOf(element));
        const scrub = document.querySelector(".stl__scrub");
        if (scrub) seen.ruler = Math.max(seen.ruler, opacityOf(scrub));
        for (const element of document.querySelectorAll(".pend[data-on]")) seen.link = Math.max(seen.link, opacityOf(element));
        if (seen.frames < 90) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    const selector = to === "/about" ? (width < 1024 ? ".menu__nav a[href='/about']" : ".hdr__nav a[href='/about']") : ".tabs a[href='/account/quota']";
    if (to === "/about" && width < 1024) await page.locator(".menu > summary").click();
    const started = Date.now();
    await page.locator(selector).click();
    await page.waitForURL((url) => url.pathname === to, { timeout: 8000 });
    const took = Date.now() - started;
    await page.waitForTimeout(1200);
    const seen = await page.evaluate(() => window.__seen);
    record(`fast navigation ${from} → ${to} shows nothing, ${tag}`, seen.loader < 0.02 && seen.ruler < 0.02 && seen.link < 0.02, { tookMs: took, ...seen });
    await context.close();
  }

  // ── "เปิดห้องตัดต่อ": the card, then the editor, then Back ─────────────────
  // While a real navigation is pending, the automated browser can neither
  // read the page nor take its picture, so the first click is held on the
  // page (a listener after the site's own cancels it): the card is raised
  // exactly as on a real click. The second click really leaves.
  {
    await setDelay(0);
    const { context, page } = await visitor({ scn: "pro", ...mode });
    // A static page (the account's are no-store, so never kept for Back).
    await page.goto(`${BASE}/pricing`, { waitUntil: "networkidle" });
    await page.evaluate(() => window.addEventListener("pageshow", (event) => (window.__restored = event.persisted)));
    const open = width < 1024 ? ".menu__sheet a[href='/api/editor/open']" : ".hdr__tools > .auth-in > a[href='/api/editor/open']";
    if (width < 1024) await page.locator(".menu > summary").click();
    await page.evaluate(() => {
      window.__hold = (event) => {
        if (event.target instanceof Element && event.target.closest("a[href='/api/editor/open']")) event.preventDefault();
      };
      window.addEventListener("click", window.__hold);
    });
    await page.locator(open).first().click();
    await page.waitForTimeout(800);
    const card = await shown(page, ".edopen__panel");
    const words = await page.locator(".edopen__text").innerText();
    const announced = (await page.locator("[data-editor-status]").textContent()) ?? "";
    const motion = still ? await moving(page, ".edopen") : [];
    await shot(page, "editor-opening", mode);
    record(`editor opening card, ${tag}`, card && words === "กำลังเปิดห้องตัดต่อ" && announced === "กำลังเปิดห้องตัดต่อ" && motion.length === 0, { card, words, announced, ...(still ? { moving: motion } : {}) });
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.removeEventListener("click", window.__hold));
    await setDelay(800);
    if (width < 1024 && !(await page.locator(".menu[open]").count())) await page.locator(".menu > summary").click();
    await page.locator(open).first().click({ noWaitAfter: true });
    await page.waitForURL((url) => url.port === String(EDITOR_PORT), { timeout: 10000 });
    await setDelay(0);
    await page.goBack({ waitUntil: "commit" }); // a page restored from the cache fires no load
    await page.waitForTimeout(900);
    const restored = await page.evaluate(() => (window.__restored ? "bfcache" : performance.getEntriesByType("navigation")[0]?.type));
    const stuck = await page.evaluate(() => document.documentElement.hasAttribute("data-editor-opening"));
    const visible = await shown(page, ".edopen__panel");
    record(`editor opening card gone after Back, ${tag}`, !stuck && !visible, { navigationType: restored, stuck, visible });
    await context.close();
  }

  // ── A form waiting on its answer ─────────────────────────────────────────
  {
    await setDelay(DELAY);
    const { context, page } = await visitor(mode);
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.locator("#l-email").fill("pro@x.test");
    await page.locator("#l-pass").fill("password123");
    const button = page.locator(".auth__form .pbtn").first();
    const before = await button.boundingBox();
    await button.click();
    await page.waitForTimeout(700);
    const state = await button.evaluate((element) => ({
      busy: element.getAttribute("aria-busy"),
      disabled: element.disabled,
      label: [...element.querySelectorAll(".pbtn__labels > span")].find((span) => getComputedStyle(span).visibility === "visible")?.textContent,
    }));
    const after = await button.boundingBox();
    const mark = await shown(page, ".auth__form .pbtn .pend");
    const motion = still ? await moving(page, ".auth__form .pbtn") : [];
    await shot(page, "form-pending", mode);
    const sameSize = Math.abs(before.width - after.width) < 0.5 && Math.abs(before.height - after.height) < 0.5;
    record(`form pending, ${tag}`, state.busy === "true" && state.disabled && state.label === "กำลังเข้าสู่ระบบ…" && mark && sameSize && motion.length === 0, { ...state, mark, sameSize, ...(still ? { moving: motion } : {}) });
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 10000 });
    await context.close();
  }
}

const themes = QUICK ? ["light"] : ["light", "dark"];
for (const still of [false, true]) for (const theme of themes) for (const width of [1440, 390]) await run({ theme, width, still });

// ── Without JavaScript: the loading state, then the content ───────────────
{
  await setDelay(DELAY);
  const { context, page } = await visitor({ scn: "pro", js: false });
  await page.goto(`${BASE}/account`, { waitUntil: "commit" });
  await page.waitForTimeout(1100);
  const loading = await shown(page, "[data-loading='route'] .rl");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/nojs-account-loading-light-1440.png` });
  await page.waitForLoadState("load");
  await page.waitForTimeout(500);
  const content = await shown(page, ".acct-hero");
  const loaderGone = !(await shown(page, "[data-loading='route'] .rl"));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/nojs-account-arrived-light-1440.png`, fullPage: true });
  record("no JavaScript: /account loading, then its content", loading && content && loaderGone, { loading, content, loaderGone });
  await context.close();
}
{
  await setDelay(0);
  const { context, page } = await visitor({ js: false });
  for (const path of ["/", "/pricing", "/guide/help"]) {
    await page.goto(`${BASE}${path}`);
    const loader = await page.locator("[data-loading='route']").count();
    const main = await shown(page, "main h1");
    record(`no JavaScript: ${path} whole, no loading state`, loader === 0 && main, { loader, main });
  }
  await context.close();
}

await setDelay(0);
record("no console errors or CSP violations", problems.length === 0, { problems: problems.slice(0, 12) });
editor.close();
await browser.close();
const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
