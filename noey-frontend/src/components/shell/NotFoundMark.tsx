"use client";

import { useLayoutEffect } from "react";
import { markNotFound } from "@/lib/client/not-found-mark";

/** Rendered by the 404 page: tells the header, while it is on screen, that this is a 404 (lib/client/not-found-mark.ts). */
export function NotFoundMark() {
  useLayoutEffect(() => markNotFound(), []);
  return null;
}
