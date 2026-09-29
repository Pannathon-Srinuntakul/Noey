import { describe, expect, it } from "vitest";
import {
  clampPct,
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
    expect(planLimitNote("free")).toContain("Weekly limit");
    expect(planLimitNote("starter")).toContain("5-hour limit");
    expect(planLimitNote("pro")).toBeNull();
  });
});
