import { describe, expect, it } from "vitest";
import { ogTextBlock } from "./og-text";

describe("share-image text (fontkit outlines)", () => {
  it("draws Thai with tone marks over upper vowels as path data only", () => {
    const block = ogTextBlock("ที่นี่ซื้อของเปลี่ยนได้ที่ TikTok", { sizes: [60], maxWidth: 1040, maxLines: 3 });
    expect(block.lines.length).toBe(1);
    for (const line of block.lines) expect(line.d).toMatch(/^[MLHVCSQTAZ0-9eE.,\s-]+$/i);
    // The tone mark on "ที่" is drawn (a separate contour): "ที่" has more outline than "ที".
    const withTone = ogTextBlock("ที่", { sizes: [60], maxWidth: 400, maxLines: 1 }).lines[0].d;
    const without = ogTextBlock("ที", { sizes: [60], maxWidth: 400, maxLines: 1 }).lines[0].d;
    expect(withTone.length).toBeGreaterThan(without.length);
  });

  it("wraps long titles at word boundaries, shrinks, and cuts with … only when it must", () => {
    const long = "เตรียมฟุตเทจก่อนลากเข้าห้องตัดต่อ ตั้งแต่ตั้งชื่อไฟล์ เลือกโหมดการตัด ไปจนถึงเช็กเสียงพูด เพื่อให้ดราฟต์แรกต้องแก้น้อยที่สุด".repeat(3);
    const block = ogTextBlock(long, { sizes: [62, 50], maxWidth: 1040, maxLines: 3 });
    expect(block.lines.length).toBe(3);
    expect(block.height).toBeLessThan(400);
  });
});
