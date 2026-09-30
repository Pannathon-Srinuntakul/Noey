// Turns the rendered frames into the site's footage files (public/footage):
//   edit.mp4 + edit.webm      the cut the editor mock-ups play: the scene
//                             windows of src/components/mockups/footage.json,
//                             joined in order — the mock-ups' lanes are laid
//                             out from the same list, so a cut in the video
//                             lands exactly on a block edge
//   scene-N.avif / .webp      scene N's middle frame (preview still, reduced
//                             motion, shot swap)
//   <still>.avif / .webp      the extra stills footage.json lists (backup shots)
//   strip.webp                every shot's filmstrip tiles, 54×96, one per half
//                             second — what the editor's lanes and file lists
//                             draw thumbnails from
// Usage: node encode.mjs --frames DIR [--out ../../public/footage]
// DIR is denoise.py's output: the raw renders are too grainy to ship.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const sharp = require(resolve(import.meta.dirname, "../../node_modules/sharp"));

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const FRAMES = resolve(opt("frames", "./frames"));
const OUT = resolve(opt("out", resolve(import.meta.dirname, "../../public/footage")));
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
const footage = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../src/components/mockups/footage.json"), "utf8"));
const { fps: FPS, cut: CUT, shots: SHOTS, tilesPerShot: TILES, stills: STILLS } = footage;
const frameFile = (shot, n) => join(FRAMES, shot, `f${String(n).padStart(4, "0")}.png`);
const TMP = join(OUT, ".tmp");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(TMP, "cut"), { recursive: true });

// The frames stay at the render's 540×960: no mock-up shows the footage wider
// than ~420 device pixels. The grade is a touch of sharpening and a lens
// vignette; the videos add a light temporal smoothing of the grain denoise.py
// left, which would otherwise shimmer (and cost bits).
const GRADE = "unsharp=5:5:0.25,vignette=angle=0.42";
const SMOOTH = "hqdn3d=1:1:4:4";

// 1. The graded cut, as lossless frames: the videos and the scene stills both come from it.
const inputs = [];
const chains = [];
CUT.forEach(({ shot, from, frames }, index) => {
  inputs.push("-framerate", String(FPS), "-start_number", String(from), "-i", join(FRAMES, shot, "f%04d.png"));
  chains.push(`[${index}:v]trim=end_frame=${frames},setpts=PTS-STARTPTS,${SMOOTH},${GRADE}[v${index}]`);
});
const concat = `${CUT.map((_, i) => `[v${i}]`).join("")}concat=n=${CUT.length}:v=1:a=0[out]`;
execFileSync(FFMPEG, ["-y", "-v", "error", ...inputs, "-filter_complex", [...chains, concat].join(";"), "-map", "[out]", join(TMP, "cut", "%04d.png")], { stdio: "inherit" });

// 2. The videos. A keyframe every half second: visitors scrub the mock-up's
// timeline, and a seek decodes from the keyframe before it.
const cutFrames = ["-framerate", String(FPS), "-i", join(TMP, "cut", "%04d.png"), "-pix_fmt", "yuv420p", "-an", "-g", String(FPS / 2)];
execFileSync(FFMPEG, ["-y", "-v", "error", ...cutFrames, "-c:v", "libx264", "-preset", "slow", "-crf", "27", "-profile:v", "high", "-movflags", "+faststart", join(OUT, "edit.mp4")], { stdio: "inherit" });
execFileSync(FFMPEG, ["-y", "-v", "error", ...cutFrames, "-c:v", "libvpx-vp9", "-crf", "38", "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "1", join(OUT, "edit.webm")], { stdio: "inherit" });

// 3. Scene stills: each scene's middle frame of the graded cut (sample.ts sceneStill).
async function still(source, name, width, height) {
  const image = sharp(source).resize(width, height, { fit: "cover" });
  await image.clone().avif({ quality: 50, effort: 6 }).toFile(join(OUT, `${name}.avif`));
  await image.clone().webp({ quality: 72 }).toFile(join(OUT, `${name}.webp`));
}
let first = 0;
for (const [index, { frames }] of CUT.entries()) {
  const middle = first + Math.floor(frames / 2) + 1; // %04d numbering starts at 1
  await still(join(TMP, "cut", `${String(middle).padStart(4, "0")}.png`), `scene-${index + 1}`, 540, 960);
  first += frames;
}

// 4. Extra stills (frames outside the cut): the same grade, spatially, on one frame.
for (const { id, shot, frame } of STILLS) {
  const graded = join(TMP, `${id}.png`);
  execFileSync(FFMPEG, ["-y", "-v", "error", "-i", frameFile(shot, frame), "-vf", GRADE, graded]);
  await still(graded, id, 360, 640);
}

// 5. The filmstrip sprite: tile k of a shot is the frame in the middle of its half second.
const tiles = await Promise.all(
  SHOTS.flatMap((shot) =>
    Array.from({ length: TILES }, (_, k) => sharp(frameFile(shot, Math.min(footage.shotFrames - 1, 12 * k + 6))).resize(54, 96, { fit: "cover" }).png().toBuffer()),
  ),
);
await sharp({ create: { width: 54 * tiles.length, height: 96, channels: 3, background: "#000" } })
  .composite(tiles.map((input, i) => ({ input, left: 54 * i, top: 0 })))
  .webp({ quality: 70 })
  .toFile(join(OUT, "strip.webp"));

rmSync(TMP, { recursive: true, force: true });
let total = 0;
const hash = createHash("sha256");
for (const file of readdirSync(OUT).sort()) {
  const bytes = readFileSync(join(OUT, file));
  hash.update(file).update(bytes);
  total += bytes.length;
  console.log(file.padEnd(22), `${(bytes.length / 1024).toFixed(1)} KB`);
}
console.log("total".padEnd(22), `${(total / 1024 / 1024).toFixed(2)} MB`);

// The files are served as immutable: their URLs carry this version (sample.ts).
const version = hash.digest("hex").slice(0, 10);
writeFileSync(resolve(import.meta.dirname, "../../src/components/mockups/footage-version.json"), `${JSON.stringify({ v: version })}\n`);
console.log("version".padEnd(22), version);
