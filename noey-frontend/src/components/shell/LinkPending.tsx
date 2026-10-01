"use client";

import { useLinkStatus } from "next/link";
import { useEffect, useRef } from "react";

/** How many links are waiting on a navigation right now (the last click wins, but be safe). */
let waiting = 0;

/**
 * Put inside a <Link>: while that link's navigation is in flight
 * (useLinkStatus — before the address changes), its pending mark runs along
 * the link (`.pend`, loading.css: after 150 ms, so a quick navigation shows
 * nothing), the link says aria-busy, and <html data-nav-pending> turns the
 * header ruler into its scrubbing playhead. A fixed-size, always-rendered,
 * absolutely placed element: it never moves the link's layout.
 */
export function LinkPending() {
  const { pending } = useLinkStatus();
  const mark = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!pending) return;
    const root = document.documentElement;
    const link = mark.current?.closest("a");
    link?.setAttribute("aria-busy", "true");
    waiting += 1;
    root.setAttribute("data-nav-pending", "");
    return () => {
      link?.removeAttribute("aria-busy");
      waiting = Math.max(0, waiting - 1);
      if (!waiting) root.removeAttribute("data-nav-pending");
    };
  }, [pending]);

  return (
    <span ref={mark} className="pend" data-on={pending ? "" : undefined} aria-hidden="true">
      <i />
    </span>
  );
}
