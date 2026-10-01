import { describe, expect, it } from "vitest";
import { HOME_FAQ } from "./faq";
import { PRIVACY, TERMS } from "./legal";
import { COMPARISON_ROWS, PLAN_COPY, TIERS, clipsHeadline, limitsShort } from "./plans";
import { HOME_FITS, HOME_MISFITS, SCOPE_FITS, SCOPE_MISFITS, SCOPE_STEPS, SCOPE_SUMMARY } from "./scope";
import { PAGES } from "./site";

const VENDORS = /gemini|google|elevenlabs|openai|claude|anthropic|twelve ?labs/i;

describe("honest-scope copy (Website v2)", () => {
  it("has the design's lists", () => {
    expect(HOME_FITS).toHaveLength(3);
    expect(HOME_MISFITS).toHaveLength(3);
    expect(SCOPE_STEPS.map((step) => step.title)).toEqual(["ถอดเสียงทุกไฟล์", "คัดช็อตและเรียงลำดับ", "ใส่ซับไทยให้"]);
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
  it("leads every plan with its clip count, the unit the product is sold in", () => {
    // Owner, 2026-09-29: clips per month replaced minutes of footage as the
    // headline. The basis of the estimate lives in CLIPS_FOOTNOTE, printed
    // under every count, so the bullet itself carries only the number.
    // The card's headline carries the count, so the bullets must not repeat
    // it; the account card, which has no headline, states it first.
    for (const tier of TIERS) {
      expect(PLAN_COPY[tier].accountFeatures[0]).toContain(clipsHeadline(tier));
      expect(PLAN_COPY[tier].features.join("\n"), `${tier} repeats its count`).not.toContain(clipsHeadline(tier));
    }
    // Free carries its own caption: the credit never comes back.
    expect(PLAN_COPY.free.accountFeatures[0]).toContain("ทดลองใช้ครั้งเดียว");
  });

  it("shortens limit windows for the table", () => {
    expect(limitsShort(["Monthly limit"])).toBe("Monthly limit");
    expect(limitsShort(["Weekly limit", "5-hour limit"])).toBe("Weekly + 5-hour");
    const row = COMPARISON_ROWS.find((r) => r.label === "ขีดจำกัดการใช้งาน");
    expect(row?.values).toEqual(["Trial credit", "Monthly limit", "Monthly limit", "Monthly limit", "Monthly limit", "Monthly limit", "Monthly limit"]);
  });
});
