import { describe, expect, it } from "vitest";
import { MODES } from "./modes";
import {
  APPROX_CUTS_PER_MONTH,
  APPROX_HIGH_CUTS_PER_MONTH,
  CLIPS_BASIS_SHORT,
  CLIPS_FOOTNOTE,
  CLIP_MINUTES,
  CUT_MODES,
  CUT_MODE_WORDS,
  DEFAULT_CLIP_MINUTES,
  DEFAULT_CUT_MODE,
  FOOTAGE_MINUTES,
  FOOTAGE_PER_PROJECT,
  SPEECH_FOOTAGE,
  SPEECH_FOOTAGE_MINUTES,
  SPEECH_FOOTAGE_NOTE,
  TIERS,
  clampClipMinutes,
  clipsBasis,
  clipsCaveats,
  clipsFootnote,
  cutCost,
  cutsAt,
  fitTier,
  footageFeature,
  formatCount,
  hasHighPrecision,
  maxClipMinutes,
  modeHasPrecision,
  type CutMode,
  type Precision,
  type Tier,
} from "./plans";

/**
 * The /pricing calculator against the backend. Every expected cost below was
 * printed by the backend itself (2026-10-01):
 *   packages.billing.limits.cut_tokens(s, precision)        — ตัดฉากเด่น
 *   packages.billing.estimate.estimate_run(mode=..., clip_secs=[s]).tokens
 *                                                           — the speech modes
 * A change on either side that moves one of them fails here.
 */
const BACKEND_COST: Record<string, Record<number, number>> = {
  "dub_first/standard": { 60: 169_326, 61: 169_392, 90: 171_294, 300: 185_070, 600: 204_750, 1200: 244_110, 1800: 283_470 },
  "dub_first/high": { 60: 185_796, 61: 186_137, 90: 195_999, 300: 267_420, 600: 369_450, 1200: 573_510, 1800: 777_570 },
  "talking_head/standard": {
    60: 3_105, 61: 3_157, 90: 4_658, 300: 15_525, 600: 31_050, 1200: 62_100, 1800: 93_150,
    2400: 124_200, 3600: 186_300, 4800: 248_400, 7200: 372_600,
  },
  "speech_highlights/standard": {
    60: 88_286, 61: 88_372, 90: 90_773, 300: 140_243, 600: 245_295, 1200: 455_400, 1800: 569_253,
    2400: 618_930, 3600: 718_308, 4800: 817_662, 7200: 1_016_370,
  },
};

/** limits.py PLAN_LIMITS[...].monthly (Free: the lifetime credit). */
const BACKEND_BUDGET: Record<Tier, number> = {
  free: 450_000,
  lite: 800_000,
  starter: 2_000_000,
  pro: 5_600_000,
  studio: 12_000_000,
  agency: 26_000_000,
  max: 48_000_000,
};

describe("cutCost", () => {
  for (const [key, costs] of Object.entries(BACKEND_COST)) {
    const [mode, precision] = key.split("/") as [CutMode, Precision];
    it(`matches the backend for ${key}`, () => {
      for (const [seconds, tokens] of Object.entries(costs)) {
        expect(cutCost(mode, Number(seconds), precision)).toBe(tokens);
      }
    });
  }
});

describe("cutsAt", () => {
  it("gives the published counts at the default (ตัดฉากเด่น, 5 minutes)", () => {
    for (const tier of TIERS) {
      expect(cutsAt(tier, CLIP_MINUTES.basis)).toBe(APPROX_CUTS_PER_MONTH[tier]);
      expect(cutsAt(tier, CLIP_MINUTES.basis, "high")).toBe(APPROX_HIGH_CUTS_PER_MONTH[tier] ?? null);
    }
  });

  it("is the backend budget over the backend cost, rounded down, at every length the page offers", () => {
    for (const tier of TIERS) {
      for (const mode of CUT_MODES) {
        for (let minutes = CLIP_MINUTES.min; minutes <= maxClipMinutes(mode); minutes++) {
          const over = mode === "dub_first" && minutes > FOOTAGE_MINUTES[tier];
          const standard = Math.floor(BACKEND_BUDGET[tier] / cutCost(mode, minutes * 60));
          expect(cutsAt(tier, minutes, "standard", mode)).toBe(over ? null : standard);
        }
      }
    }
  });

  it("has no ตัดฉากเด่น count past the plan's footage ceiling", () => {
    expect(cutsAt("lite", 10)).not.toBeNull();
    expect(cutsAt("lite", 11)).toBeNull();
    expect(cutsAt("starter", 21)).toBeNull();
    expect(cutsAt("max", maxClipMinutes("dub_first"))).not.toBeNull();
  });

  it("lets the speech modes run to two hours on every plan, limited only by the budget", () => {
    expect(maxClipMinutes("dub_first")).toBe(30);
    expect(maxClipMinutes("talking_head")).toBe(SPEECH_FOOTAGE_MINUTES);
    expect(maxClipMinutes("speech_highlights")).toBe(SPEECH_FOOTAGE_MINUTES);
    expect(SPEECH_FOOTAGE).toBe(`${SPEECH_FOOTAGE_MINUTES / 60} ชั่วโมง`);
    expect(cutsAt("free", 11, "standard", "talking_head")).toBe(13);
    expect(cutsAt("lite", 120, "standard", "talking_head")).toBe(2);
    // One long clip that costs more than the whole budget: a count of 0.
    expect(cutsAt("lite", 60, "standard", "speech_highlights")).toBe(1);
    expect(cutsAt("lite", 80, "standard", "speech_highlights")).toBe(0);
    expect(cutsAt("free", 30, "standard", "speech_highlights")).toBe(0);
    expect(cutsAt("starter", 120, "standard", "speech_highlights")).toBe(1);
  });

  it("has a ระดับละเอียด count only in ตัดฉากเด่น, and only from Pro up", () => {
    expect(modeHasPrecision("dub_first")).toBe(true);
    expect(modeHasPrecision("talking_head")).toBe(false);
    expect(modeHasPrecision("speech_highlights")).toBe(false);
    for (const tier of TIERS) {
      expect(cutsAt(tier, 5, "high") !== null).toBe(hasHighPrecision(tier));
      expect(cutsAt(tier, 5, "high", "talking_head")).toBeNull();
      expect(cutsAt(tier, 5, "high", "speech_highlights")).toBeNull();
    }
  });

  it("states the per-mode counts the owner was told (5 minutes)", () => {
    const at5 = (mode: CutMode) => TIERS.map((tier) => cutsAt(tier, 5, "standard", mode));
    expect(at5("talking_head")).toEqual([28, 51, 128, 360, 772, 1674, 3091]);
    expect(at5("dub_first")).toEqual([2, 4, 10, 30, 64, 140, 259]);
    expect(at5("speech_highlights")).toEqual([3, 5, 14, 39, 85, 185, 342]);
  });

  it("only takes whole minutes within the range", () => {
    expect(clampClipMinutes(0)).toBe(CLIP_MINUTES.min);
    expect(clampClipMinutes(45)).toBe(30);
    expect(clampClipMinutes(45, "talking_head")).toBe(45);
    expect(clampClipMinutes(150, "speech_highlights")).toBe(SPEECH_FOOTAGE_MINUTES);
    expect(clampClipMinutes(7.4)).toBe(7);
    expect(clampClipMinutes(Number.NaN)).toBe(CLIP_MINUTES.basis);
  });
});

describe("fitTier", () => {
  it("answers with the cheapest monthly plan that covers the ask", () => {
    expect(fitTier(30, 5)).toBe("pro");
    expect(fitTier(31, 5)).toBe("studio");
    expect(fitTier(1, 5)).toBe("lite");
    expect(fitTier(30, 5, "talking_head")).toBe("lite");
    expect(fitTier(30, 5, "dub_first", "high")).toBe("studio");
  });

  it("skips plans that cannot take the clip, and says when none can cover it", () => {
    expect(fitTier(1, 25)).toBe("pro"); // ตัดฉากเด่น past Lite's and Starter's ceilings
    expect(fitTier(1, 80, "speech_highlights")).toBe("starter"); // one clip is more than Lite's month
    expect(fitTier(260, 5)).toBeNull();
    expect(fitTier(180, 5, "dub_first", "high")).toBeNull();
  });

  it("ignores ระดับละเอียด in a mode without it", () => {
    expect(fitTier(30, 5, "talking_head", "high")).toBe(fitTier(30, 5, "talking_head"));
  });
});

describe("the calculator's words", () => {
  it("lists the modes in the home page's order, with the home page's names", () => {
    expect(MODES.map((mode) => mode.id)).toEqual([...CUT_MODES]);
    for (const mode of MODES) if (mode.nameParts) expect(mode.nameParts.join("")).toBe(mode.name);
    expect(MODES.map((mode) => mode.name)).toEqual(["ตัดช่วงเงียบ", "ตัดฉากเด่น", "ตัดไฮไลต์จากคลิปยาว"]);
    expect(DEFAULT_CUT_MODE).toBe("dub_first");
  });

  it("keeps the site-wide basis equal to the calculator's default", () => {
    expect(clipsFootnote(CLIP_MINUTES.basis)).toBe(CLIPS_FOOTNOTE);
    expect(clipsBasis(CLIP_MINUTES.basis)).toBe(CLIPS_BASIS_SHORT);
    expect(clipsBasis(12, "talking_head")).toBe("คิดจากโหมดตัดช่วงเงียบ คลิปดิบ 12 นาที");
  });

  it("hedges the long-clip count like every other, in long clips — never a floor", () => {
    // A run is charged per request as it goes and can exceed the estimate,
    // so "อย่างน้อย" would read as a guarantee the product cannot keep.
    expect(CUT_MODE_WORDS.speech_highlights).toEqual({ hedge: "ราว", unit: "คลิปยาว" });
    expect(clipsFootnote(5, "speech_highlights")).toContain("หนึ่งคลิปยาวแยกได้หลายคลิปสั้น");
    expect(JSON.stringify(CUT_MODE_WORDS)).not.toContain("อย่างน้อย");
  });

  it("states the setting in the basis when the count is at ระดับละเอียด", () => {
    expect(clipsBasis(5, "dub_first", "high")).toBe("คิดจากโหมดตัดฉากเด่น ระดับละเอียด คลิปดิบ 5 นาที");
    expect(clipsBasis(5, "talking_head", "high")).toBe("คิดจากโหมดตัดช่วงเงียบ คลิปดิบ 5 นาที");
    expect(`${clipsBasis(5)} ปัดลง · ${clipsCaveats()}`).toBe(CLIPS_FOOTNOTE);
    for (const mode of CUT_MODES) expect(clipsCaveats(mode).startsWith("ปัดลง")).toBe(false);
  });

  it("opens each mode on its own length", () => {
    expect(DEFAULT_CLIP_MINUTES).toEqual({ talking_head: 5, dub_first: 5, speech_highlights: 30 });
    for (const mode of CUT_MODES) expect(DEFAULT_CLIP_MINUTES[mode]).toBeLessThanOrEqual(maxClipMinutes(mode));
  });

  it("agrees with the footage ceilings the site states", () => {
    for (const tier of TIERS) {
      expect(FOOTAGE_PER_PROJECT[tier]).toBe(`${FOOTAGE_MINUTES[tier]} นาที`);
      expect(footageFeature(tier)).toBe(`ฟุตเทจรวมโหมดตัดฉากเด่น ${FOOTAGE_MINUTES[tier]} นาทีต่อโปรเจกต์`);
    }
    expect(SPEECH_FOOTAGE_NOTE).toContain("ตัดช่วงเงียบ");
    expect(SPEECH_FOOTAGE_NOTE).toContain("ตัดไฮไลต์จากคลิปยาว");
    expect(SPEECH_FOOTAGE_NOTE).toContain("2 ชั่วโมง");
  });

  it("prints thousands with a separator", () => {
    expect(formatCount(3091)).toBe("3,091");
    expect(formatCount(30)).toBe("30");
  });
});
