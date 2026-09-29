import { describe, expect, it } from "vitest";
import {
  PRIVATE_DATA_COLLECTION,
  monitoringConfig,
  scrubSentryEvent,
  scrubText,
  sentryDsn,
  sentryIngestOrigin,
  sentryOptions,
  tracesSampleRate,
} from "./sentry-config";

describe("Sentry is off unless configured", () => {
  it("has no DSN when the variable is empty or blank", () => {
    expect(sentryDsn({})).toBeNull();
    expect(sentryDsn({ SENTRY_DSN: "   " })).toBeNull();
    expect(monitoringConfig({})).toBeNull();
    expect(sentryIngestOrigin(null)).toBeNull();
  });

  it("this test process has no DSN, so nothing starts", () => {
    expect(monitoringConfig()).toBeNull();
  });

  it("refuses a DSN the CSP could not allow", () => {
    expect(monitoringConfig({ SENTRY_DSN: "not a url" })).toBeNull();
    expect(monitoringConfig({ SENTRY_DSN: "http://key@evil.example/1" })).toBeNull();
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

  it("reads environment and release at run time, with Railway's values as defaults", () => {
    const dsn = "https://k@o1.ingest.sentry.io/2";
    expect(monitoringConfig({ SENTRY_DSN: dsn, NODE_ENV: "production" })).toEqual({
      dsn,
      environment: "production",
      release: undefined,
      tracesSampleRate: 0,
    });
    expect(
      monitoringConfig({ SENTRY_DSN: dsn, RAILWAY_ENVIRONMENT_NAME: "staging", RAILWAY_GIT_COMMIT_SHA: "abc123", NODE_ENV: "production" }),
    ).toMatchObject({ environment: "staging", release: "abc123" });
    expect(
      monitoringConfig({ SENTRY_DSN: dsn, SENTRY_ENVIRONMENT: "prod-admin", SENTRY_RELEASE: "v1", RAILWAY_ENVIRONMENT_NAME: "staging" }),
    ).toMatchObject({ environment: "prod-admin", release: "v1" });
  });

  it("turns every automatic data category off (PII off)", () => {
    const config = monitoringConfig({ SENTRY_DSN: "https://k@o1.ingest.sentry.io/2", NODE_ENV: "production" });
    const options = sentryOptions(config!);
    expect(options.dsn).toBe("https://k@o1.ingest.sentry.io/2");
    expect(options.tracesSampleRate).toBe(0);
    expect(options.dataCollection).toBe(PRIVATE_DATA_COLLECTION);
    expect(options.beforeSend).toBe(scrubSentryEvent);
    expect(PRIVATE_DATA_COLLECTION).toMatchObject({ userInfo: false, cookies: false, httpHeaders: false, urlQueryParams: false, stackFrameVariables: false });
    expect(PRIVATE_DATA_COLLECTION.httpBodies).toEqual([]);
  });
});

describe("event scrubbing", () => {
  it("drops request cookies, headers, body and query; strips URLs; drops the user", () => {
    const event = scrubSentryEvent({
      request: {
        url: "https://admin.noeystudio.com/?next=/users",
        query_string: "next=/users",
        cookies: { noey_admin_at: "t" },
        headers: { cookie: "noey_admin_rt=r", authorization: "Bearer x" },
        data: { code: "123456" },
      },
      user: { email: "owner@example.com", ip_address: "1.2.3.4" },
      breadcrumbs: [{ data: { url: "/login?next=/x", from: "/users?q=someone@example.com" }, message: "went to /x?token=abc" }],
      exception: { values: [{ value: "refund failed for someone@example.com with Bearer abc.def" }] },
      message: "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl leaked",
    });
    expect(event.request).toEqual({ url: "https://admin.noeystudio.com/" });
    expect(event.user).toBeUndefined();
    expect(event.breadcrumbs?.[0].data).toEqual({ url: "/login", from: "/users" });
    expect(event.breadcrumbs?.[0].message).toBe("went to /x?token=[Filtered]");
    expect(event.exception?.values?.[0].value).toBe("refund failed for [email] with Bearer [Filtered]");
    expect(event.message).toBe("jwt [Filtered] leaked");
  });

  it("masks one-time URL parameters inside free text", () => {
    expect(scrubText("GET /verify-email?token=abc&x=1")).toBe("GET /verify-email?token=[Filtered]&x=1");
    expect(scrubText("cb ?code=4/0Ab&state=eyJ")).toBe("cb ?code=[Filtered]&state=[Filtered]");
  });
});
