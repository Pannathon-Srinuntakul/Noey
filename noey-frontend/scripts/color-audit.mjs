#!/usr/bin/env node
/**
 * Colour and font audit for the redesign: every colour written in src/ must
 * be one of the design tokens, and every font must be the site's.
 *
 *   node scripts/color-audit.mjs
 *
 * Allowed colour literals are the values of the `--color-*` tokens declared
 * in src/app/globals.css (light and dark). Everything else is expected to be
 * a `var(--…)` token or a `color-mix()` of tokens (tints, shades, opacity).
 * Two documented exceptions:
 *   - the "Sign in with Google" button (`.gsi-button` in
 *     styles/parts/google.css and the "G" in GoogleButton.tsx): its colours
 *     are Google's, required by the branding guidelines;
 *   - the editor mock-ups (src/components/mockups/app/): pictures of the app,
 *     drawn in the app's own dark theme, colours and fonts included
 *     (MOCKUP_FIX_PROMPT.md: the editor's theme, not the site's);
 *   - keywords that are not colours: transparent, currentColor, inherit;
 *     and mask gradients, where only the alpha channel counts.
 *
 * Fonts: only the token variables (--font-*), "Noto Sans Thai", and the
 * generic fallbacks may appear in font-family; plus Google Sans inside the
 * Google button.
 *
 * Exits 1 on any finding.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(css|tsx|ts)$/.test(entry) && !/\.test\.ts$/.test(entry)) out.push(path);
  }
  return out;
}

const HEX = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/gi;
const FUNC = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([^)]*\)/gi;
const NAMED = /(?<![\w-])(?:white|black|red|green|blue|gray|grey|silver|orange|yellow|purple|pink|brown|gold|navy|teal|maroon|olive|lime|aqua|fuchsia)(?![\w-])/gi;

/**
 * #rgb, #rgba, #rrggbb, #rrggbbaa → #rrggbb. The alpha channel is dropped on
 * purpose: a token at some opacity is still that token (the design allows
 * tints and opacity of the palette, never a new hue).
 */
function normalizeHex(hex) {
  let value = hex.slice(1).toLowerCase();
  if (value.length === 3 || value.length === 4) value = [...value].map((c) => c + c).join("");
  return `#${value.slice(0, 6)}`;
}

/** rgb()/rgba() with integer channels → #rrggbb (alpha dropped, as above). */
function normalizeFunc(text) {
  const match = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(text.trim());
  if (!match) return text.replace(/\s+/g, "").toLowerCase();
  const [r, g, b] = match.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, "0"));
  return `#${r}${g}${b}`;
}

// ── the allowed set: values of the --color-* tokens ──
const globals = readFileSync(join(SRC, "app/globals.css"), "utf8");
const allowed = new Set();
for (const [, value] of globals.matchAll(/--color-[\w-]+:\s*([^;]+);/g)) {
  for (const hex of value.match(HEX) ?? []) allowed.add(normalizeHex(hex));
  for (const fn of value.match(FUNC) ?? []) allowed.add(normalizeFunc(fn));
}

/** Line ranges of the Google button rules (brand colours by requirement). */
function googleRanges(file, text) {
  if (!file.endsWith("app/globals.css") && !file.endsWith("styles/parts/google.css")) return [];
  const ranges = [];
  const lines = text.split("\n");
  let inside = false;
  let depth = 0;
  lines.forEach((line, index) => {
    if (!inside && /\.gsi-button/.test(line) && line.includes("{")) inside = true;
    if (inside) {
      depth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
      ranges.push(index + 1);
      if (depth <= 0) inside = false;
    }
  });
  return ranges;
}

const findings = [];
const fontFindings = [];
const FONT_OK = /^(var\(--font-[\w-]+\)|"?Noto Sans Thai"?|system-ui|sans-serif|serif|monospace|inherit|-apple-system|"Google Sans"|Roboto|Arial)$/i;

/** Files whose colours are someone else's brand, by requirement. */
const BRAND_FILES = new Set(["src/components/auth/GoogleButton.tsx"]);
/** The editor replica: its colours and fonts are the app's theme, by requirement. */
const APP_REPLICA = "src/components/mockups/app/";

for (const file of walk(SRC)) {
  // Blank out comments (keeping line numbers): colours named in prose are not colours used.
  const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const rel = relative(ROOT, file);
  if (BRAND_FILES.has(rel) || rel.startsWith(APP_REPLICA)) continue;
  const google = new Set(googleRanges(file, text));
  const isCss = file.endsWith(".css");
  text.split("\n").forEach((line, index) => {
    const lineNo = index + 1;
    const code = line.replace(/\/\*.*?\*\//g, "").replace(/^\s*(\*|\/\/).*$/, "");
    if (!code.trim()) return;
    // Token declarations themselves are the allowed set.
    if (/--color-[\w-]+:/.test(code) && rel === "src/app/globals.css") return;
    if (google.has(lineNo)) return;
    // A mask only reads alpha: the colour in a mask gradient is never seen.
    if (/(?:^|[\s;{-])mask(?:-image)?\s*:/.test(code)) return;
    // In TS/TSX only look at style-ish code: CSS text, style props, SVG colour attributes, theme colours.
    if (!isCss && !/(style|color|fill|stroke|background|border|shadow|theme|stop)/i.test(code)) return;
    const literals = [
      ...(code.match(HEX) ?? []).map((hex) => ({ raw: hex, key: normalizeHex(hex) })),
      ...(code.match(FUNC) ?? []).map((fn) => ({ raw: fn, key: normalizeFunc(fn) })),
    ];
    for (const literal of literals) {
      // `#` followed by digits inside an id/url fragment is not a colour.
      if (/url\(#|href="#|#main|#contact|#[a-z-]+-(?:section|heading)/i.test(code) && !/^#[0-9a-f]+$/i.test(literal.raw)) continue;
      if (!allowed.has(literal.key)) findings.push(`${rel}:${lineNo}  ${literal.raw}`);
    }
    if (isCss) {
      for (const match of code.matchAll(/(?:^|[;{\s])(?:color|background(?:-color)?|fill|stroke|border(?:-[a-z]+)?-color|outline-color)\s*:\s*([^;]+)/gi)) {
        for (const named of match[1].match(NAMED) ?? []) findings.push(`${rel}:${lineNo}  ${named} (named colour)`);
      }
    }
    for (const match of code.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
      for (const family of match[1].split(",").map((part) => part.trim().replace(/['`]/g, '"'))) {
        if (!FONT_OK.test(family) && !google.has(lineNo)) fontFindings.push(`${rel}:${lineNo}  ${family}`);
      }
    }
  });
}

console.log(`Token colour values: ${allowed.size}`);
console.log(`Colours outside the tokens: ${findings.length}`);
for (const finding of findings) console.log(`  ${finding}`);
console.log(`Fonts outside the site's: ${fontFindings.length}`);
for (const finding of fontFindings) console.log(`  ${finding}`);
process.exitCode = findings.length || fontFindings.length ? 1 : 0;
