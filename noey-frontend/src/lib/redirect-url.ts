/**
 * Checkout, change-plan and portal URLs come from our own backend, but they
 * are still validated before we send a browser there: https only (plain http
 * only to localhost outside production, for a local mock backend).
 */
export function isSafeExternalRedirect(value: unknown, production: boolean = process.env.NODE_ENV === "production"): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return !production && url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}
