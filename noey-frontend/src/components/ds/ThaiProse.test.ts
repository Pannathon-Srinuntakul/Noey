import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { keepThaiProse } from "./ThaiProse";
import { keepThai } from "./ThaiText";

/** The runs keepThaiProse / keepThai return, as [text, kept] pairs. */
function runs(node: ReactNode): Array<[string, boolean]> {
  const list = Array.isArray(node) ? node : [node];
  return list
    .filter((part) => part !== null && part !== undefined && part !== "")
    .map((part) => {
      if (typeof part === "string") return [part, false];
      if (!isValidElement<{ className?: string; children: string }>(part)) throw new Error("unexpected node");
      return [part.props.children, part.props.className === "kt"];
    });
}

const kept = (node: ReactNode) => runs(node).filter(([, keep]) => keep).map(([text]) => text);

describe("keepThaiProse", () => {
  it("keeps a word ICU cuts in the middle", () => {
    expect(kept(keepThaiProse("ดูได้ทุกช็อตในคลิป"))).toContain("ทุก");
    expect(kept(keepThaiProse("ขอความช่วยเหลือได้ตลอด")).some((run) => run.includes("ความช่วยเหลือ"))).toBe(true);
  });

  it("never matches a glossary word across two other words", () => {
    // "ด้วย|การ" holds the letters of "ยก"; it must not be kept.
    const out = keepThaiProse("บันทึกด้วยการเข้ารหัสที่เบราว์เซอร์เปิดไม่ได้");
    expect(runs(out).map(([text]) => text).join("")).toBe("บันทึกด้วยการเข้ารหัสที่เบราว์เซอร์เปิดไม่ได้");
    expect(kept(out)).not.toContain("ยก");
    expect(kept(out)).toContain("การเข้ารหัส");
  });

  it("glues a leaning word to the next one", () => {
    expect(kept(keepThaiProse("แก้ได้ไม่จำกัดครั้ง"))).toContain("ไม่จำกัด");
  });

  it("puts a no-break space before ๆ", () => {
    expect(runs(keepThaiProse("ประโยคสั้น ๆ ให้อ่าน")).map(([text]) => text).join("")).toBe("ประโยคสั้น ๆ ให้อ่าน");
    expect(runs(keepThai("สั้น ๆ")).map(([text]) => text).join("")).toBe("สั้น ๆ");
  });

  it("leaves text without Thai alone", () => {
    expect(keepThaiProse("MP4 and MOV")).toBe("MP4 and MOV");
  });
});
