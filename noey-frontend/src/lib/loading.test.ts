import { describe, expect, it } from "vitest";
import { accountTabOf } from "@/components/account/AccountSkeleton";
import { EDITOR_CARD_HTML } from "./client/editor-card";
import { EDITOR_OPENING_TEXT, LOADING_TEXT, NOSCRIPT_STREAM_CSS } from "./loading";

describe("accountTabOf", () => {
  it("names the tab a path opens, the overview for anything else", () => {
    expect(accountTabOf("/account")).toBe("overview");
    expect(accountTabOf("/account/")).toBe("overview");
    expect(accountTabOf("/account/quota")).toBe("quota");
    expect(accountTabOf("/account/billing?plan=pro&from=signup")).toBe("billing");
    expect(accountTabOf("/account/profile")).toBe("profile");
    expect(accountTabOf("/account/somewhere-else")).toBe("overview");
  });
});

describe("loading copy", () => {
  it("says the plain words the brief allows, nothing more", () => {
    expect(LOADING_TEXT).toBe("กำลังโหลด");
    expect(EDITOR_OPENING_TEXT).toBe("กำลังเปิดห้องตัดต่อ");
  });
});

describe("NOSCRIPT_STREAM_CSS", () => {
  it("hides a loading state only once its own content has arrived", () => {
    for (let n = 0; n < 16; n += 1) expect(NOSCRIPT_STREAM_CSS).toContain(`body:has(#S\\:${n}) #B\\:${n} + *`);
  });

  it("changes the page's layout only when something was streamed", () => {
    expect(NOSCRIPT_STREAM_CSS).toContain('body:has(> div[hidden][id^="S:"]){display:flex');
    expect(NOSCRIPT_STREAM_CSS).not.toMatch(/(^|})body\{/);
  });
});

describe("the editor-opening card", () => {
  it("says กำลังเปิดห้องตัดต่อ and draws the whole mark in two halves", () => {
    expect(EDITOR_CARD_HTML).toContain(`<p class="edopen__text">${EDITOR_OPENING_TEXT}</p>`);
    for (const d of ["M22 78 V 22", "M22 22 L 44 55", "M56 45 L 78 78", "M78 78 V 22"]) expect(EDITOR_CARD_HTML).toContain(`d="${d}"`);
    expect(EDITOR_CARD_HTML).toContain("mark-half--l");
    expect(EDITOR_CARD_HTML).toContain("mark-half--r");
  });

  it("keeps the splice open: the status cards' lighter stroke, never a percentage", () => {
    expect(EDITOR_CARD_HTML).toContain('stroke-width="11"');
    expect(EDITOR_CARD_HTML).not.toMatch(/\d+\s*%/);
  });
});
