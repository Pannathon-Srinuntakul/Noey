import { describe, expect, it } from "vitest";
import { formatBytes, formatShortDate, formatThaiDate, isoDate, toDate } from "./format";

describe("formatBytes", () => {
  it("picks the unit like the backend does", () => {
    expect(formatBytes(10 * 1024 ** 3)).toBe("10.0 GB");
    expect(formatBytes(644245094)).toBe("614.4 MB");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(-1)).toBe("—");
  });
});

describe("Thai dates", () => {
  it("prints a calendar date in the Buddhist era, pinned to Bangkok", () => {
    expect(formatThaiDate("2026-09-21")).toBe("21 กันยายน 2569");
  });

  it("does not slip a day for UTC timestamps late in the Thai evening", () => {
    // 2026-09-21 18:30 UTC is already 22 Sep in Bangkok.
    expect(formatThaiDate("2026-09-21T18:30:00Z")).toBe("22 กันยายน 2569");
  });

  it("accepts Stripe-style unix seconds and millisecond timestamps", () => {
    const seconds = Math.floor(Date.UTC(2026, 9, 21, 3) / 1000);
    expect(formatThaiDate(seconds)).toBe("21 ตุลาคม 2569");
    expect(formatThaiDate(seconds * 1000)).toBe("21 ตุลาคม 2569");
    expect(formatThaiDate(String(seconds))).toBe("21 ตุลาคม 2569");
  });

  it("prints the account pages' short date in the Common Era, like the beta strip", () => {
    expect(formatShortDate("2026-10-13")).toBe("13 ต.ค. 2026");
    // 2026-12-31 17:30 UTC is already 1 Jan in Bangkok.
    expect(formatShortDate("2026-12-31T17:30:00Z")).toBe("1 ม.ค. 2027");
    expect(formatShortDate(Math.floor(Date.UTC(2026, 9, 13, 3) / 1000))).toBe("13 ต.ค. 2026");
    expect(formatShortDate(null)).toBeNull();
  });

  it("returns null for missing or invalid input", () => {
    expect(formatThaiDate(null)).toBeNull();
    expect(formatThaiDate("not a date")).toBeNull();
    expect(toDate("")).toBeNull();
    expect(isoDate(undefined)).toBeUndefined();
  });
});
