/** Number formatting exactly as the design prints it (Admin Dashboard.dc.html). */

export function baht(n: number, decimals = 2): string {
  const s = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return (n < -0.004 ? "−฿" : "฿") + s;
}

export function b0(n: number): string {
  return baht(n, 0);
}

export function num(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function pct(n: number): string {
  const v = Math.round(n * 10) / 10;
  return (v < 0 ? "−" : "") + Math.abs(v).toFixed(1) + "%";
}

const THAI_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

/** "2026-09-21" → "21 ก.ย." */
export function thaiDay(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${d} ${THAI_MONTHS[(m || 1) - 1]}`;
}

/** "2026-09" → "ก.ย." */
export function thaiMonth(key: string): string {
  const m = Number(key.split("-")[1]);
  return THAI_MONTHS[(m || 1) - 1];
}

export function daysAgo(days: number | null): string {
  if (days === null) return "—";
  return days <= 0 ? "วันนี้" : `${days} วัน`;
}
