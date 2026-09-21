"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect } from "react";
import { AUTH_HINT_EVENT, applyAuthHint } from "@/lib/client/auth-hint";
import { THEME_STORAGE_KEY } from "@/lib/prepaint";

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
 * pre-paint script sets — so the correct glyph shows before hydration.
 */
export function ThemeToggle() {
  // React's dev Strict Mode remount clears attributes it does not manage on
  // <html>; re-apply before paint. A no-op in production.
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!root.getAttribute("data-theme")) root.setAttribute("data-theme", resolveTheme());
  }, []);

  function toggle() {
    const root = document.documentElement;
    const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // storage blocked: the choice lasts for this page view only
    }
  }

  return (
    <button type="button" className="btn btn-ghost btn-icon theme-toggle" onClick={toggle}>
      <span className="to-dark" aria-hidden="true">
        ☾
      </span>
      <span className="to-light" aria-hidden="true">
        ☀
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

export function NavLinks({ links, className, label }: { links: ReadonlyArray<{ href: string; label: string }>; className: string; label: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className={className}>
      {links.map((link) => (
        <Link key={link.href} href={link.href} aria-current={pathname === link.href ? "page" : undefined}>
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
