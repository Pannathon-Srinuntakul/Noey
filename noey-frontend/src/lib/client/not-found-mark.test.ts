import { describe, expect, it, vi } from "vitest";
import { isNotFoundMarked, markNotFound, notFoundServerSnapshot, subscribeNotFound } from "./not-found-mark";

describe("the 404 page's mark (what the header reads)", () => {
  it("is set while a 404 page is on screen and tells the header each time it changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNotFound(listener);
    expect(isNotFoundMarked()).toBe(false);
    const unmark = markNotFound();
    expect(isNotFoundMarked()).toBe(true);
    unmark();
    expect(isNotFoundMarked()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    markNotFound()();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("is never seen by the server or a hydrating browser, so the header's HTML always matches", () => {
    const unmark = markNotFound();
    expect(notFoundServerSnapshot()).toBe(false);
    unmark();
  });
});
