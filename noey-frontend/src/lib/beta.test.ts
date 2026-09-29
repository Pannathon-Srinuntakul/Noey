import { describe, expect, it } from "vitest";
import {
  BETA_END_DATE_ISO,
  BETA_END_INSTANT_MS,
  BETA_END_LABEL,
  BETA_NOTICE_DISCLAIMER,
  BETA_NOTICE_POINTS,
  BETA_NOTICE_SNOOZE_MS,
  isBetaActive,
  isPaymentPath,
  parseBetaNoticeState,
  shouldShowBetaBanner,
  shouldShowBetaNotice,
} from "./beta";

/** The last millisecond of the beta, and the first one after it. */
const DURING = BETA_END_INSTANT_MS - 1;
const AFTER = BETA_END_INSTANT_MS;

const DAY = 24 * 60 * 60 * 1000;

describe("the expiry constant", () => {
  it("is the end of 31 Dec 2026 in Bangkok, written the same way in the copy", () => {
    expect(BETA_END_DATE_ISO).toBe("2026-12-31");
    expect(BETA_END_LABEL).toBe("31 ธ.ค. 2026");
    // 2027-01-01T00:00:00+07:00
    expect(new Date(BETA_END_INSTANT_MS).toISOString()).toBe("2026-12-31T17:00:00.000Z");
  });

  it("is what every beta behaviour asks, so the site reverts with no deploy", () => {
    expect(isBetaActive(DURING)).toBe(true);
    expect(isBetaActive(AFTER)).toBe(false);
    expect(shouldShowBetaBanner(DURING)).toBe(true);
    expect(shouldShowBetaBanner(AFTER)).toBe(false);
  });
});

describe("the modal's three points", () => {
  it("are exactly three — a fourth makes people read none of them", () => {
    expect(BETA_NOTICE_POINTS).toHaveLength(3);
  });

  it("say the beta price ends and that nobody is grandfathered", () => {
    const text = BETA_NOTICE_POINTS.map((point) => `${point.title} ${point.body}`).join("\n");
    expect(text).toContain("ลด 50%");
    expect(text).toContain(BETA_END_LABEL);
    expect(text).toContain("รวมคนที่สมัครไว้แล้ว");
    expect(BETA_NOTICE_DISCLAIMER).toContain(BETA_END_LABEL);
  });

  it("name no AI vendor anywhere a user can read", () => {
    const text = [...BETA_NOTICE_POINTS.map((p) => `${p.title} ${p.body}`), BETA_NOTICE_DISCLAIMER].join("\n");
    expect(text).not.toMatch(/gemini|claude|anthropic|elevenlabs|twelve\s?labs|openai|gpt/i);
  });
});

describe("shouldShowBetaNotice", () => {
  const base = { now: DURING, stored: null, pathname: "/", busy: false };

  it("shows once on a first visit", () => {
    expect(shouldShowBetaNotice(base)).toBe(true);
  });

  it("never shows after the beta ends, even to someone who never saw it", () => {
    expect(shouldShowBetaNotice({ ...base, now: AFTER })).toBe(false);
  });

  it("never covers a payment page or a page that is busy", () => {
    expect(isPaymentPath("/checkout/success")).toBe(true);
    expect(isPaymentPath("/account/billing")).toBe(true);
    expect(isPaymentPath("/account/quota")).toBe(false);
    expect(shouldShowBetaNotice({ ...base, pathname: "/checkout/success" })).toBe(false);
    expect(shouldShowBetaNotice({ ...base, pathname: "/account/billing" })).toBe(false);
    expect(shouldShowBetaNotice({ ...base, busy: true })).toBe(false);
  });

  it("stays away for a week after a plain dismissal, then returns", () => {
    const stored = { dismissedAt: DURING - 6 * DAY, forever: false };
    expect(shouldShowBetaNotice({ ...base, stored })).toBe(false);
    expect(shouldShowBetaNotice({ ...base, stored: { ...stored, dismissedAt: DURING - BETA_NOTICE_SNOOZE_MS } })).toBe(true);
  });

  it("never returns once ไม่ต้องแสดงอีก was ticked", () => {
    expect(shouldShowBetaNotice({ ...base, stored: { dismissedAt: 0, forever: true } })).toBe(false);
  });
});

describe("parseBetaNoticeState", () => {
  it("reads back what the component wrote", () => {
    expect(parseBetaNoticeState(JSON.stringify({ dismissedAt: 1234, forever: true }))).toEqual({
      dismissedAt: 1234,
      forever: true,
    });
  });

  it("treats anything else as never seen rather than trusting it", () => {
    expect(parseBetaNoticeState(null)).toBeNull();
    expect(parseBetaNoticeState("not json")).toBeNull();
    expect(parseBetaNoticeState(JSON.stringify({ forever: true }))).toBeNull();
    expect(parseBetaNoticeState(JSON.stringify("yes"))).toBeNull();
  });
});
