import { describe, expect, it } from "vitest";
import {
  bindingKey,
  bindingNote,
  bindingTag,
  clampPct,
  overPct,
  overageText,
  pctText,
  limitLabel,
  limitTone,
  neverResets,
  planLimitNote,
  resetInText,
  sortLimits,
  spentCreditText,
} from "./usage-limits";

const NOW = Date.parse("2026-09-22T10:00:00Z");

describe("usage limits", () => {
  it("labels windows in English, matching the pricing page", () => {
    expect(limitLabel({ key: "five_hour" })).toBe("5-hour limit");
    expect(limitLabel({ key: "weekly" })).toBe("Weekly limit");
    expect(limitLabel({ key: "monthly" })).toBe("Monthly limit");
    // The backend's window for the free plan's one-off credit (limits.py).
    expect(limitLabel({ key: "lifetime" })).toBe("Trial credit");
    expect(limitLabel({ key: "odd", label: "Odd" })).toBe("Odd");
  });

  it("lists the longest window first, the one-off credit above them all", () => {
    expect(sortLimits([{ key: "five_hour" }, { key: "weekly" }]).map((l) => l.key)).toEqual(["weekly", "five_hour"]);
    expect(sortLimits([{ key: "five_hour" }, { key: "lifetime" }, { key: "weekly" }]).map((l) => l.key)).toEqual([
      "lifetime",
      "weekly",
      "five_hour",
    ]);
  });

  it("treats a window as resetting unless the backend says otherwise", () => {
    expect(neverResets({ resets: false })).toBe(true);
    expect(neverResets({ resets: true })).toBe(false);
    // An older backend sends no flag at all; that must not read as "never".
    expect(neverResets({})).toBe(false);
  });

  it("offers an upgrade instead of a countdown once a one-off credit is spent", () => {
    expect(spentCreditText(100)).toContain("ใช้เครดิตทดลองหมดแล้ว");
    expect(spentCreditText(100)).toContain("เลือกแพลนรายเดือน");
    expect(spentCreditText(40)).toContain("ไม่รีเซ็ต");
    for (const pct of [0, 40, 100, 137]) expect(spentCreditText(pct)).not.toMatch(/รีเซ็ตอีกครั้งใน|รอบใหม่/);
  });

  it("clamps percentages that include reservations past 100", () => {
    expect(clampPct(137)).toBe(100);
    expect(clampPct(-3)).toBe(0);
    expect(clampPct(null)).toBe(0);
    expect(clampPct(Number.NaN)).toBe(0);
  });

  it("uses the editor's tone thresholds", () => {
    expect(limitTone(95)).toBe("full");
    expect(limitTone(80)).toBe("near");
    expect(limitTone(79.9)).toBe("ok");
  });

  it("says when a window starts over, relative and timezone-free", () => {
    expect(resetInText("2026-10-04T10:00:00Z", NOW)).toBe("รีเซ็ตอีกครั้งใน 12 วัน");
    expect(resetInText("2026-09-22T13:20:00Z", NOW)).toBe("รีเซ็ตอีกครั้งใน 3 ชม. 20 นาที");
    expect(resetInText("2026-09-22T12:00:00Z", NOW)).toBe("รีเซ็ตอีกครั้งใน 2 ชม.");
    expect(resetInText("2026-09-22T10:45:00Z", NOW)).toBe("รีเซ็ตอีกครั้งใน 45 นาที");
    expect(resetInText("2026-09-22T09:00:00Z", NOW)).toBe("รีเซ็ตแล้ว");
    expect(resetInText(null, NOW)).toBe("รอบใหม่เริ่มนับเมื่อเริ่มงานถัดไป");
    expect(resetInText("not a date", NOW)).toBe("—");
  });

  it("explains the next tier's limits only where one exists", () => {
    expect(planLimitNote("free")).toContain("Monthly limit");
    expect(planLimitNote("starter")).toContain("ระดับละเอียด");
    // The notes stay about the next tier; the weekly window speaks for itself on the meters.
    for (const plan of ["free", "lite", "starter"]) expect(planLimitNote(plan)).not.toMatch(/5-hour/);
    expect(planLimitNote("pro")).toBeNull();
  });

  it("counts a weekly window that has not started from the next job, in the editor's words", () => {
    expect(resetInText(null, NOW, "weekly")).toBe("เริ่มนับ 7 วันเมื่อใช้งานครั้งถัดไป");
    expect(resetInText(null, NOW, "monthly")).toBe("รอบใหม่เริ่มนับเมื่อเริ่มงานถัดไป");
  });

  it("prints a window past 100% as it is, and says where the excess goes (the editor's words)", () => {
    expect(pctText(106.4)).toBe("106%");
    expect(pctText(-2)).toBe("0%");
    expect(overPct(106.4)).toBe(6);
    expect(overPct(100)).toBe(0);
    expect(overPct(100.3)).toBe(0);
    expect(overageText({ used_pct: 106 })).toBe("ใช้เกินโควตา 6% · จะนับรวมในรอบถัดไป");
    expect(overageText({ used_pct: 112, resets: false })).toBe("ใช้เกินเครดิตทดลอง 12% · จะนับรวมเมื่อสมัครแพลน");
    expect(overageText({ used_pct: 100 })).toBeNull();
    expect(overageText({ used_pct: 64 })).toBeNull();
  });

  it("marks the window with the least room, the week counted as 40% of the month", () => {
    // 22% of a week leaves 31.2% of a month; 38% of the month leaves 62%.
    expect(bindingKey([{ key: "monthly", used_pct: 38 }, { key: "weekly", used_pct: 22 }])).toBe("weekly");
    // A week not started still holds a new job to 40% of the month.
    expect(bindingKey([{ key: "monthly", used_pct: 31 }, { key: "weekly", used_pct: 0 }])).toBe("weekly");
    expect(bindingKey([{ key: "monthly", used_pct: 70 }, { key: "weekly", used_pct: 10 }])).toBe("monthly");
    expect(bindingKey([{ key: "monthly", used_pct: 58 }, { key: "weekly", used_pct: 106 }])).toBe("weekly");
    // One window: nothing to compare.
    expect(bindingKey([{ key: "monthly", used_pct: 90 }])).toBeNull();
    expect(bindingNote(null)).toBeNull();
    expect(bindingNote("weekly")).toContain("ตอนนี้ Weekly limit เหลือน้อยกว่า");
    expect(bindingNote("weekly")).toContain("40%");
    expect(bindingNote("weekly", 106)).toContain("ตอนนี้ Weekly limit เต็มแล้ว");
    expect(bindingTag(106)).toBe("เต็มแล้ว");
    expect(bindingNote("weekly", 0, true)).not.toContain("ตอนนี้");
    expect(bindingTag(22)).toBe("เหลือน้อยกว่า");
  });
});
