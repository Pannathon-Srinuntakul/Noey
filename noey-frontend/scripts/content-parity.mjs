#!/usr/bin/env node
/**
 * Content parity for the site redesign: nothing a visitor could read before
 * may silently disappear.
 *
 *   node scripts/content-parity.mjs [--ref <git ref>] [--baseline .redesign-baseline] [--current .redesign-current]
 *
 * (a) Collects every string literal, template-literal part and JSX text that
 *     contains Thai from src/ at the ref the redesign started from (default:
 *     the merge-base of HEAD and main), read with `git show`.
 * (b) Checks each one still exists in src/ now — as a whole string, or inside
 *     a longer one — or is quoted in CONTENT_CHANGES.md, which records every
 *     deliberate rewording (old → new → why). A term changed across the whole
 *     site is recorded once as a line `- Everywhere: "old" → "new"`; a string
 *     that differs only by such terms counts as present.
 * (c) When both crawls exist (scripts/crawl-text.mjs, before and after),
 *     compares what each page shows, line by line: a baseline line counts as
 *     present when the new page contains it (whitespace and case ignored), or
 *     every one of its parts when the new layout splits it up.
 *
 * Exits 1 when anything is missing and not recorded in CONTENT_CHANGES.md.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(import.meta.dirname, "..");

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const REF = arg("ref", null) ?? git("merge-base", "HEAD", "main").trim();
const BASELINE_DIR = resolve(ROOT, arg("baseline", ".redesign-baseline"));
const CURRENT_DIR = resolve(ROOT, arg("current", ".redesign-current"));
const CHANGES_FILE = join(ROOT, "CONTENT_CHANGES.md");

const THAI = /[฀-๿]/;
const ENTITIES = { "&quot;": '"', "&amp;": "&", "&nbsp;": " ", "&lt;": "<", "&gt;": ">", "&#39;": "'", "&apos;": "'" };

const decode = (text) => text.replace(/&(quot|amp|nbsp|lt|gt|#39|apos);/g, (entity) => ENTITIES[entity]);
/** Whitespace-, case- and quote-style-insensitive form used for every comparison. */
const squash = (text) =>
  decode(text)
    .normalize("NFC")
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    // keepThai's word joiners (after "และ", "การ", "ตาม") are invisible glue, not text.
    .replace(/\u2060/g, "")
    .replace(/\s+/g, "");

// ─── (a) + (b): strings in the source ────────────────────────────────────────

function isSourceFile(path) {
  return /\.(ts|tsx)$/.test(path) && !/\.test\.ts$/.test(path) && !path.includes("/test/");
}

/** Thai-bearing string parts of one file, whitespace collapsed. */
function thaiStrings(fileName, source) {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const found = [];
  const keep = (text) => {
    const clean = decode(text).replace(/\s+/g, " ").trim();
    if (clean && THAI.test(clean)) found.push(clean);
  };
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) keep(node.text);
    else if (ts.isTemplateExpression(node)) {
      keep(node.head.text);
      for (const span of node.templateSpans) keep(span.literal.text);
    } else if (ts.isJsxText(node)) keep(node.getText(file));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function baselineStrings() {
  const files = git("ls-tree", "-r", "--name-only", REF, "--", "src")
    .split("\n")
    .filter((path) => path && isSourceFile(path));
  const strings = new Map();
  for (const path of files) {
    const source = git("show", `${REF}:./${path}`);
    for (const text of thaiStrings(path, source)) {
      if (!strings.has(text)) strings.set(text, path);
    }
  }
  return strings;
}

function currentSources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (isSourceFile(full)) out.push(full);
    }
  };
  walk(join(ROOT, "src"));
  return out;
}

/** Site-wide term changes recorded in CONTENT_CHANGES.md: `- Everywhere: "old" → "new"`. */
function substitutions() {
  const text = readFileSync(CHANGES_FILE, "utf8");
  return [...text.matchAll(/^- Everywhere: "([^"]+)" → "([^"]+)"/gm)].map((match) => [match[1], match[2]]);
}

function checkSource(documented) {
  const baseline = baselineStrings();
  const swaps = substitutions();
  const current = new Set();
  for (const file of currentSources()) {
    for (const text of thaiStrings(file, readFileSync(file, "utf8"))) current.add(squash(text));
  }
  const corpus = [...current].join("\u0000");
  const present = (key) => current.has(key) || corpus.includes(key);
  const missing = [];
  for (const [text, path] of baseline) {
    const key = squash(text);
    if (present(key)) continue;
    if (documented.includes(key)) continue;
    const swapped = swaps.reduce((out, [from, to]) => out.split(from).join(to), text);
    if (swapped !== text && present(squash(swapped))) continue;
    missing.push({ text, path });
  }
  return { total: baseline.size, missing };
}

// ─── (c): what each page shows ───────────────────────────────────────────────

/** Values that legitimately differ between two crawls (dates, countdowns, clocks, the year). */
function stabilise(line) {
  return line
    .replace(/\d{1,2} (มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม) \d{4}/g, "<date>")
    .replace(/รีเซ็ตอีกครั้งใน[^·\n]*/g, "รีเซ็ตอีกครั้งใน <n>")
    // A reset's short date ("จันทร์ 5 ต.ค."), counted from the moment of the crawl.
    .replace(/(อาทิตย์|จันทร์|อังคาร|พุธ|พฤหัสบดี|พฤหัส|ศุกร์|เสาร์) \d{1,2} (ม\.ค\.|ก\.พ\.|มี\.ค\.|เม\.ย\.|พ\.ค\.|มิ\.ย\.|ก\.ค\.|ส\.ค\.|ก\.ย\.|ต\.ค\.|พ\.ย\.|ธ\.ค\.)/g, "<day>")
    .replace(/\b\d{1,2}:\d{2}\b/g, "<time>")
    .replace(/© \d{4}/g, "© <year>");
}

function pageLines(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("# ") && !line.startsWith("## "))
    .map((line) => stabilise(line.trim()))
    .filter((line) => /[\p{L}\p{N}]/u.test(line));
}

function checkPages(documented) {
  if (!existsSync(BASELINE_DIR) || !existsSync(CURRENT_DIR)) return null;
  const report = [];
  for (const name of readdirSync(BASELINE_DIR).filter((entry) => entry.endsWith(".txt")).sort()) {
    const currentFile = join(CURRENT_DIR, name);
    if (!existsSync(currentFile)) {
      report.push({ page: name, missing: ["(page not crawled in the current build)"] });
      continue;
    }
    const now = squash(pageLines(currentFile).join("\n"));
    const missing = [];
    for (const line of new Set(pageLines(join(BASELINE_DIR, name)))) {
      const key = squash(line);
      if (now.includes(key) || documented.includes(key)) continue;
      const parts = line.split(/\s*[·•|—]\s*|\s{2,}/).map(squash).filter((part) => part.length > 1);
      if (parts.length > 0 && parts.every((part) => now.includes(part) || documented.includes(part))) continue;
      missing.push(line);
    }
    report.push({ page: name, missing });
  }
  return report;
}

// ─── report ──────────────────────────────────────────────────────────────────

const documented = existsSync(CHANGES_FILE) ? squash(readFileSync(CHANGES_FILE, "utf8")) : "";
let failed = false;

const source = checkSource(documented);
console.log(`(a/b) Thai strings in src/ at ${REF.slice(0, 10)}: ${source.total}, missing now: ${source.missing.length}`);
for (const item of source.missing) console.log(`  - [${item.path}] ${item.text}`);
if (source.missing.length > 0) failed = true;

const pages = checkPages(documented);
if (pages === null) {
  console.log(`(c) skipped: needs both ${relative(ROOT, BASELINE_DIR)}/ and ${relative(ROOT, CURRENT_DIR)}/ (scripts/crawl-text.mjs)`);
} else {
  const missingLines = pages.reduce((sum, page) => sum + page.missing.length, 0);
  console.log(`(c) pages compared: ${pages.length}, lines missing: ${missingLines}`);
  for (const page of pages.filter((entry) => entry.missing.length > 0)) {
    console.log(`  ${page.page}`);
    for (const line of page.missing) console.log(`    - ${line}`);
  }
  if (missingLines > 0) failed = true;
}

console.log(failed ? "\nRESULT: missing content (see above)" : "\nRESULT: 0 missing");
process.exitCode = failed ? 1 : 0;
