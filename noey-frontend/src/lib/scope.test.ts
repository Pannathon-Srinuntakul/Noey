import { describe, expect, it } from "vitest";
import { HOME_FAQ } from "./faq";
import { PRIVACY, TERMS } from "./legal";
import { COMPARISON_ROWS, PLAN_COPY, TIERS, limitsShort } from "./plans";
import { HOME_FITS, HOME_MISFITS, SCOPE_FITS, SCOPE_MISFITS, SCOPE_STEPS, SCOPE_SUMMARY } from "./scope";
import { PAGES } from "./site";

const VENDORS = /gemini|google|elevenlabs|openai|claude|anthropic|twelve ?labs/i;

describe("honest-scope copy (Website v2)", () => {
  it("has the design's lists", () => {
    expect(HOME_FITS).toHaveLength(3);
    expect(HOME_MISFITS).toHaveLength(3);
    expect(SCOPE_STEPS.map((step) => step.title)).toEqual(["ถอดเสียงทั้งกอง", "คัดช็อตและเรียงลำดับ", "ใส่ซับไทยให้"]);
    expect(SCOPE_FITS).toHaveLength(5);
    expect(SCOPE_MISFITS).toHaveLength(5);
    expect(SCOPE_SUMMARY.map((row) => row.label)).toEqual(["ระบบทำ", "คุณทำ", "ยังไม่มี"]);
  });

  it("replaces /examples with /scope in the page registry", () => {
    expect(PAGES.scope.path).toBe("/scope");
    expect("examples" in PAGES).toBe(false);
  });

  it("home FAQ says the draft still needs editing", () => {
    expect(HOME_FAQ.map((item) => item.question)).toContain("ตัดเสร็จแล้วเอาไปลงได้เลยไหม");
    expect(HOME_FAQ.map((item) => item.question)).toContain("งานแบบไหนที่ยังไม่เหมาะ");
  });

  it("never names an AI vendor", () => {
    const text = [
      ...HOME_FITS,
      ...HOME_MISFITS,
      ...SCOPE_FITS,
      ...SCOPE_MISFITS,
      ...SCOPE_STEPS.flatMap((step) => [step.title, step.body]),
      ...TERMS.sections.flatMap((section) => [section.title, ...section.paragraphs]),
      ...PRIVACY.sections.flatMap((section) => [section.title, ...section.paragraphs]),
    ].join("\n");
    expect(text).not.toMatch(VENDORS);
  });
});

describe("legal documents", () => {
  it("are numbered sections from the design", () => {
    expect(TERMS.sections).toHaveLength(17);
    expect(PRIVACY.sections).toHaveLength(11);
    expect(TERMS.sections[0].title).toBe("การยอมรับเงื่อนไข");
  });

  it("do not claim VAT is included (the owner is not VAT-registered)", () => {
    const all = TERMS.sections.flatMap((section) => section.paragraphs).join("\n");
    expect(all).not.toContain("ภาษีมูลค่าเพิ่ม");
  });

  it("link to the contact form through the {about} token only", () => {
    const all = [...TERMS.sections, ...PRIVACY.sections].flatMap((section) => section.paragraphs).join("\n");
    expect(all).not.toMatch(/<a\b|onClick/);
    expect(all).toContain("{about}");
  });
});

describe("plan wording (Website v2)", () => {
  it("counts jobs from 5 minutes of raw footage, not clips", () => {
    for (const tier of TIERS) {
      for (const feature of PLAN_COPY[tier].features) expect(feature).not.toMatch(/คลิป 5 นาที|คลิปต่อรอบ/);
    }
    expect(PLAN_COPY.pro.features[0]).toBe("Weekly limit · ประมาณ 15 งานต่อสัปดาห์ จากฟุตเทจดิบ 5 นาที");
  });

  it("shortens limit windows for the table", () => {
    expect(limitsShort(["Monthly limit"])).toBe("Monthly limit");
    expect(limitsShort(["Weekly limit", "5-hour limit"])).toBe("Weekly + 5-hour");
    const row = COMPARISON_ROWS.find((r) => r.label === "ขีดจำกัดการใช้งาน");
    expect(row?.values).toEqual(["Monthly limit", "Weekly limit", "Weekly limit", "Weekly + 5-hour", "Weekly + 5-hour", "Weekly + 5-hour", "Weekly + 5-hour"]);
  });
});
