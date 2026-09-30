import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EDITOR_OPEN_PATH, editorHandoffUrl, isHandoffCode, mayMintFor, resolveEditorDestination } from "./editor-handoff";

const APP = "https://app.noeystudio.com";
const CODE = "a".repeat(20) + "B_c-" + "9".repeat(19); // 43 chars, the API's shape

describe("editorHandoffUrl", () => {
  it("puts the code in the fragment, never the query", () => {
    const url = new URL(editorHandoffUrl(APP, CODE));
    expect(url.origin).toBe(APP);
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#handoff=${CODE}`);
  });

  it("drops a query the configured URL might carry", () => {
    expect(editorHandoffUrl(`${APP}/?x=1`, CODE)).toBe(`${APP}/#handoff=${CODE}`);
  });
});

describe("isHandoffCode", () => {
  it("accepts the URL-safe shape the API mints", () => {
    expect(isHandoffCode(CODE)).toBe(true);
  });

  it.each([null, undefined, 42, "", "short", "has space in it and is long enough", "a".repeat(129), "a/b".repeat(10)])(
    "rejects %s",
    (value) => {
      expect(isHandoffCode(value)).toBe(false);
    },
  );
});

describe("mayMintFor", () => {
  it("mints for our own site, a typed URL and browsers without Fetch Metadata", () => {
    expect(mayMintFor("same-origin")).toBe(true);
    expect(mayMintFor("same-site")).toBe(true);
    expect(mayMintFor("none")).toBe(true);
    expect(mayMintFor(null)).toBe(true);
  });

  it("never mints for a navigation another site started", () => {
    expect(mayMintFor("cross-site")).toBe(false);
  });
});

describe("resolveEditorDestination", () => {
  const base = { appUrl: APP, secFetchSite: "same-origin" as string | null, hasSession: true };

  it("signed in: the editor with a fresh code", async () => {
    const mint = vi.fn(async () => ({ ok: true as const, code: CODE }));
    await expect(resolveEditorDestination({ ...base, mint })).resolves.toBe(`${APP}/#handoff=${CODE}`);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("signed out: the plain editor, and the API is never asked", async () => {
    const mint = vi.fn(async () => ({ ok: true as const, code: CODE }));
    await expect(resolveEditorDestination({ ...base, hasSession: false, mint })).resolves.toBe(APP);
    expect(mint).not.toHaveBeenCalled();
  });

  it("cross-site start: the plain editor, nothing minted", async () => {
    const mint = vi.fn(async () => ({ ok: true as const, code: CODE }));
    await expect(resolveEditorDestination({ ...base, secFetchSite: "cross-site", mint })).resolves.toBe(APP);
    expect(mint).not.toHaveBeenCalled();
  });

  it.each([
    ["the API refuses", async () => ({ ok: false as const })],
    ["the API answers garbage", async () => ({ ok: true as const, code: "<script>" })],
    ["the call throws", async () => Promise.reject(new Error("down"))],
  ])("%s: falls back to the plain editor", async (_label, mint) => {
    await expect(resolveEditorDestination({ ...base, mint })).resolves.toBe(APP);
  });
});

describe("every open-editor button goes through the handoff route", () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.tsx$/.test(name) ? [path] : [];
    });
  }

  it("no page links straight to the editor URL", () => {
    const root = join(__dirname, "..");
    const offenders = sources(root).filter((file) => /href=\{(APP_URL|appUrl)\}/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
    expect(EDITOR_OPEN_PATH.startsWith("/api/")).toBe(true);
  });
});
