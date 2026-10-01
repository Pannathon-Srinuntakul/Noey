// Procedural textures for the footage renderer: everything is generated here,
// nothing is downloaded. Canvas 2D + a small value-noise, so the scenes get
// stone, linen, wood and paper surfaces with real texture.
import * as THREE from "three";

/** Deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable value noise on a grid, bilinear, with fractal octaves. */
export function makeNoise(seed, size = 256) {
  const random = rng(seed);
  const grid = new Float32Array(size * size).map(() => random());
  const at = (x, y) => grid[((y % size) + size) % size * size + (((x % size) + size) % size)];
  const smooth = (t) => t * t * (3 - 2 * t);
  const value = (x, y) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = smooth(x - x0);
    const fy = smooth(y - y0);
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
    return a + (b - a) * fy;
  };
  return (x, y, octaves = 5) => {
    let sum = 0;
    let amp = 0.5;
    let freq = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += value(x * freq, y * freq) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  };
}

function canvas(size) {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  return c;
}

/** Height field → tangent-space normal map. */
function normalFromHeight(heights, size, strength) {
  const c = canvas(size);
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  const h = (x, y) => heights[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * strength;
      const dy = (h(x, y + 1) - h(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      img.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function colorTexture(c) {
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

function grayTexture(c) {
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Travertine: warm cream stone with elongated pores and faint banding. */
export function travertine(seed = 3, size = 1024) {
  const noise = makeNoise(seed, 128);
  const pores = makeNoise(seed + 11, 256);
  const color = canvas(size);
  const rough = canvas(size);
  const cctx = color.getContext("2d");
  const rctx = rough.getContext("2d");
  const cimg = cctx.createImageData(size, size);
  const rimg = rctx.createImageData(size, size);
  const heights = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      // Bands run along x, stretched like sedimentary layers.
      const band = noise(u * 3, v * 22, 5);
      const cloud = noise(u * 9, v * 9, 4);
      // Pores: thin horizontal lens shapes.
      const p = pores(u * 40, v * 160, 3);
      const pore = p > 0.72 ? Math.min(1, (p - 0.72) * 6) : 0;
      const tone = 0.86 + (band - 0.5) * 0.12 + (cloud - 0.5) * 0.06 - pore * 0.28;
      const i = (y * size + x) * 4;
      cimg.data[i] = 236 * tone;
      cimg.data[i + 1] = 221 * tone;
      cimg.data[i + 2] = 197 * tone;
      cimg.data[i + 3] = 255;
      const r = 0.62 + pore * 0.3 + (cloud - 0.5) * 0.1;
      rimg.data[i] = rimg.data[i + 1] = rimg.data[i + 2] = Math.min(255, r * 255);
      rimg.data[i + 3] = 255;
      heights[y * size + x] = band * 0.4 + cloud * 0.2 - pore * 1.2;
    }
  }
  cctx.putImageData(cimg, 0, 0);
  rctx.putImageData(rimg, 0, 0);
  return { map: colorTexture(color), roughnessMap: grayTexture(rough), normalMap: normalFromHeight(heights, size, 3.2) };
}

/** Linen: a fine plain weave with slubs, in a warm oat colour. */
export function linen(seed = 5, size = 1024, base = [214, 199, 176]) {
  const slub = makeNoise(seed, 256);
  const cloud = makeNoise(seed + 3, 64);
  const color = canvas(size);
  const ctx = color.getContext("2d");
  const img = ctx.createImageData(size, size);
  const heights = new Float32Array(size * size);
  const threads = 180;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const wx = Math.sin(u * threads * Math.PI * 2);
      const wy = Math.sin(v * threads * Math.PI * 2);
      const over = ((Math.floor(u * threads) + Math.floor(v * threads)) & 1) === 0;
      const weave = over ? wx * 0.5 + 0.5 : wy * 0.5 + 0.5;
      const s = slub(u * 6, v * 90, 3) * 0.6 + slub(u * 90, v * 6, 3) * 0.4;
      const c = cloud(u * 4, v * 4, 3);
      const tone = 0.9 + (weave - 0.5) * 0.1 + (s - 0.5) * 0.12 + (c - 0.5) * 0.08;
      const i = (y * size + x) * 4;
      img.data[i] = base[0] * tone;
      img.data[i + 1] = base[1] * tone;
      img.data[i + 2] = base[2] * tone;
      img.data[i + 3] = 255;
      heights[y * size + x] = weave * 0.6 + s * 0.4;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { map: colorTexture(color), normalMap: normalFromHeight(heights, size, 1.6) };
}

/** Oak: straight grain with rays and soft figure. */
export function oak(seed = 9, size = 1024) {
  const figure = makeNoise(seed, 128);
  const fine = makeNoise(seed + 7, 256);
  const color = canvas(size);
  const rough = canvas(size);
  const ctx = color.getContext("2d");
  const rctx = rough.getContext("2d");
  const img = ctx.createImageData(size, size);
  const rimg = rctx.createImageData(size, size);
  const heights = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const warp = figure(u * 2, v * 8, 4) * 6;
      const ring = Math.sin((u * 38 + warp) * Math.PI);
      const grain = fine(u * 220, v * 6, 3);
      const tone = 0.78 + ring * 0.07 + (grain - 0.5) * 0.18;
      const i = (y * size + x) * 4;
      img.data[i] = 182 * tone;
      img.data[i + 1] = 140 * tone;
      img.data[i + 2] = 98 * tone;
      img.data[i + 3] = 255;
      const r = 0.55 + (grain - 0.5) * 0.2;
      rimg.data[i] = rimg.data[i + 1] = rimg.data[i + 2] = r * 255;
      rimg.data[i + 3] = 255;
      heights[y * size + x] = ring * 0.3 + grain * 0.7;
    }
  }
  ctx.putImageData(img, 0, 0);
  rctx.putImageData(rimg, 0, 0);
  return { map: colorTexture(color), roughnessMap: grayTexture(rough), normalMap: normalFromHeight(heights, size, 1.2) };
}

/**
 * The bottle's paper label: no brand, only the kind of product and its
 * volume. Set large enough to stay legible in a 540px-wide frame — small
 * letter-spaced print breaks apart at that size and reads as a render.
 */
export function label(size = 1024) {
  const c = document.createElement("canvas");
  c.width = size * 2;
  c.height = size;
  const ctx = c.getContext("2d");
  const paper = makeNoise(21, 128);
  const img = ctx.createImageData(c.width, c.height);
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const t = 0.97 + (paper(x / 40, y / 40, 3) - 0.5) * 0.05;
      const i = (y * c.width + x) * 4;
      img.data[i] = 244 * t;
      img.data[i + 1] = 238 * t;
      img.data[i + 2] = 226 * t;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // The front panel is the middle of the band (u = 0.5).
  const cx = c.width / 2;
  ctx.fillStyle = "#2b2622";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `600 ${size * 0.066}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.letterSpacing = `${size * 0.014}px`;
  ctx.fillText("FACE SERUM", cx, size * 0.27);
  ctx.letterSpacing = "0px";
  ctx.fillRect(cx - size * 0.09, size * 0.365, size * 0.18, size * 0.006);
  ctx.font = `400 ${size * 0.18}px Georgia, "Times New Roman", serif`;
  ctx.fillText("Serum", cx, size * 0.55);
  ctx.font = `500 ${size * 0.06}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillText("30 ml", cx, size * 0.79);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * The carton's printed panels: uncoated board with a faint fibre, the
 * label's type set larger on the front with a gold rule, and a plain side
 * with the volume. Returns { front, side } textures (portrait, 1:2.9).
 */
export function carton(size = 512) {
  const panel = (draw) => {
    const c = document.createElement("canvas");
    c.width = size;
    c.height = Math.round(size * 2.9);
    const ctx = c.getContext("2d");
    const fibre = makeNoise(31, 128);
    const img = ctx.createImageData(c.width, c.height);
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const t = 0.965 + (fibre(x / 30, y / 30, 3) - 0.5) * 0.045 + (fibre(x / 3, y / 90, 1) - 0.5) * 0.02;
        const i = (y * c.width + x) * 4;
        img.data[i] = 239 * t;
        img.data[i + 1] = 231 * t;
        img.data[i + 2] = 216 * t;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    ctx.fillStyle = "#2b2622";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    draw(ctx, c.width / 2, c.height);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  };
  const sans = (weight, px) => `${weight} ${px}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  const front = panel((ctx, cx, H) => {
    ctx.font = sans(600, size * 0.07);
    ctx.letterSpacing = `${size * 0.016}px`;
    ctx.fillText("FACE SERUM", cx, H * 0.36);
    ctx.letterSpacing = "0px";
    ctx.fillStyle = "#b8933f";
    ctx.fillRect(cx - size * 0.1, H * 0.405, size * 0.2, size * 0.008);
    ctx.fillStyle = "#2b2622";
    ctx.font = `400 ${size * 0.19}px Georgia, "Times New Roman", serif`;
    ctx.fillText("Serum", cx, H * 0.48);
    ctx.font = sans(500, size * 0.06);
    ctx.fillText("30 ml · 1 fl oz", cx, H * 0.88);
  });
  const side = panel((ctx, cx, H) => {
    ctx.font = sans(500, size * 0.055);
    ctx.fillText("30 ml", cx, H * 0.9);
  });
  return { front, side };
}

/** Turned metal: fine rings round the part, a little uneven, as a roughness map. */
export function brushed(seed = 13, size = 256) {
  const noise = makeNoise(seed, 64);
  const c = canvas(size);
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    const ring = noise(0.5, y / 3, 2);
    for (let x = 0; x < size; x++) {
      const v = 0.16 + ring * 0.14 + (noise(x / 24, y / 24, 3) - 0.5) * 0.08;
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.max(0, Math.min(1, v)) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return grayTexture(c);
}

/** A pebble's surface: its tint, mottled, with a few darker specks. */
export function mottled(seed, tint, size = 256) {
  const noise = makeNoise(seed, 64);
  const specks = rng(seed + 5);
  const base = new THREE.Color(tint);
  const c = canvas(size);
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = 0.9 + (noise(x / 30, y / 30, 4) - 0.5) * 0.35;
      const i = (y * size + x) * 4;
      img.data[i] = Math.min(255, base.r * 255 * t);
      img.data[i + 1] = Math.min(255, base.g * 255 * t);
      img.data[i + 2] = Math.min(255, base.b * 255 * t);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  ctx.fillStyle = "rgba(40, 34, 28, 0.35)";
  for (let k = 0; k < 90; k++) {
    ctx.beginPath();
    ctx.arc(specks() * size, specks() * size, 0.6 + specks() * 1.4, 0, Math.PI * 2);
    ctx.fill();
  }
  return colorTexture(c);
}
