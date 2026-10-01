/**
 * The pixel size of an image from its first bytes — WebP (what the blog's
 * media store serves), PNG, JPEG and GIF. Pure: the blog's Markdown images
 * carry no size, and an image without one shifts the text under it when it
 * loads, so the server reads the size once and writes it into the page.
 */

export interface ImageSize {
  width: number;
  height: number;
}

const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));
const u16le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u24le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u32be = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

function sane(width: number, height: number): ImageSize | null {
  return width > 0 && height > 0 && width <= 20_000 && height <= 20_000 ? { width, height } : null;
}

function webp(b: Uint8Array): ImageSize | null {
  if (b.length < 30 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") {
    // Lossy: a key frame's start code, then 14-bit width and height.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return sane(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
    return sane((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === "VP8X") return sane(u24le(b, 24) + 1, u24le(b, 27) + 1);
  return null;
}

function png(b: Uint8Array): ImageSize | null {
  if (b.length < 24 || b[0] !== 0x89 || ascii(b, 1, 3) !== "PNG" || ascii(b, 12, 4) !== "IHDR") return null;
  return sane(u32be(b, 16), u32be(b, 20));
}

function gif(b: Uint8Array): ImageSize | null {
  if (b.length < 10 || !/^GIF8[79]a$/.test(ascii(b, 0, 6))) return null;
  return sane(u16le(b, 6), u16le(b, 8));
}

function jpeg(b: Uint8Array): ImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1];
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // Start-of-frame markers (not DHT 0xc4, JPG 0xc8, DAC 0xcc) carry the size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return sane(u16be(b, at + 7), u16be(b, at + 5));
    }
    at += 2 + u16be(b, at + 2);
  }
  return null;
}

export function imageSize(bytes: Uint8Array): ImageSize | null {
  return webp(bytes) ?? png(bytes) ?? jpeg(bytes) ?? gif(bytes);
}
