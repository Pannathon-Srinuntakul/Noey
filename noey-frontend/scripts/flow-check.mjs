#!/usr/bin/env node
/**
 * Behaviour check for the redesign: the flows a visitor runs through must end
 * where they ended before. Runs each flow against a site wired to the mock
 * backend (scripts/mock-backend.mjs) and prints one outcome per flow — where
 * it landed and what it said — so two builds can be compared line by line:
 *
 *   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright \
 *     node scripts/flow-check.mjs --base http://127.0.0.1:3100 > before.json
 *   PLAYWRIGHT_MODULE=… node scripts/flow-check.mjs --base http://127.0.0.1:3300 > after.json
 *   node scripts/flow-check.mjs --compare before.json after.json
 *
 * Nothing leaves the machine: requests to Google and to the editor app are
 * intercepted and recorded, never loaded. No real payment is involved (the
 * mock's checkout URL points back at /checkout/success).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { SCENARIOS, mintSession } from "./mock-backend.mjs";

const require = createRequire(import.meta.url);
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};

if (process.argv.includes("--compare")) {
  const [a, b] = process.argv.slice(process.argv.indexOf("--compare") + 1).map((file) => JSON.parse(readFileSync(file, "utf8")));
  let differences = 0;
  for (const name of Object.keys(a)) {
    const same = JSON.stringify(a[name]) === JSON.stringify(b[name]);
    if (!same) differences++;
    console.log(`${same ? "same" : "DIFF"}  ${name}`);
    if (!same) console.log(`   before: ${JSON.stringify(a[name])}\n   after:  ${JSON.stringify(b[name])}`);
  }
  console.log(differences ? `\n${differences} flow(s) differ` : "\nall flows behave the same");
  process.exit(differences ? 1 : 0);
}

const BASE = arg("base", "http://127.0.0.1:3300");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch();

/** A fresh visitor (beta notice already seen unless `beta` is set), optionally signed in as a mock scenario. */
async function visitor({ scn, beta = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  if (!beta) {
    await context.addInitScript(() => {
      try {
        localStorage.setItem("noey.beta-notice.v1", JSON.stringify({ dismissedAt: Date.now(), forever: true }));
      } catch {}
    });
  }
  if (scn) {
    const tokens = mintSession(scn);
    await context.addCookies([
      { name: "noey_at", value: tokens.access_token, url: BASE },
      { name: "noey_rt", value: tokens.refresh_token, url: BASE },
      { name: "noey_si", value: "1", url: BASE },
      { name: "noey_name", value: encodeURIComponent(SCENARIOS[scn]?.name ?? ""), url: BASE },
    ]);
  }
  const outside = [];
  // Never leave the machine: record Google and editor-app navigations, then stop them.
  await context.route(/accounts\.google\.com|localhost:51[0-9][0-9]/, (route) => {
    outside.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  return { context, page, outside };
}

const where = (page) => {
  const url = new URL(page.url());
  return url.pathname + url.search;
};
const said = async (page, selector) =>
  (await page.locator(selector).allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim()).filter(Boolean);
const cookieNames = async (context) => (await context.cookies()).map((cookie) => cookie.name).filter((name) => /noey/i.test(name)).sort();

const flows = {
  async "signup: new account"() {
    const { context, page } = await visitor();
    await page.goto(`${BASE}/signup`);
    await page.getByLabel(/ฉันได้อ่านและยอมรับ/).check();
    await page.locator("#s-name").fill("ทดสอบ");
    await page.locator("#s-email").fill("new@x.test");
    await page.locator("#s-pass").fill("password123");
    await Promise.all([page.waitForURL((url) => !url.pathname.startsWith("/signup")), page.getByRole("button", { name: "สมัครและเริ่มใช้งาน" }).click()]);
    return { at: where(page), cookies: await cookieNames(context) };
  },
  async "signup: email already used"() {
    const { page } = await visitor();
    await page.goto(`${BASE}/signup`);
    await page.getByLabel(/ฉันได้อ่านและยอมรับ/).check();
    await page.locator("#s-email").fill("taken@x.test");
    await page.locator("#s-pass").fill("password123");
    await page.getByRole("button", { name: "สมัครและเริ่มใช้งาน" }).click();
    await page.locator(".form-error, .field-error").first().waitFor();
    return { at: where(page), said: await said(page, ".form-error, .field-error") };
  },
  async "signup: submit waits for the terms tick"() {
    const { page } = await visitor();
    await page.goto(`${BASE}/signup`);
    return { disabled: await page.getByRole("button", { name: "สมัครและเริ่มใช้งาน" }).isDisabled() };
  },
  async "login: right password"() {
    const { context, page } = await visitor();
    await page.goto(`${BASE}/login`);
    await page.locator("#l-email").fill("pro@x.test");
    await page.locator("#l-pass").fill("password123");
    await Promise.all([page.waitForURL((url) => !url.pathname.startsWith("/login")), page.getByRole("button", { name: "เข้าสู่ระบบ", exact: true }).click()]);
    return { at: where(page), cookies: await cookieNames(context) };
  },
  async "login: back to ?next"() {
    const { page } = await visitor();
    await page.goto(`${BASE}/login?next=%2Faccount%2Fbilling`);
    await page.locator("#l-email").fill("pro@x.test");
    await page.locator("#l-pass").fill("password123");
    await Promise.all([page.waitForURL((url) => !url.pathname.startsWith("/login")), page.getByRole("button", { name: "เข้าสู่ระบบ", exact: true }).click()]);
    return { at: where(page) };
  },
  async "login: wrong password"() {
    const { page } = await visitor();
    await page.goto(`${BASE}/login`);
    await page.locator("#l-email").fill("pro@x.test");
    await page.locator("#l-pass").fill("wrong");
    await page.getByRole("button", { name: "เข้าสู่ระบบ", exact: true }).click();
    await page.locator(".form-error").first().waitFor();
    return { at: where(page), said: await said(page, ".form-error") };
  },
  async "login: forgot-password dialog"() {
    const { page } = await visitor();
    await page.goto(`${BASE}/login`);
    await page.getByRole("link", { name: "ลืมรหัสผ่าน" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("อีเมล").fill("pro@x.test");
    await dialog.getByRole("button", { name: "ส่งลิงก์" }).click();
    await dialog.locator(".form-success").waitFor();
    return { said: await said(page, "dialog[open] .form-success") };
  },
  async "google: sign-in start"() {
    const { page, outside } = await visitor();
    await page.goto(`${BASE}/login`);
    await page.getByRole("button", { name: "เข้าสู่ระบบด้วย Google" }).click();
    await page.waitForTimeout(1500);
    return { at: where(page), leftFor: outside.map((url) => new URL(url).host) };
  },
  async "reset password: valid link"() {
    const { page } = await visitor();
    await page.goto(`${BASE}/reset-password?token=ok`);
    await page.getByLabel("รหัสผ่านใหม่", { exact: true }).fill("password123");
    await page.getByLabel("ยืนยันรหัสผ่านใหม่").fill("password123");
    await Promise.all([page.waitForURL((url) => !url.pathname.startsWith("/reset-password")), page.getByRole("button", { name: "ตั้งรหัสผ่านใหม่" }).click()]);
    return { at: where(page) };
  },
  async "account: sign out"() {
    const { context, page } = await visitor({ scn: "pro" });
    await page.goto(`${BASE}/account`);
    const button = page.getByRole("button", { name: "ออกจากระบบ" }).first();
    if (!(await button.isVisible())) await page.locator("header details").first().locator("summary").click();
    await Promise.all([page.waitForURL((url) => url.pathname !== "/account"), page.getByRole("button", { name: "ออกจากระบบ" }).first().click()]);
    return { at: where(page), cookies: await cookieNames(context) };
  },
  async "account: open the editor"() {
    const { page, outside } = await visitor({ scn: "pro" });
    await page.goto(`${BASE}/account`);
    const link = page.locator("main").getByRole("link", { name: /เปิดห้องตัดต่อ/ }).first();
    const href = await link.getAttribute("href");
    const handoff = page.waitForResponse((response) => new URL(response.url()).pathname === href, { timeout: 10000 }).catch(() => null);
    await link.click();
    const response = await handoff;
    await page.waitForTimeout(800);
    const location = response ? response.headers().location ?? "" : "";
    return {
      href,
      status: response ? response.status() : null,
      redirectsTo: location ? new URL(location, BASE).host + new URL(location, BASE).pathname : null,
      leftFor: outside.map((url) => new URL(url).host + new URL(url).pathname),
    };
  },
  async "account: signed-out visit goes to login"() {
    const { page } = await visitor();
    await page.goto(`${BASE}/account/quota`);
    return { at: where(page) };
  },
  async "billing: upgrade to checkout"() {
    const { page } = await visitor({ scn: "free" });
    await page.goto(`${BASE}/account/billing?plan=pro`);
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await dialog.locator('input[name="pay_agree"]').check();
    await dialog.getByRole("button", { name: "ไปหน้าชำระเงิน" }).click();
    await page.waitForURL((url) => url.pathname.startsWith("/checkout"), { timeout: 10000 }).catch(() => {});
    if (!where(page).startsWith("/checkout")) return { at: where(page), stuck: await said(page, "dialog[open] .form-error, dialog[open] .form-success") };
    await page.getByRole("heading", { level: 1 }).waitFor();
    return { at: where(page), title: await said(page, "h1") };
  },
  async "profile: change the name"() {
    const { page } = await visitor({ scn: "pro" });
    await page.goto(`${BASE}/account/profile`);
    await page.getByLabel("ชื่อ", { exact: true }).fill("ชื่อใหม่");
    await page.getByRole("button", { name: "บันทึกการแก้ไข" }).click();
    await page.locator(".form-success").first().waitFor();
    return { said: await said(page, ".form-success") };
  },
  async "profile: delete-account dialog"() {
    const { page } = await visitor({ scn: "pro" });
    await page.goto(`${BASE}/account/profile`);
    await page.getByRole("button", { name: "ลบบัญชี…" }).click();
    const dialog = page.getByRole("dialog");
    return { title: await dialog.getByRole("heading").first().innerText(), confirmDisabled: await dialog.getByRole("button", { name: "ลบบัญชีถาวร" }).isDisabled() };
  },
  async "contact: sent"() {
    const { page } = await visitor();
    await page.goto(`${BASE}/about`);
    await page.getByLabel("ชื่อ").fill("ผู้ทดสอบ");
    await page.getByLabel("อีเมล").fill("tester@x.test");
    await page.getByLabel("อยากถามอะไร").fill("อยากทราบวิธีตัดคลิปรีวิวสินค้าให้เร็วขึ้นครับ");
    await page.getByRole("button", { name: "ส่งข้อความ" }).click();
    await page.locator(".form-success, .form-error").first().waitFor();
    return { said: await said(page, "#contact .form-success, #contact .form-error") };
  },
  async "contact: mail down (503)"() {
    const { page } = await visitor();
    await page.goto(`${BASE}/about`);
    await page.getByLabel("ชื่อ").fill("ผู้ทดสอบ");
    await page.getByLabel("อีเมล").fill("tester@x.test");
    await page.getByLabel("อยากถามอะไร").fill("ทดสอบกรณีระบบส่งอีเมลไม่ได้ fail503 ครับ");
    await page.getByRole("button", { name: "ส่งข้อความ" }).click();
    await page.locator(".form-error").first().waitFor();
    return { said: await said(page, "#contact .form-error"), mailto: await page.locator("#contact .form-error a").getAttribute("href") };
  },
  async "contact: too many (429)"() {
    const { page } = await visitor();
    await page.goto(`${BASE}/about`);
    await page.getByLabel("ชื่อ").fill("ผู้ทดสอบ");
    await page.getByLabel("อีเมล").fill("tester@x.test");
    await page.getByLabel("อยากถามอะไร").fill("ทดสอบกรณีส่งถี่เกินไป fail429 ครับผม");
    await page.getByRole("button", { name: "ส่งข้อความ" }).click();
    await page.locator(".form-error").first().waitFor();
    return { said: await said(page, "#contact .form-error") };
  },
  async "theme: toggle and remember"() {
    const { page } = await visitor();
    await page.goto(`${BASE}/`);
    const before = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    await page.locator("header").getByRole("button", { name: /สลับเป็นโหมด/ }).first().click();
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => [document.documentElement.getAttribute("data-theme"), localStorage.getItem("noey-theme")]);
    await page.reload();
    const reloaded = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    return { flipped: before !== after[0], stored: after[1] === after[0], kept: reloaded === after[0] };
  },
  async "beta notice: first visit, then dismissed"() {
    const { page } = await visitor({ beta: true });
    await page.goto(`${BASE}/`);
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    const title = (await dialog.getByRole("heading").first().innerText()).replace(/\s+/g, " ").trim();
    await dialog.getByRole("button").last().click();
    await page.waitForTimeout(300);
    const closed = !(await dialog.isVisible());
    await page.reload();
    await page.waitForTimeout(1500);
    return { title, closed, staysClosed: !(await page.getByRole("dialog").isVisible()) };
  },
  async "beta strip: reopens the notice"() {
    const { page } = await visitor();
    await page.goto(`${BASE}/pricing`);
    await page.getByRole("button", { name: "รายละเอียด" }).first().click();
    await page.getByRole("dialog").waitFor();
    return { open: await page.getByRole("dialog").isVisible() };
  },
  async "old /examples redirects to /scope"() {
    const { page } = await visitor();
    await page.goto(`${BASE}/examples`);
    return { at: where(page) };
  },
};

const results = {};
for (const [name, run] of Object.entries(flows)) {
  try {
    results[name] = await run();
  } catch (error) {
    results[name] = { error: String(error.message || error).split("\n")[0].slice(0, 200) };
  }
  console.error(`${results[name].error ? "✗" : "✓"} ${name}`);
}
await browser.close();
console.log(JSON.stringify(results, null, 2));
