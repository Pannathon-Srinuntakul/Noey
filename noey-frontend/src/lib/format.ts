/**
 * Thai date formatting. Always pinned to Asia/Bangkok so server and client,
 * build machine and visitor, print the same day (no hydration mismatch).
 * `th-TH` uses the Buddhist calendar: 2026-09-21 -> "21 กันยายน 2569".
 */

const TIME_ZONE = "Asia/Bangkok";

/**
 * Accepts an ISO date/datetime string or a Unix timestamp (seconds or ms) —
 * the backend's billing fields come from Stripe, which counts in seconds.
 */
export function toDate(value: string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  let date: Date;
  if (typeof value === "number") {
    date = new Date(value < 1e12 ? value * 1000 : value);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    // A bare calendar date means that day in Thailand, not UTC midnight.
    date = new Date(`${value}T00:00:00+07:00`);
  } else if (/^\d+$/.test(value)) {
    const n = Number(value);
    date = new Date(n < 1e12 ? n * 1000 : n);
  } else {
    date = new Date(value);
  }
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatThaiDate(value: string | number | null | undefined): string | null {
  const date = toDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat("th-TH", { dateStyle: "long", timeZone: TIME_ZONE }).format(date);
}

export function formatThaiDateTime(value: string | number | null | undefined): string | null {
  const date = toDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat("th-TH", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: TIME_ZONE,
  }).format(date);
}

/**
 * Bytes for people. Picks the unit rather than assuming GB — the same rule as
 * the backend's `_human_bytes` — so 614 MB reads "614.4 MB", not "0.6 GB".
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  for (const [unit, step] of [
    ["GB", 1024 ** 3],
    ["MB", 1024 ** 2],
    ["KB", 1024],
  ] as const) {
    if (bytes >= step) return `${(bytes / step).toFixed(1)} ${unit}`;
  }
  return `${bytes} B`;
}

/** ISO string for a <time dateTime> attribute. */
export function isoDate(value: string | number | null | undefined): string | undefined {
  return toDate(value)?.toISOString();
}
