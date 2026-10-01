"use client";

import { useEffect } from "react";
import { LOADED_EVENT } from "@/lib/loading";

/**
 * Sits inside every route loading state (RenderLoading's LoadingFrame) and
 * renders nothing. When the state is replaced by the page, it tells the
 * page-wide scripts — MotionRuntime (reveals, level meters) and the header
 * ruler — that new content is in, so they read the page again: they last
 * looked while the skeleton was there.
 */
export function LoadingSignal() {
  useEffect(() => () => void window.dispatchEvent(new Event(LOADED_EVENT)), []);
  return null;
}
