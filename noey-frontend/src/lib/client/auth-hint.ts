/**
 * Client-side twin of the pre-paint script's signed-in part (lib/prepaint.ts):
 * after a Server Action logs in/out and the router navigates client-side, the
 * <head> script does not run again, so the header re-reads the hint cookies.
 */
import { decodeDisplayNameCookie } from "../session";

export const AUTH_HINT_EVENT = "noey:auth-changed";

function cookieValue(name: string): string | undefined {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? match[1] : undefined;
}

export function applyAuthHint(): void {
  const root = document.documentElement;
  const signedIn = cookieValue("noey_si") === "1";
  if (signedIn) root.setAttribute("data-auth", "in");
  else root.removeAttribute("data-auth");

  const name = signedIn ? decodeDisplayNameCookie(cookieValue("noey_name")).replace(/["\\]/g, "") : "";
  if (name) {
    root.style.setProperty("--noey-greeting", JSON.stringify(`คุณ${name}`));
    root.setAttribute("data-auth-name", "");
  } else {
    root.style.removeProperty("--noey-greeting");
    root.removeAttribute("data-auth-name");
  }
}

/** Call after something changed the hint cookies without a navigation (e.g. a new display name). */
export function notifyAuthChanged(): void {
  window.dispatchEvent(new Event(AUTH_HINT_EVENT));
}
