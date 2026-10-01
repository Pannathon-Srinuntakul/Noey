// Blog cover renderer — one long-lived process per API worker process,
// spawned and supervised by backend/packages/blog/cover.py.
//
//   HTML + CSS (a subset) --juice--> inline styles --satori-html--> element tree
//   --satori--> SVG (text as paths, shaped with HarfBuzz) --resvg--> PNG
//
// Protocol: one JSON object per line on stdin, one JSON answer per line on
// stdout, strictly in order (the Python side sends one job at a time):
//   {"id": 1, "html": "...", "css": "...", "width": 1600, "height": 900}
//     -> {"id": 1, "ok": true, "png": "<base64>", "ms": 812}
//     -> {"id": 1, "ok": false, "error": "..."}
//   {"id": 2, "cmd": "stats"} -> {"id": 2, "ok": true, "memory": {...}}
//   {"id": 3, "cmd": "svg", "svg": "<svg…>", "width": 512} -> {"id": 3, "ok": true, "png": "<base64>"}
//     (rasterise a trusted SVG — the brand mark — with resvg alone)
// The first line written is {"ready": true, ...} once the fonts are loaded.
// stdin closing (the API process went away) ends this process.
//
// Fonts are read ONCE here and reused for every render. Nothing is fetched:
// the global fetch is replaced, so an <img src="https://..."> cannot reach the
// network (the Python side already refuses such markup; images arrive as
// data: URLs).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";
import { Resvg } from "@resvg/resvg-js";
import juice from "juice";
import satori from "satori";
import { html as toElementTree } from "satori-html";

globalThis.fetch = async () => {
  throw new Error("network access is disabled in the cover renderer");
};

const fontsDir = process.env.NOEY_FONTS_DIR;
const fontList = JSON.parse(process.env.NOEY_COVER_FONTS || "[]");
if (!fontsDir || !fontList.length) {
  process.stderr.write("NOEY_FONTS_DIR / NOEY_COVER_FONTS not set\n");
  process.exit(2);
}
const fonts = fontList.map((f) => ({
  name: f.name,
  weight: f.weight,
  style: "normal",
  data: readFileSync(join(fontsDir, f.file)),
}));

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function memory() {
  const m = process.memoryUsage();
  return { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers };
}

async function render({ html, css, width, height, defaultFont }) {
  const started = Date.now();
  const inlined = juice(`<style>${css || ""}</style>${html}`, {
    removeStyleTags: true,
    preserveMediaQueries: false,
    preserveFontFaces: false,
    preserveKeyFrames: false,
    insertPreservedExtraCss: false,
    applyWidthAttributes: false,
    applyHeightAttributes: false,
  });
  const root =
    `<div style="display:flex;position:relative;overflow:hidden;width:${width}px;height:${height}px;` +
    `font-family:'${defaultFont}';color:#201f1d;background:#f3f2f2">${inlined}</div>`;
  const svg = await satori(toElementTree(root), { width, height, fonts, embedFont: true });
  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: { loadSystemFonts: false },
    background: "rgba(0,0,0,0)",
  })
    .render()
    .asPng();
  return { png: Buffer.from(png).toString("base64"), ms: Date.now() - started };
}

out({ ready: true, fonts: fonts.length, memory: memory() });

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
let chain = Promise.resolve();
rl.on("line", (line) => {
  chain = chain.then(async () => {
    let job;
    try {
      job = JSON.parse(line);
    } catch {
      out({ id: null, ok: false, error: "bad request line" });
      return;
    }
    try {
      if (job.cmd === "stats") {
        out({ id: job.id, ok: true, memory: memory() });
        return;
      }
      if (job.cmd === "svg") {
        const png = new Resvg(job.svg, { fitTo: { mode: "width", value: job.width }, font: { loadSystemFonts: false } })
          .render()
          .asPng();
        out({ id: job.id, ok: true, png: Buffer.from(png).toString("base64") });
        return;
      }
      const result = await render(job);
      out({ id: job.id, ok: true, ...result });
    } catch (err) {
      out({ id: job.id, ok: false, error: String((err && err.message) || err).slice(0, 600) });
    }
  });
});
rl.on("close", () => process.exit(0));
