// Renders every frame of every shot to PNG (resumable: frames already on disk
// are skipped). Usage:
//   PLAYWRIGHT_MODULE=/path/to/playwright node render.mjs --out DIR [--w 540 --h 960 --spp 56 --fps 24] [shot…]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const OUT = opt("out", "./frames");
const W = Number(opt("w", 540));
const H = Number(opt("h", 960));
const SPP = Number(opt("spp", 56));
const FPS = Number(opt("fps", 24));
const AT = opt("at", null); // render a single moment (posters)
const shots = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const ALL = ["pedestal", "texture", "turntable", "flatlay", "rack"];

const server = spawn("npx", ["vite", "--port", "5311", "--strictPort"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 2500));
// ANGLE's Metal backend mis-refracts in the path tracer's shader (glass renders
// black); the OpenGL backend is correct and just as fast on this machine.
// A fresh browser per shot: after a long run the GPU process can drop its
// context (frames come back empty) or fall back to software (minutes a frame).
const launch = () => chromium.launch({ headless: true, args: ["--use-angle=gl", "--enable-gpu", "--ignore-gpu-blocklist"] });
let browser = await launch();
async function openShot(shot) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on("pageerror", (e) => console.log(shot, "pageerror", e.message));
  await page.goto(`http://localhost:5311/?shot=${shot}&w=${W}&h=${H}`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 60000 });
  return page;
}
try {
  for (const shot of shots.length ? shots : ALL) {
    const dir = `${OUT}/${shot}`;
    mkdirSync(dir, { recursive: true });
    await browser.close();
    browser = await launch();
    let page = await openShot(shot);
    const duration = await page.evaluate(() => window.shotDuration);
    const times = AT !== null ? [Number(AT)] : Array.from({ length: Math.round(duration * FPS) }, (_, i) => i / FPS);
    const started = Date.now();
    let rendered = 0;
    for (const [index, t] of times.entries()) {
      const file = AT !== null ? `${dir}/poster.png` : `${dir}/f${String(index).padStart(4, "0")}.png`;
      if (existsSync(file)) continue;
      for (let attempt = 1; ; attempt += 1) {
        const data = await page.evaluate(([time, spp]) => window.renderFrame(time, spp), [t, SPP]).catch((e) => {
          console.log(shot, index, "render failed:", e.message);
          return "";
        });
        // A lost context hands back an empty canvas: a few KB instead of ~1 MB.
        if (data.length > 200_000) {
          writeFileSync(file, Buffer.from(data.split(",")[1], "base64"));
          break;
        }
        if (attempt === 3) throw new Error(`${shot} frame ${index}: empty after 3 tries`);
        console.log(`${shot} ${index}: empty frame, restarting the browser`);
        await browser.close();
        browser = await launch();
        page = await openShot(shot);
      }
      rendered += 1;
      if (index % 12 === 0) console.log(`${shot} ${index + 1}/${times.length} · ${((Date.now() - started) / 1000 / rendered).toFixed(1)}s/frame`);
    }
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}
