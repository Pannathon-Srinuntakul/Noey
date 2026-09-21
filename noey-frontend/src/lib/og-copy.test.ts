import { describe, expect, it } from "vitest";
import { OG_COPY } from "./og-copy";
import { hasStackedThaiMarks } from "./thai-text";

describe("hasStackedThaiMarks", () => {
  it("detects a tone mark on an upper vowel", () => {
    expect(hasStackedThaiMarks("ที่นี่")).toBe(true);
    expect(hasStackedThaiMarks("เปลี่ยน")).toBe(true);
    expect(hasStackedThaiMarks("สั้น")).toBe(true);
  });

  it("allows tone marks on plain consonants and lower vowels", () => {
    expect(hasStackedThaiMarks("ถ่ายเสร็จ ให้ ปู่ย่า กุ้ง น้ำ เบราว์เซอร์")).toBe(false);
  });
});

describe("OG image copy", () => {
  it("contains nothing the image renderer would draw incorrectly", () => {
    for (const [route, copy] of Object.entries(OG_COPY)) {
      for (const field of ["eyebrow", "title", "subtitle"] as const) {
        expect(hasStackedThaiMarks(copy[field]), `${route}.${field}: "${copy[field]}"`).toBe(false);
      }
    }
  });
});
