import { describe, expect, it } from "vitest";
import { clampPct, limitLabel, limitTone, planLimitNote, resetInText, sortLimits } from "./usage-limits";

const NOW = Date.parse("2026-09-22T10:00:00Z");

describe("usage limits", () => {
  it("labels windows in English, matching the pricing page", () => {
    expect(limitLabel({ key: "five_hour" })).toBe("5-hour limit");
    expect(limitLabel({ key: "weekly" })).toBe("Weekly limit");
    expect(limitLabel({ key: "monthly" })).toBe("Monthly limit");
    expect(limitLabel({ key: "odd", label: "Odd" })).toBe("Odd");
  });

  it("lists the longest window first", () => {
    expect(sortLimits([{ key: "five_hour" }, { key: "weekly" }]).map((l) => l.key)).toEqual(["weekly", "five_hour"]);
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
    expect(planLimitNote("free")).toContain("Weekly limit");
    expect(planLimitNote("starter")).toContain("5-hour limit");
    expect(planLimitNote("pro")).toBeNull();
  });
});
