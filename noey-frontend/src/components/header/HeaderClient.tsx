"use client";

import Link from "next/link";
import { usePathname, useSelectedLayoutSegments } from "next/navigation";
import { useEffect, useLayoutEffect, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { AUTH_HINT_EVENT, applyAuthHint } from "@/lib/client/auth-hint";
import { showEditorCard } from "@/lib/client/editor-card";
import { EDITOR_OPEN_PATH } from "@/lib/editor-handoff";
import { EDITOR_OPENING_TEXT } from "@/lib/loading";
import { isNotFoundMarked, notFoundServerSnapshot, subscribeNotFound } from "@/lib/client/not-found-mark";
import { NOT_FOUND_SEGMENT, navPathname } from "@/lib/nav-path";
import { THEME_STORAGE_KEY } from "@/lib/prepaint";
import { IconMoon, IconSun } from "../ds/icons";
import { LinkPending } from "../shell/LinkPending";

function resolveTheme(): "light" | "dark" {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // storage blocked
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Icon and label are switched by CSS from <html data-theme>, which the
 * pre-paint script sets — so the correct icon shows before hydration. Where
 * the browser supports view transitions (and motion is allowed) the new theme
 * is spliced in along the logo's diagonal.
 */
export function ThemeToggle({ className }: { className?: string }) {
  // React's dev Strict Mode remount clears attributes it does not manage on
  // <html>; re-apply before paint. A no-op in production.
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!root.getAttribute("data-theme")) root.setAttribute("data-theme", resolveTheme());
  }, []);

  function toggle() {
    const root = document.documentElement;
    const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    const apply = () => {
      root.setAttribute("data-theme", next);
      try {
        localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // storage blocked: the choice lasts for this page view only
      }
    };
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (still || typeof document.startViewTransition !== "function") {
      apply();
      return;
    }
    root.setAttribute("data-theme-switch", "");
    const transition = document.startViewTransition(apply);
    transition.finished.finally(() => root.removeAttribute("data-theme-switch"));
  }

  return (
    <button type="button" className={["btn btn-ghost btn-icon theme-toggle", className].filter(Boolean).join(" ")} onClick={toggle}>
      <span className="to-dark" aria-hidden="true">
        <IconMoon size={18} />
      </span>
      <span className="to-light" aria-hidden="true">
        <IconSun size={19} />
      </span>
      <span className="sr-only to-dark">สลับเป็นโหมดมืด</span>
      <span className="sr-only to-light">สลับเป็นโหมดสว่าง</span>
    </button>
  );
}

/** Keeps the signed-in header in step after client-side navigations. */
export function AuthHintSync() {
  const pathname = usePathname();

  useLayoutEffect(() => {
    applyAuthHint();
  }, [pathname]);

  useEffect(() => {
    const sync = () => applyAuthHint();
    window.addEventListener(AUTH_HINT_EVENT, sync);
    window.addEventListener("pageshow", sync);
    return () => {
      window.removeEventListener(AUTH_HINT_EVENT, sync);
      window.removeEventListener("pageshow", sync);
    };
  }, []);

  return null;
}

export function NavLinks({
  links,
  className,
  label,
  numbered = false,
}: {
  links: ReadonlyArray<{ href: string; label: string }>;
  className: string;
  label: string;
  /** The sheet's version: each link carries its reel number. */
  numbered?: boolean;
}) {
  const pathname = navPathname(usePathname());
  // A 404 is no section's page, whatever its address (/blog?page=99 is not
  // the blog): no link is marked current on it. Next's route tree says so for
  // most 404s (the same on the server and in the browser); a page's own
  // notFound() is told by the 404 page itself (NotFoundMark).
  const routeNotFound = useSelectedLayoutSegments().includes(NOT_FOUND_SEGMENT);
  const markedNotFound = useSyncExternalStore(subscribeNotFound, isNotFoundMarked, notFoundServerSnapshot);
  const notFound = routeNotFound || markedNotFound;
  return (
    <nav aria-label={label} className={className}>
      {links.map((link, index) => {
        const exact = !notFound && pathname === link.href;
        const inside = !notFound && !exact && link.href !== "/" && pathname.startsWith(`${link.href}/`);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={exact ? "page" : inside ? "true" : undefined}
            style={numbered ? ({ "--i": index } as CSSProperties) : undefined}
          >
            {numbered ? (
              <span className="tc" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
            ) : null}
            {link.label}
            <LinkPending />
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * A header action that knows when it points at the page already open: on
 * /signup the "เริ่มใช้ฟรี" button is the page itself, so it says so
 * (aria-current) and steps back visually (globals.css).
 */
export function PageLink({
  href,
  className,
  prefetch,
  magnetic = false,
  children,
}: {
  href: string;
  className: string;
  prefetch?: boolean;
  magnetic?: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  return (
    <Link
      href={href}
      className={className}
      prefetch={prefetch}
      aria-current={pathname === href ? "page" : undefined}
      data-magnetic={magnetic ? "" : undefined}
    >
      {children}
      <LinkPending />
    </Link>
  );
}

/**
 * The header's two disclosures (the phone sheet and the account menu) are
 * plain <details>, so they open without JavaScript. This closes them on
 * navigation, on Escape, and on a click outside the account menu.
 */
export function HeaderDisclosures() {
  const pathname = usePathname();
  // The editor-opening card rides on this component (no client component of
  // its own: one more would be one more reference in every page's payload).
  useEditorOpening();

  useEffect(() => {
    for (const details of document.querySelectorAll<HTMLDetailsElement>("details[data-header-disclosure][open]")) {
      details.open = false;
    }
  }, [pathname]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      for (const details of document.querySelectorAll<HTMLDetailsElement>("details[data-header-disclosure][open]")) {
        details.open = false;
        details.querySelector<HTMLElement>("summary")?.focus();
      }
    };
    const onClick = (event: MouseEvent) => {
      for (const details of document.querySelectorAll<HTMLDetailsElement>("details.acct[open]")) {
        if (!details.contains(event.target as Node)) details.open = false;
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, []);

  return null;
}

/**
 * "กำลังเปิดห้องตัดต่อ" (shell/EditorOpening.tsx; used by HeaderDisclosures,
 * below): a plain left click on any link to EDITOR_OPEN_PATH puts the render
 * card on the page (lib/client/editor-card.ts builds it, so no page's HTML
 * carries it) until the browser leaves. The link is not touched — no preventDefault, no prefetch — and a
 * click that opens a new tab or window is left alone. The card goes on
 * `pagehide` (leaving), on `pageshow` (back from the editor, restored from the
 * back-forward cache), on Escape (the visitor stopped the navigation), and
 * after 20 s if the navigation went nowhere. A polite status line, there from
 * the start and empty, says "กำลังเปิดห้องตัดต่อ" to screen readers.
 */
function useEditorOpening() {
  // The waiting styles (loading-core.css, loading-deferred.css) load once
  // the page is up — at idle, or at the first click or key press if that
  // comes sooner — so they never hold up a first paint. They are linked as
  // files (`new URL`: emitted as they are, not bundled), so loading them
  // later adds nothing to any page's HTML or first scripts.
  useEffect(() => {
    let loaded = false;
    const load = () => {
      if (loaded) return;
      loaded = true;
      for (const href of [
        new URL("../../styles/parts/loading-core.css", import.meta.url).href,
        new URL("../../styles/parts/loading-deferred.css", import.meta.url).href,
      ]) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = href;
        document.head.append(link);
      }
    };
    // Safari has no requestIdleCallback.
    const idleApi = typeof window.requestIdleCallback === "function";
    const idle = idleApi ? window.requestIdleCallback(load, { timeout: 2500 }) : window.setTimeout(load, 1200);
    document.addEventListener("pointerdown", load, { once: true, capture: true });
    document.addEventListener("keydown", load, { once: true, capture: true });
    return () => {
      if (idleApi) window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
      document.removeEventListener("pointerdown", load, { capture: true });
      document.removeEventListener("keydown", load, { capture: true });
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const status = document.createElement("span");
    status.className = "sr-only";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("data-editor-status", "");
    document.body.append(status);
    let safety = 0;
    const clear = () => {
      window.clearTimeout(safety);
      root.removeAttribute("data-editor-opening");
      document.querySelector("body > .edopen")?.remove();
      status.textContent = "";
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.getAttribute("href") !== EDITOR_OPEN_PATH || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
      root.setAttribute("data-editor-opening", "");
      status.textContent = EDITOR_OPENING_TEXT;
      showEditorCard();
      window.clearTimeout(safety);
      safety = window.setTimeout(clear, 20_000);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") clear();
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    window.addEventListener("pagehide", clear);
    window.addEventListener("pageshow", clear);
    return () => {
      clear();
      status.remove();
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("pagehide", clear);
      window.removeEventListener("pageshow", clear);
    };
  }, []);
}
