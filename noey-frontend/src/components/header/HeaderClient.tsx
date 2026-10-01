"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, type CSSProperties, type ReactNode } from "react";
import { AUTH_HINT_EVENT, applyAuthHint } from "@/lib/client/auth-hint";
import { navPathname } from "@/lib/nav-path";
import { THEME_STORAGE_KEY } from "@/lib/prepaint";
import { IconMoon, IconSun } from "../ds/icons";

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
  return (
    <nav aria-label={label} className={className}>
      {links.map((link, index) => {
        const exact = pathname === link.href;
        const inside = !exact && link.href !== "/" && pathname.startsWith(`${link.href}/`);
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
