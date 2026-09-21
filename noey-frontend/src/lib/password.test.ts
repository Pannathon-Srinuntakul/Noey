import { describe, expect, it } from "vitest";
import { MSG } from "./messages";
import { passwordProblem } from "./password";

describe("passwordProblem (mirrors the backend policy)", () => {
  it("needs at least 8 characters", () => {
    expect(passwordProblem("short12")).toBe(MSG.passwordRule);
    expect(passwordProblem("password")).toBeNull();
  });

  it("counts characters as code points, like Python's len()", () => {
    // 7 emoji are 14 UTF-16 units but still only 7 characters.
    expect(passwordProblem("😀".repeat(7))).toBe(MSG.passwordRule);
    expect(passwordProblem("😀".repeat(8))).toBeNull();
  });

  it("allows at most 72 UTF-8 bytes (bcrypt), which is 24 Thai letters", () => {
    expect(passwordProblem("ก".repeat(24))).toBeNull();
    expect(passwordProblem("ก".repeat(25))).toBe(MSG.passwordTooLong);
    expect(passwordProblem("a".repeat(72))).toBeNull();
    expect(passwordProblem("a".repeat(73))).toBe(MSG.passwordTooLong);
  });
});
