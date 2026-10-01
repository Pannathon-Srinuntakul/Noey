import { describe, expect, it } from "vitest";
import { LANE_INSET, minutesAt, minutesForKey, pageStep } from "./clipTrack";

describe("minutesAt", () => {
  // A lane 304px wide: 300px of clip room after the 2px inset each side.
  const width = 300 + LANE_INSET * 2;

  it("maps the lane to whole minutes on the mode's scale", () => {
    expect(minutesAt(LANE_INSET + 150, width, 30)).toBe(15);
    expect(minutesAt(LANE_INSET + 150, width, 120)).toBe(60);
    expect(minutesAt(LANE_INSET + 300, width, 30)).toBe(30);
    // 47px of 300 on the 30-minute scale is 4.7 minutes: rounds to 5.
    expect(minutesAt(LANE_INSET + 47, width, 30)).toBe(5);
  });

  it("clamps to 1 minute and to the mode's longest clip", () => {
    expect(minutesAt(0, width, 30)).toBe(1);
    expect(minutesAt(-80, width, 30)).toBe(1);
    expect(minutesAt(LANE_INSET + 1, width, 120)).toBe(1);
    expect(minutesAt(width + 200, width, 30)).toBe(30);
    expect(minutesAt(width + 200, width, 120)).toBe(120);
  });

  it("survives a lane with no width yet", () => {
    expect(minutesAt(10, 0, 30)).toBe(1);
    expect(minutesAt(10, Number.NaN, 30)).toBe(1);
  });
});

describe("minutesForKey", () => {
  it("moves one minute with the arrows", () => {
    expect(minutesForKey("ArrowRight", 5, 30)).toBe(6);
    expect(minutesForKey("ArrowUp", 5, 30)).toBe(6);
    expect(minutesForKey("ArrowLeft", 5, 30)).toBe(4);
    expect(minutesForKey("ArrowDown", 5, 30)).toBe(4);
  });

  it("moves a page: five minutes on the 30-minute scale, ten on the two-hour one", () => {
    expect(pageStep(30)).toBe(5);
    expect(pageStep(120)).toBe(10);
    expect(minutesForKey("PageUp", 5, 30)).toBe(10);
    expect(minutesForKey("PageDown", 30, 120)).toBe(20);
  });

  it("jumps to the ends and never leaves the range", () => {
    expect(minutesForKey("Home", 17, 30)).toBe(1);
    expect(minutesForKey("End", 17, 120)).toBe(120);
    expect(minutesForKey("ArrowLeft", 1, 30)).toBe(1);
    expect(minutesForKey("PageDown", 3, 30)).toBe(1);
    expect(minutesForKey("ArrowRight", 30, 30)).toBe(30);
    expect(minutesForKey("PageUp", 115, 120)).toBe(120);
  });

  it("ignores keys a slider does not use", () => {
    expect(minutesForKey("Enter", 5, 30)).toBeNull();
    expect(minutesForKey("a", 5, 30)).toBeNull();
  });
});
