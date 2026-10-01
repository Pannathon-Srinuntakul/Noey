import { describe, expect, it } from "vitest";
import { imageSize } from "./image-size";

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(parts.flatMap((part) => (typeof part === "string" ? [...part].map((c) => c.charCodeAt(0)) : part)));

describe("imageSize", () => {
  it("reads lossy, lossless and extended WebP", () => {
    // VP8: 1600×900 (14-bit little-endian after the 9d 01 2a start code).
    const vp8 = bytes("RIFF", [0, 0, 0, 0], "WEBP", "VP8 ", [0, 0, 0, 0], [0, 0, 0], [0x9d, 0x01, 0x2a], [0x40, 0x06, 0x84, 0x03]);
    expect(imageSize(vp8)).toEqual({ width: 1600, height: 900 });
    // VP8X: canvas 1400×700 stored minus one, 24-bit.
    const vp8x = bytes("RIFF", [0, 0, 0, 0], "WEBP", "VP8X", [10, 0, 0, 0], [0, 0, 0, 0], [0x77, 0x05, 0x00], [0xbb, 0x02, 0x00]);
    expect(imageSize(vp8x)).toEqual({ width: 1400, height: 700 });
    // VP8L: 14-bit fields packed after the 0x2f signature.
    const w = 799;
    const h = 449;
    const bits = w | (h << 14);
    const vp8l = bytes("RIFF", [0, 0, 0, 0], "WEBP", "VP8L", [0, 0, 0, 0], [0x2f], [bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >> 24) & 255], [0, 0, 0, 0, 0]);
    expect(imageSize(vp8l)).toEqual({ width: 800, height: 450 });
  });

  it("reads PNG and JPEG, and refuses anything else", () => {
    const png = bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 13], "IHDR", [0, 0, 4, 0], [0, 0, 2, 0x40]);
    expect(imageSize(png)).toEqual({ width: 1024, height: 576 });
    const jpeg = bytes([0xff, 0xd8], [0xff, 0xe0, 0x00, 0x04, 0, 0], [0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90], [0, 0, 0, 0, 0, 0]);
    expect(imageSize(jpeg)).toEqual({ width: 400, height: 300 });
    expect(imageSize(bytes("<html>not an image</html>"))).toBeNull();
    expect(imageSize(new Uint8Array())).toBeNull();
  });
});
