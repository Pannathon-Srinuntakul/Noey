import { describe, expect, it } from "vitest";
import { PREPAINT_SCRIPT } from "./prepaint";

/** Execute the inline <head> script against a minimal stub DOM. */
function run(options: { cookie?: string; saved?: string | null; prefersDark?: boolean; storageThrows?: boolean }) {
  const attrs = new Map<string, string>();
  const styles = new Map<string, string>();
  const documentElement = {
    setAttribute: (name: string, value: string) => attrs.set(name, value),
    style: { setProperty: (name: string, value: string) => styles.set(name, value) },
  };
  const document = { documentElement, cookie: options.cookie ?? "" };
  const localStorage = {
    getItem: () => {
      if (options.storageThrows) throw new Error("blocked");
      return options.saved ?? null;
    },
  };
  const window = { matchMedia: () => ({ matches: !!options.prefersDark }) };
  new Function("document", "localStorage", "window", PREPAINT_SCRIPT)(document, localStorage, window);
  return { attrs, styles };
}

describe("pre-paint script", () => {
  it("applies a saved theme", () => {
    expect(run({ saved: "dark" }).attrs.get("data-theme")).toBe("dark");
    expect(run({ saved: "light", prefersDark: true }).attrs.get("data-theme")).toBe("light");
  });

  it("falls back to the OS preference, ignoring junk values", () => {
    expect(run({ prefersDark: true }).attrs.get("data-theme")).toBe("dark");
    expect(run({ saved: "purple" }).attrs.get("data-theme")).toBe("light");
  });

  it("survives blocked storage without touching the auth part", () => {
    const { attrs } = run({ storageThrows: true, cookie: "noey_si=1" });
    expect(attrs.get("data-theme")).toBeUndefined();
    expect(attrs.get("data-auth")).toBe("in");
  });

  it("marks the header signed-in and greets by name from the hint cookies", () => {
    const { attrs, styles } = run({ cookie: `a=b; noey_si=1; noey_name=${encodeURIComponent("นอย")}` });
    expect(attrs.get("data-auth")).toBe("in");
    expect(attrs.has("data-auth-name")).toBe(true);
    expect(styles.get("--noey-greeting")).toBe('"คุณนอย"');
  });

  it("strips characters that could break out of the CSS string", () => {
    const { styles } = run({ cookie: `noey_si=1; noey_name=${encodeURIComponent('a"b\\c\n')}` });
    expect(styles.get("--noey-greeting")).toBe('"คุณabc"');
  });

  it("stays signed-out without the hint", () => {
    const { attrs } = run({ cookie: "noey_si=0; noey_name=x" });
    expect(attrs.has("data-auth")).toBe(false);
  });
});
