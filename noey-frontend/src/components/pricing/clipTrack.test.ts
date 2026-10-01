import { describe, expect, it } from "vitest";
import { LANE_END, LANE_START, isTap, laneGesture, minutesAt, minutesForKey, pageStep, rulerMarks } from "./clipTrack";

describe("minutesAt", () => {
  // A lane with 300px of scale between its insets.
  const width = 300 + LANE_START + LANE_END;

  it("maps the scale to whole minutes", () => {
    expect(minutesAt(LANE_START + 150, width, 30)).toBe(15);
    expect(minutesAt(LANE_START + 150, width, 120)).toBe(60);
    expect(minutesAt(LANE_START + 300, width, 30)).toBe(30);
    // 47px of 300 on the 30-minute scale is 4.7 minutes: rounds to 5.
    expect(minutesAt(LANE_START + 47, width, 30)).toBe(5);
  });

  it("clamps to 1 minute and to the mode's longest clip, the end inset included", () => {
    expect(minutesAt(0, width, 30)).toBe(1);
    expect(minutesAt(-80, width, 30)).toBe(1);
    expect(minutesAt(LANE_START + 1, width, 120)).toBe(1);
    expect(minutesAt(width - 2, width, 30)).toBe(30);
    expect(minutesAt(width + 200, width, 120)).toBe(120);
  });

  it("survives a lane with no width yet", () => {
    expect(minutesAt(10, 0, 30)).toBe(1);
    expect(minutesAt(10, Number.NaN, 30)).toBe(1);
  });
});

describe("laneGesture", () => {
  it("waits inside the slop", () => {
    expect(laneGesture(0, 0)).toBe("undecided");
    expect(laneGesture(5, -5)).toBe("undecided");
  });

  it("lets the page scroll when the finger moves mostly up or down", () => {
    expect(laneGesture(1, 12)).toBe("scroll");
    expect(laneGesture(-4, -9)).toBe("scroll");
    // A diagonal is not clearly horizontal: the page wins.
    expect(laneGesture(10, 10)).toBe("scroll");
  });

  it("starts a drag only once the movement is clearly horizontal", () => {
    expect(laneGesture(9, 2)).toBe("drag");
    expect(laneGesture(-12, 5)).toBe("drag");
  });
});

describe("isTap", () => {
  it("is a tap only when the press barely moved", () => {
    expect(isTap(0, 0)).toBe(true);
    expect(isTap(3, 4)).toBe(true);
    expect(isTap(4, 5)).toBe(false);
    expect(isTap(0, 20)).toBe(false);
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

describe("rulerMarks", () => {
  it("marks every five minutes on the 30-minute scale, every ten always shown", () => {
    const marks = rulerMarks(30);
    expect(marks.map((mark) => mark.minutes)).toEqual([0, 5, 10, 15, 20, 25, 30]);
    expect(marks.filter((mark) => mark.rank === 1).map((mark) => mark.minutes)).toEqual([0, 10, 20, 30]);
  });

  it("marks every quarter hour on the two-hour scale, hours always shown", () => {
    const marks = rulerMarks(120);
    expect(marks.map((mark) => mark.minutes)).toEqual([0, 15, 30, 45, 60, 75, 90, 105, 120]);
    expect(marks.filter((mark) => mark.rank === 1).map((mark) => mark.minutes)).toEqual([0, 60, 120]);
    expect(marks.filter((mark) => mark.rank === 2).map((mark) => mark.minutes)).toEqual([30, 90]);
  });
});
