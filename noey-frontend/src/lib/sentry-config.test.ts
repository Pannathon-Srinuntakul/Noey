import { describe, expect, it } from "vitest";
import { PRIVATE_DATA_COLLECTION, baseSentryOptions, scrubSentryEvent, scrubText, sentryDsn, sentryIngestOrigin, tracesSampleRate } from "./sentry-config";

describe("Sentry is off unless configured", () => {
  it("has no DSN when the variable is empty or blank", () => {
    expect(sentryDsn({})).toBeNull();
    expect(sentryDsn({ NEXT_PUBLIC_SENTRY_DSN: "   " })).toBeNull();
    expect(sentryIngestOrigin(null)).toBeNull();
  });

  it("allows exactly the DSN's ingest origin in the CSP", () => {
    expect(sentryIngestOrigin("https://abc123@o4501.ingest.us.sentry.io/4502")).toBe("https://o4501.ingest.us.sentry.io");
    expect(sentryIngestOrigin("http://key@evil.example/1")).toBeNull();
    expect(sentryIngestOrigin("http://key@localhost:8000/1")).toBe("http://localhost:8000");
    expect(sentryIngestOrigin("not a url")).toBeNull();
  });

  it("samples no traces by default and clamps the opt-in", () => {
    expect(tracesSampleRate(undefined)).toBe(0);
    expect(tracesSampleRate("0.2")).toBe(0.2);
    expect(tracesSampleRate("5")).toBe(1);
    expect(tracesSampleRate("-1")).toBe(0);
    expect(tracesSampleRate("abc")).toBe(0);
  });

  it("turns every automatic data category off (PII off)", () => {
    const options = baseSentryOptions({ NEXT_PUBLIC_SENTRY_DSN: "https://k@o1.ingest.sentry.io/2", NODE_ENV: "production" });
    expect(options.dsn).toBe("https://k@o1.ingest.sentry.io/2");
    expect(options.environment).toBe("production");
    expect(options.tracesSampleRate).toBe(0);
    expect(options.dataCollection).toBe(PRIVATE_DATA_COLLECTION);
    expect(PRIVATE_DATA_COLLECTION).toMatchObject({ userInfo: false, cookies: false, httpHeaders: false, urlQueryParams: false, stackFrameVariables: false });
    expect(PRIVATE_DATA_COLLECTION.httpBodies).toEqual([]);
  });
});

describe("event scrubbing", () => {
  it("drops request cookies, headers, body and query; strips URLs; drops the user", () => {
    const event = scrubSentryEvent({
      request: {
        url: "https://noeystudio.com/auth/google/callback?code=4/abc&state=xyz",
        query_string: "code=4/abc",
        cookies: { noey_at: "t" },
        headers: { cookie: "noey_rt=r", authorization: "Bearer x" },
        data: { password: "hunter2" },
      },
      user: { email: "someone@example.com", ip_address: "1.2.3.4" },
      breadcrumbs: [{ data: { url: "/reset-password?token=SECRET", from: "/verify-email?token=T" }, message: "went to /x?token=abc" }],
      exception: { values: [{ value: "failed for someone@example.com with Bearer abc.def" }] },
      message: "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl leaked",
    });
    expect(event.request).toEqual({ url: "https://noeystudio.com/auth/google/callback" });
    expect(event.user).toBeUndefined();
    expect(event.breadcrumbs?.[0].data).toEqual({ url: "/reset-password", from: "/verify-email" });
    expect(event.breadcrumbs?.[0].message).toBe("went to /x?token=[Filtered]");
    expect(event.exception?.values?.[0].value).toBe("failed for [email] with Bearer [Filtered]");
    expect(event.message).toBe("jwt [Filtered] leaked");
  });

  it("masks one-time URL parameters inside free text", () => {
    expect(scrubText("GET /verify-email?token=abc&x=1")).toBe("GET /verify-email?token=[Filtered]&x=1");
    expect(scrubText("cb ?code=4/0Ab&state=eyJ")).toBe("cb ?code=[Filtered]&state=[Filtered]");
  });
});
