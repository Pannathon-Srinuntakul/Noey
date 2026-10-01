"use client";

import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef, ViewTransition, type ReactNode } from "react";

/** Account tabs are one room: switching tabs is not a cut to a new scene. */
function sceneKey(pathname: string): string {
  return pathname === "/account" || pathname.startsWith("/account/") ? "/account" : pathname;
}

/**
 * The splice transition between pages. Each route is its own "scene": when
 * the path changes, the old page leaves with the `splice-out` class and the
 * new one enters with `splice-in` (see shell.css), both under React's
 * <ViewTransition>, which drives the browser's View Transitions API during
 * the navigation. Browsers without the API get a short fade instead, and
 * reduced motion gets neither.
 *
 * Search-parameter changes and account-tab switches keep the same scene.
 */
export function RouteTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const key = sceneKey(pathname);
  const first = useRef(true);

  useLayoutEffect(() => {
    const root = document.documentElement;
    if (typeof document.startViewTransition !== "function") root.setAttribute("data-no-vt", "");
    if (first.current) {
      first.current = false;
      return;
    }
    root.setAttribute("data-splicing", "");
    const done = window.setTimeout(() => root.removeAttribute("data-splicing"), 460);
    return () => {
      window.clearTimeout(done);
      root.removeAttribute("data-splicing");
    };
  }, [key]);

  return (
    <ViewTransition key={key} enter="splice-in" exit="splice-out" default="none">
      {children}
    </ViewTransition>
  );
}
