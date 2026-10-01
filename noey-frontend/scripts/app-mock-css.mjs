// Builds src/components/mockups/app/app.css — the layout styles for the site's
// editor mock-ups.
//
// The mock-ups in src/components/mockups/app/ follow the real editor's markup
// (web/src): the same structure and the same Tailwind class names, so every
// panel sits where the app puts it, at the app's proportions. This script
// compiles those class names with the editor's own Tailwind and theme
// (web/src/assets/main.css), and then makes the result a drawing in the
// site's own style, safe to drop into this site:
//   - the app's colours become the site's tokens (light and dark follow the
//     site's theme; owner's decision, 2026-10-01) — the theme variables are
//     remapped in mock.css, the literal colours here;
//   - every selector is scoped under `.am` (a mock-up's root), so nothing leaks
//     into the site and the site's global rules do not reach in;
//   - rem becomes px, so a mock-up keeps its layout at any browser font size;
//   - viewport units and breakpoints become container units and container
//     queries against the mock-up's own window (`.am` is a size container), so
//     a 1280px-wide mock-up lays out like a 1280px browser window even on a
//     phone;
//   - cascade layers are flattened (the site's CSS is not layered).
//
// Usage: node scripts/app-mock-css.mjs [--web ../web]
// Needs web/'s dependencies installed (read only; nothing in web/ is changed).
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const ROOT = resolve(import.meta.dirname, "..");
const WEB = resolve(opt("web", join(ROOT, "..", "web")));
const MOCK = join(ROOT, "src/components/mockups/app");
const OUT = join(MOCK, "app.css");

const requireWeb = createRequire(join(WEB, "package.json"));
const { compile, optimize } = await import(pathToFileURL(requireWeb.resolve("@tailwindcss/node")).href);
const { Scanner } = requireWeb("@tailwindcss/oxide");
const { transform } = requireWeb("lightningcss");

/** The `@theme { … }` block of the editor's stylesheet, verbatim. */
function editorTheme() {
  const css = readFileSync(join(WEB, "src/assets/main.css"), "utf8");
  const start = css.indexOf("@theme {");
  if (start === -1) throw new Error("no @theme block in web/src/assets/main.css");
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error("unterminated @theme block");
}

// Imported without layer(): the site's CSS is not layered, and layered rules
// would lose to every unlayered site rule whatever their specificity.
const input = [
  '@import "tailwindcss/theme.css";',
  '@import "tailwindcss/preflight.css";',
  '@import "tailwindcss/utilities.css";',
  editorTheme(),
].join("\n");

const compiler = await compile(input, { base: WEB, onDependency: () => {} });
const candidates = new Scanner({ sources: [{ base: MOCK, pattern: "**/*.tsx", negated: false }] }).scan();
const built = optimize(compiler.build(candidates), { minify: false }).code;

/**
 * `css` with every block opened by a match of `open` rewritten by `keep`
 * (given the block's body, it returns what replaces the whole block).
 */
function rewriteBlocks(css, open, keep) {
  let out = "";
  let at = 0;
  for (const match of css.matchAll(open)) {
    if (match.index < at) continue;
    const start = match.index;
    let depth = 0;
    let end = start + match[0].length - 1;
    for (; end < css.length; end += 1) {
      if (css[end] === "{") depth += 1;
      else if (css[end] === "}" && --depth === 0) break;
    }
    out += css.slice(at, start) + keep(css.slice(start + match[0].length, end));
    at = end + 1;
  }
  return out + css.slice(at);
}

// Any layer Tailwind still emits (the @property fallbacks) is unwrapped too.
const unlayered = rewriteBlocks(built.replace(/@layer [\w-]+(, *[\w-]+)*;/g, ""), /@layer [\w-]+ *\{/g, (body) => body);

const PX_PER_REM = 16;
const VIEWPORT = { vh: "cqh", dvh: "cqh", svh: "cqh", lvh: "cqh", vw: "cqw", dvw: "cqw", svw: "cqw", lvw: "cqw" };
const scope = [
  { type: "class", name: "am" },
  { type: "combinator", value: "descendant" },
];
const isRoot = (part) =>
  (part.type === "pseudo-class" && (part.kind === "root" || part.kind === "host")) ||
  (part.type === "type" && part.name === "html");

const unit = (length) => {
  if (length.unit === "rem") return { unit: "px", value: Math.round(length.value * PX_PER_REM * 1000) / 1000 };
  if (VIEWPORT[length.unit]) return { unit: VIEWPORT[length.unit], value: length.value };
  return length;
};

const { code } = transform({
  filename: "app.css",
  code: Buffer.from(unlayered),
  minify: true,
  visitor: {
    Selector(selector) {
      if (selector.length && isRoot(selector[0])) return [{ type: "class", name: "am" }, ...selector.slice(1)];
      return [...scope, ...selector];
    },
    Length: unit,
    Token: {
      dimension(token) {
        const next = unit({ unit: token.unit, value: token.value });
        return next === token ? token : { type: "dimension", unit: next.unit, value: next.value };
      },
    },
  },
});

/** The editor's literal colours → the site token each one stands for. */
const SITE_COLOR = {
  f3f2f2: "--ink",
  e4e2df: "--ink-2",
  d6d3cf: "--ink-2",
  a3a09c: "--ink-3",
  "8a8681": "--ink-3",
  d9a441: "--gold",
  c28d41: "--gold-deep",
  f0c274: "--gold-ink",
  e08b84: "--danger",
  "68b184": "--success",
  "171614": "--bg",
  "1c1c1e": "--bg",
  "211f1d": "--surface",
  "2a2825": "--panel-2",
  "1e1c19": "--panel",
  "191715": "--well",
  "0e0d0c": "--well",
};
const toSite = (css) =>
  // (?<!\\): a hex in a declaration, not an escaped one in a class name (bg-\[\#1e1c19\]).
  css.replace(/(?<!\\)#([0-9a-f]{6})([0-9a-f]{2})?\b/gi, (hex, rgb, alpha) => {
    const token = SITE_COLOR[rgb.toLowerCase()];
    if (!token) return hex;
    if (!alpha) return `var(${token})`;
    return `color-mix(in srgb,var(${token}) ${Math.round((parseInt(alpha, 16) / 255) * 100)}%,transparent)`;
  });

// Interaction never happens in an illustration: hover rules go. Breakpoints
// answer to the mock-up's window, not the browser's. Colours become the site's.
const css = rewriteBlocks(toSite(code.toString()), /@media \(hover:hover\)\{/g, () => "")
  .replace(/@media \(width>=([\d.]+)px\)/g, "@container am (width>=$1px)")
  .replace(/@media \(min-width:([\d.]+)px\)/g, "@container am (width>=$1px)")
  // Lengths the visitor does not reach (arbitrary values such as min-h-[46dvh]).
  .replace(/(\d*\.?\d+)(?:dvh|svh|lvh|vh)\b/g, "$1cqh")
  .replace(/(\d*\.?\d+)(?:dvw|svw|lvw|vw)\b/g, "$1cqw");

const header = `/* Generated by scripts/app-mock-css.mjs from web/src (Tailwind ${requireWeb("tailwindcss/package.json").version}) — do not edit. */\n`;
writeFileSync(OUT, header + css + "\n");
console.log(`${OUT}: ${candidates.length} candidates, ${(css.length / 1024).toFixed(1)} KB`);
