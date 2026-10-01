// Quick look: one frame per shot, timed. Usage: node preview.mjs [samples] [shot...]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
const samples = Number(process.argv[2] ?? 48);
const only = process.argv.slice(3);
const OUT = process.env.OUT ?? "./out-preview";
mkdirSync(OUT, { recursive: true });
const server = spawn("npx", ["vite", "--port", "5311", "--strictPort"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ headless: true, args: [`--use-angle=${process.env.ANGLE ?? "gl"}`, "--enable-gpu", "--ignore-gpu-blocklist"] });
try {
  for (const shot of only.length ? only : ["pedestal", "texture", "turntable", "flatlay", "rack"]) {
    const page = await browser.newPage({ viewport: { width: 720, height: 1280 } });
    page.on("pageerror", (e) => console.log(shot, "pageerror", e.message));
    await page.goto(`http://localhost:5311/?shot=${shot}${process.env.QS ? "&" + process.env.QS : ""}`);
    await page.waitForFunction(() => window.ready === true, null, { timeout: 60000 });
    const duration = await page.evaluate(() => window.shotDuration);
    for (const at of process.env.AT ? [Number(process.env.AT)] : [0, duration * 0.5]) {
      const start = Date.now();
      const data = await page.evaluate(([t, s]) => window.renderFrame(t, s), [at, samples]);
      writeFileSync(`${OUT}/${shot}-${at.toFixed(2)}.png`, Buffer.from(data.split(",")[1], "base64"));
      console.log(shot, at.toFixed(2), `${samples} spp in ${((Date.now() - start) / 1000).toFixed(1)}s`);
    }
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}
