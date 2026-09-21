/**
 * Runs synchronously in <head> before first paint (see the Next.js guide
 * "Preventing flash before hydration"). It does two things for a page that is
 * otherwise fully static:
 *
 *  1. Theme — the prototype's rule: localStorage "noey-theme", else the OS
 *     preference; written to <html data-theme>.
 *  2. Signed-in header — if the JS-readable hint cookie says so, set
 *     <html data-auth="in"> and put "คุณ<name>" in a CSS variable, so the
 *     header shows the right buttons with no flash and no layout shift.
 *
 * `applyAuthHint` in lib/client/auth-hint.ts repeats (2) after client-side
 * navigations; keep the two in step.
 */
export const THEME_STORAGE_KEY = "noey-theme";

export const PREPAINT_SCRIPT = `(function(){var d=document.documentElement;try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");if(t!=="light"&&t!=="dark"){t=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}d.setAttribute("data-theme",t)}catch(e){}try{var c=document.cookie;if(/(?:^|; )noey_si=1(?:;|$)/.test(c)){d.setAttribute("data-auth","in");var m=c.match(/(?:^|; )noey_name=([^;]*)/);if(m){var n=decodeURIComponent(m[1]).replace(/[\\u0000-\\u001f\\u007f"\\\\]/g,"").slice(0,60);if(n){d.style.setProperty("--noey-greeting",'"\\u0e04\\u0e38\\u0e13'+n+'"');d.setAttribute("data-auth-name","")}}}}catch(e){}})();`;
