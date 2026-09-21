"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";

interface TurnstileApi {
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

/** Public site key; when unset no widget (and no third-party script) is rendered. */
export const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "";

function Widget({ siteKey, resetKey }: { siteKey: string; resetKey?: unknown }) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);

  const render = useCallback(() => {
    if (!container.current || !window.turnstile || widgetId.current) return;
    widgetId.current = window.turnstile.render(container.current, {
      sitekey: siteKey,
      language: "th",
      theme: "auto",
      size: "flexible",
    });
  }, [siteKey]);

  useEffect(() => {
    render();
    return () => {
      if (widgetId.current) window.turnstile?.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [render]);

  // Tokens are single-use: fetch a new one after each submit attempt.
  useEffect(() => {
    if (resetKey && widgetId.current) window.turnstile?.reset(widgetId.current);
  }, [resetKey]);

  return (
    <>
      <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" strategy="afterInteractive" onReady={render} />
      <div ref={container} className="turnstile-slot" />
    </>
  );
}

/**
 * Cloudflare Turnstile, rendered explicitly so it also appears after a
 * client-side navigation (implicit rendering only scans the page once). The
 * widget adds a hidden `cf-turnstile-response` input to the enclosing form;
 * the server forwards it to the backend as `turnstile_token`.
 *
 * `lazy`: load the script only once the visitor focuses the enclosing form,
 * so marketing pages (/about, /login) carry no third-party script on load.
 * The 65px slot then appears right after that input — a shift browsers do not
 * count toward CLS. Eager mode (sign-up) reserves the slot from the start.
 */
export function TurnstileWidget({ siteKey, resetKey, lazy = false }: { siteKey: string; resetKey?: unknown; lazy?: boolean }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [active, setActive] = useState(!lazy);

  useEffect(() => {
    if (active) return;
    const form = anchor.current?.closest("form");
    if (!form) return;
    const activate = () => setActive(true);
    form.addEventListener("focusin", activate, { once: true });
    return () => form.removeEventListener("focusin", activate);
  }, [active]);

  if (!siteKey) return null;
  return active ? <Widget siteKey={siteKey} resetKey={resetKey} /> : <span ref={anchor} hidden />;
}
