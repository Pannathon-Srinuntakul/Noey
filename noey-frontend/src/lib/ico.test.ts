import { describe, expect, it } from "vitest";
import { buildIco } from "./ico";

describe("buildIco", () => {
  it("writes a valid header, directory and PNG payloads", () => {
    const a = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const b = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9]);
    const ico = buildIco([
      { size: 32, png: a },
      { size: 256, png: b },
    ]);
    const view = new DataView(ico.buffer);
    expect(view.getUint16(0, true)).toBe(0);
    expect(view.getUint16(2, true)).toBe(1);
    expect(view.getUint16(4, true)).toBe(2);
    // first entry: 32x32, size and offset
    expect(view.getUint8(6)).toBe(32);
    expect(view.getUint32(6 + 8, true)).toBe(a.byteLength);
    const firstOffset = view.getUint32(6 + 12, true);
    expect(firstOffset).toBe(6 + 16 * 2);
    expect(Array.from(ico.slice(firstOffset, firstOffset + a.byteLength))).toEqual(Array.from(a));
    // second entry: 256 is stored as 0
    expect(view.getUint8(22)).toBe(0);
    expect(view.getUint32(22 + 12, true)).toBe(firstOffset + a.byteLength);
    expect(ico.byteLength).toBe(6 + 32 + a.byteLength + b.byteLength);
  });

  it("rejects sizes an ICO cannot describe", () => {
    expect(() => buildIco([{ size: 300, png: new Uint8Array(1) }])).toThrow(RangeError);
  });
});
