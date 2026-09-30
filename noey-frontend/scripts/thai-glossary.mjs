// Builds src/components/ds/thai-glossary.json: the Thai words in the site's
// copy that Chrome's line breaker can cut in the middle.
//
// Browsers break Thai with ICU's dictionary, which lacks many loanwords and
// compounds: "ทุกช็อต" breaks as ทุ|กช็อต, "ความช่วยเหลือ" as ความช่วย|เหลือ,
// "รับผิดชอบ" as รับผิด|ชอบ. This script reads every Thai run in src/,
// splits it into words with PyThaiNLP's dictionary tokenizer (newmm, a far
// larger word list), and keeps each word that ICU — Node's Intl.Segmenter,
// the same library Chrome uses — puts a boundary inside, in its context.
// ThaiText.tsx keeps those words on one line.
//
// Usage: THAI_PYTHON=/path/to/python node scripts/thai-glossary.mjs
// (a Python with pythainlp; backend/.venv has it). Run it again when the
// copy changes; the output is committed.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, "src");
const OUT = join(SRC, "components/ds/thai-glossary.json");
const PYTHON = process.env.THAI_PYTHON ?? "python3";

const THAI_RUN = /[฀-๿]+(?:[  ]+[฀-๿]+)*/g;

function* sourceFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      // The app mock-ups copy the editor's own words; the scratch lab is not shipped.
      if (name === "mock-lab") continue;
      yield* sourceFiles(path);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield path;
  }
}

const runs = new Set();
for (const file of sourceFiles(SRC)) {
  for (const match of readFileSync(file, "utf8").matchAll(THAI_RUN)) runs.add(match[0].replace(/ /g, " "));
}

// newmm tokens for every run, in one Python call.
const script = [
  "import json, sys",
  "from pythainlp.tokenize import word_tokenize",
  "runs = json.load(sys.stdin)",
  'print(json.dumps([word_tokenize(r, engine="newmm", keep_whitespace=True) for r in runs], ensure_ascii=False))',
].join("\n");
const list = [...runs];
const tokenized = JSON.parse(execFileSync(PYTHON, ["-c", script], { input: JSON.stringify(list), maxBuffer: 64 * 1024 * 1024 }).toString());

const segmenter = new Intl.Segmenter("th", { granularity: "word" });
const glossary = new Set();
list.forEach((run, i) => {
  const icu = new Set();
  for (const piece of segmenter.segment(run)) icu.add(piece.index);
  let at = 0;
  for (const token of tokenized[i]) {
    const start = at;
    at += token.length;
    if (!/[฀-๿]/.test(token) || token.length < 2) continue;
    for (let k = start + 1; k < at; k++) {
      if (icu.has(k)) {
        glossary.add(token);
        break;
      }
    }
  }
});

const words = [...glossary].sort((a, b) => a.localeCompare(b, "th"));
writeFileSync(OUT, `${JSON.stringify(words, null, 0).replace(/","/g, '",\n"').replace(/^\[/, "[\n").replace(/\]$/, "\n]")}\n`);
console.log(`${relative(ROOT, OUT)}: ${words.length} words from ${list.length} Thai runs`);
