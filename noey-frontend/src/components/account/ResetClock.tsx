"use client";

import { useEffect, useState } from "react";

/**
 * The absolute reset time in the VIEWER's own timezone (owner rule: someone
 * abroad must see their local clock). The server cannot know that timezone, so
 * this renders nothing on the server pass and fills in after hydration.
 */
export function ResetClock({ at }: { at: string | null }) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (!at) return;
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) return;
    const sameDay = date.toDateString() === new Date().toDateString();
    const formatted = date.toLocaleString("th-TH", {
      ...(sameDay ? {} : { weekday: "short", day: "numeric", month: "short" }),
      hour: "2-digit",
      minute: "2-digit",
    });
    // Deferred so the first client render matches the server's empty output.
    const id = window.setTimeout(() => setText(formatted), 0);
    return () => window.clearTimeout(id);
  }, [at]);

  if (!at || !text) return null;
  return (
    <>
      {" · "}
      <time dateTime={at}>{text}</time>
    </>
  );
}
