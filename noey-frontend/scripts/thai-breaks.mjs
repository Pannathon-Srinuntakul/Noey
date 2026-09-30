#!/usr/bin/env node
/**
 * Finds Thai lines that break inside a word: renders each page at each width,
 * reads where every line of text starts (from the layout, not from the
 * source), and checks each line start against a dictionary word split
 * (PyThaiNLP, newmm). A line that starts inside a word — "ความช่วย / เหลือ",
 * "ทุ / กช็อต" — or with ๆ is reported with the page, width and context.
 *
 *   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright \
 *   THAI_PYTHON=/path/to/python-with-pythainlp \
 *     node scripts/thai-breaks.mjs --base http://127.0.0.1:3200 \
 *       [--widths 360,390,1024,1440] [--paths /,/pricing]
 *
 * Exits 1 when a break inside a word is found. Fix them in the copy's
 * rendering (keepThai / keepThaiProse, thai-glossary.json), not by hand-placed
 * line breaks.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const BASE = arg("base", "http://127.0.0.1:3200");
const WIDTHS = arg("widths", "360,390,1024,1440").split(",").map(Number);
const PATHS = arg("paths", "")
  .split(",")
  .filter(Boolean);
const PYTHON = process.env.THAI_PYTHON ?? "python3";
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");

async function routes() {
  if (PATHS.length) return PATHS;
  const xml = await (await fetch(`${BASE}/sitemap.xml`)).text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
}

/** In the page: every block's text, and the character offsets where its lines start. */
function lineStarts() {
  const BLOCK = new Set(["block", "list-item", "table-cell", "flex", "grid", "inline-block", "inline-flex", "table-caption"]);
  const blockOf = (node) => {
    for (let el = node.parentElement; el; el = el.parentElement) if (BLOCK.has(getComputedStyle(el).display)) return el;
    return document.body;
  };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && !el.closest("[aria-hidden='true'], .am, svg, script, style, noscript, [hidden]");
  };
  const groups = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!/[฀-๿]/.test(node.data) || !node.parentElement || !visible(node.parentElement)) continue;
    const block = blockOf(node);
    if (!groups.has(block)) groups.set(block, []);
    groups.get(block).push(node);
  }
  const out = [];
  const range = document.createRange();
  for (const [block, nodes] of groups) {
    let text = "";
    let lastTop = null;
    let lastBottom = null;
    const starts = [];
    for (const node of nodes) {
      for (let i = 0; i < node.data.length; i++) {
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rect = [...range.getClientRects()].find((r) => r.width > 0);
        if (rect) {
          // A new line: this character sits wholly below the last one.
          if (lastBottom !== null && rect.top >= lastBottom - 1 && !/\s/.test(node.data[i])) starts.push(text.length);
          lastTop = rect.top;
          lastBottom = rect.bottom;
        }
        text += node.data[i];
      }
    }
    if (starts.length) out.push({ tag: block.tagName.toLowerCase(), cls: String(block.className).slice(0, 40), text, starts });
  }
  return out;
}

const browser = await chromium.launch({ channel: "chrome" });
const found = [];
for (const width of WIDTHS) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  await context.addInitScript(() => {
    try {
      localStorage.setItem("noey-beta-notice", "seen");
    } catch {}
  });
  const page = await context.newPage();
  for (const path of await routes()) {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 120000 });
    await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach((d) => d.close()));
    await page.evaluate(() => document.fonts.ready);
    for (const block of await page.evaluate(lineStarts)) found.push({ path, width, ...block });
  }
  await context.close();
}
await browser.close();

// Word boundaries from the dictionary tokenizer, for every block at once.
const script = [
  "import json, sys",
  "from pythainlp.tokenize import word_tokenize",
  "texts = json.load(sys.stdin)",
  'print(json.dumps([word_tokenize(t, engine="newmm", keep_whitespace=True) for t in texts], ensure_ascii=False))',
].join("\n");
const tokens = JSON.parse(
  execFileSync(PYTHON, ["-c", script], { input: JSON.stringify(found.map((f) => f.text)), maxBuffer: 256 * 1024 * 1024 }).toString(),
);

const problems = [];
found.forEach((block, i) => {
  const inside = new Map();
  let at = 0;
  for (const token of tokens[i]) {
    for (let k = at + 1; k < at + token.length; k++) inside.set(k, token);
    at += token.length;
  }
  for (const start of block.starts) {
    const word = inside.get(start);
    const repeat = block.text[start] === "ๆ";
    if ((word && /[฀-๿]/.test(word)) || repeat) {
      const context = `${block.text.slice(Math.max(0, start - 14), start)} / ${block.text.slice(start, start + 14)}`;
      problems.push({ path: block.path, width: block.width, where: `${block.tag}.${block.cls}`, word: repeat ? "ๆ" : word, context });
    }
  }
});

const seen = new Set();
for (const p of problems) {
  const key = `${p.path} ${p.width} ${p.context}`;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`${p.path} @${p.width}  [${p.word}]  …${p.context}…  (${p.where})`);
}
console.log(`\n${seen.size} breaks inside words on ${new Set(problems.map((p) => p.path)).size} pages (${WIDTHS.join(", ")} px)`);
process.exitCode = seen.size ? 1 : 0;
