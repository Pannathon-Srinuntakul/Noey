"use client";

import { useLinkStatus } from "next/link";
import { useEffect, useRef } from "react";

/**
 * Put inside a <Link>: while that link's navigation is in flight
 * (useLinkStatus — before the address changes), its pending mark runs along
 * the link (`.pend`, loading.css: after 150 ms, so a quick navigation shows
 * nothing), the link says aria-busy, and <html data-nav-pending> turns the
 * header ruler into its scrubbing playhead. Absolutely placed, so it never
 * moves the link's layout; rendered only while pending, so the pages carry
 * nothing for it (its appear delay starts as it mounts).
 */
export function LinkPending() {
  const { pending } = useLinkStatus();
  const mark = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!pending) return;
    const root = document.documentElement;
    const link = mark.current?.closest("a");
    link?.setAttribute("aria-busy", "true");
    root.setAttribute("data-nav-pending", "");
    return () => {
      link?.removeAttribute("aria-busy");
      // The ruler stays pending only while some link still is (the DOM is current here).
      if (!document.querySelector(".pend[data-link][data-on]")) root.removeAttribute("data-nav-pending");
    };
  }, [pending]);

  return pending ? (
    <span ref={mark} className="pend" data-link="" data-on="" aria-hidden="true">
      <i />
    </span>
  ) : null;
}
