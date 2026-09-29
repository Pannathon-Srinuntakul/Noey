"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import {
  BETA_BADGE,
  BETA_BANNER_LINK,
  BETA_BANNER_TEXT,
  BETA_NOTICE_DISCLAIMER,
  BETA_NOTICE_DISMISS,
  BETA_NOTICE_NEVER,
  BETA_NOTICE_POINTS,
  BETA_NOTICE_STORAGE_KEY,
  BETA_NOTICE_TITLE,
  isBetaActive,
  parseBetaNoticeState,
  shouldShowBetaBanner,
  shouldShowBetaNotice,
} from "@/lib/beta";
import { Dialog } from "../ui/Dialog";

/** <html data-busy> — set by any surface the visitor must not be interrupted on. */
const BUSY_ATTRIBUTE = "data-busy";

/** How often the suppressed case is re-checked, and how long the first check waits. */
const CHECK_INTERVAL_MS = 400;

const neverChanges = () => () => {};

function readStored(): ReturnType<typeof parseBetaNoticeState> {
  try {
    return parseBetaNoticeState(localStorage.getItem(BETA_NOTICE_STORAGE_KEY));
  } catch {
    // Storage blocked (private window, third-party cookie rules): treat it as
    // "never seen". The notice then shows once per page load rather than once
    // per browser, which is the safe direction for a disclosure.
    return null;
  }
}

function remember(forever: boolean): void {
  try {
    localStorage.setItem(BETA_NOTICE_STORAGE_KEY, JSON.stringify({ dismissedAt: Date.now(), forever }));
  } catch {
    // Storage blocked: nothing to remember. The modal may return next visit.
  }
}

/**
 * The beta disclosure: a modal on the first visit, then a slim banner pinned
 * at the top for the rest of the beta.
 *
 * Mounted once in the root layout. Everything it decides comes from
 * `lib/beta.ts`, so when the beta end date passes BOTH the modal and the
 * banner stop rendering on their own — the banner disappears together with the
 * beta price, with no deploy.
 */
export function BetaNotice() {
  // Nothing renders until mount: the decision reads localStorage, which the
  // server cannot see, and a banner in the server HTML would flash for a
  // visitor who dismissed it.
  const mounted = useSyncExternalStore(
    neverChanges,
    () => true,
    () => false,
  );
  const [open, setOpen] = useState(false);
  const [never, setNever] = useState(false);
  const pathname = usePathname();
  /** The element focus returns to when the dialog closes. */
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!mounted) return;
    let timer = 0;
    const check = () => {
      const allowed = shouldShowBetaNotice({
        now: Date.now(),
        stored: readStored(),
        pathname,
        busy: document.documentElement.hasAttribute(BUSY_ATTRIBUTE),
      });
      if (!allowed) {
        // A render or a checkout may be in flight; keep waiting for it. Give
        // up only when nothing can change any more.
        if (!isBetaActive() || readStored()?.forever) window.clearInterval(timer);
        return;
      }
      window.clearInterval(timer);
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOpen(true);
    };
    // The first check runs on the first tick, not in this effect: it lets the
    // page paint before anything covers it.
    timer = window.setInterval(check, CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [mounted, pathname]);

  const close = useCallback(() => {
    remember(never);
    setOpen(false);
    // Native <dialog> restores focus itself in current browsers; do it
    // explicitly so the banner's own trigger always gets it back.
    opener.current?.focus();
    opener.current = null;
  }, [never]);

  const reopen = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    opener.current = event.currentTarget;
    setOpen(true);
  }, []);

  const showBanner = mounted && shouldShowBetaBanner();

  useEffect(() => {
    if (!showBanner) return;
    const root = document.documentElement;
    root.setAttribute("data-beta-banner", "");
    return () => root.removeAttribute("data-beta-banner");
  }, [showBanner]);

  if (!mounted) return null;

  return (
    <>
      {showBanner ? (
        <div className="beta-banner">
          <div className="beta-banner__inner">
            <span className="tag tag-accent beta-banner__badge">{BETA_BADGE}</span>
            <span className="beta-banner__text">{BETA_BANNER_TEXT}</span>
            <button type="button" className="link-button beta-banner__more" onClick={reopen}>
              {BETA_BANNER_LINK}
            </button>
          </div>
        </div>
      ) : null}

      {/* Esc and a click on the backdrop both close it; focus is trapped by
          showModal() while it is open. */}
      <Dialog
        open={open}
        onClose={close}
        className="beta-sheet"
        maxWidth={560}
        title={BETA_NOTICE_TITLE}
        titleExtra={<span className="tag tag-accent beta-dialog__badge">{BETA_BADGE}</span>}
      >
        <ol className="beta-points">
          {BETA_NOTICE_POINTS.map((point) => (
            <li key={point.title}>
              <strong>{point.title}</strong>
              <span>{point.body}</span>
            </li>
          ))}
        </ol>
        <p className="beta-fineprint">
          {BETA_NOTICE_DISCLAIMER} · <Link href="/terms">เงื่อนไขการใช้งาน</Link>
        </p>
        <label className="agree agree--flush">
          <input
            type="checkbox"
            className="agree__box"
            checked={never}
            onChange={(event) => setNever(event.target.checked)}
          />
          <span className="agree__text">{BETA_NOTICE_NEVER}</span>
        </label>
        <div className="dialog-actions">
          <button type="button" className="btn btn-primary" onClick={close}>
            {BETA_NOTICE_DISMISS}
          </button>
        </div>
      </Dialog>
    </>
  );
}
