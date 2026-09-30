"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  BETA_BADGE,
  BETA_NOTICE_DISMISS,
  BETA_NOTICE_NEVER,
  BETA_NOTICE_STORAGE_KEY,
  betaNoticeCopy,
  isBetaActive,
  parseBetaNoticeState,
  shouldShowBetaBanner,
  shouldShowBetaNotice,
} from "@/lib/beta";
import { Dialog } from "../ui/Dialog";

/** <html data-busy> — set by any surface the visitor must not be interrupted on. */
const BUSY_ATTRIBUTE = "data-busy";

/** Fired by the strip's "รายละเอียด" button (BetaBanner) to reopen the notice. */
export const BETA_OPEN_EVENT = "noey:beta-open";

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
 * The beta disclosure's modal: it opens on the first visit, then the pinned
 * strip (BetaBanner, rendered on the server so it never shifts the page)
 * stays for the rest of the beta and can reopen it.
 *
 * Mounted once in the root layout. Everything it decides comes from
 * `lib/beta.ts`, so when the beta end date passes BOTH the modal and the
 * strip stop rendering on their own — the strip disappears together with the
 * beta price, with no deploy (and this component takes it down on the spot
 * for a page that was cached before the date passed).
 */
export function BetaNotice({ betaPriced }: { betaPriced: boolean }) {
  const copy = betaNoticeCopy(betaPriced);
  // Nothing renders until mount: the decision reads localStorage, which the
  // server cannot see.
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

  // The strip's "รายละเอียด" button lives in the server-rendered banner.
  useEffect(() => {
    const reopen = (event: Event) => {
      const from = (event as CustomEvent<HTMLElement | null>).detail;
      opener.current = from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      setOpen(true);
    };
    window.addEventListener(BETA_OPEN_EVENT, reopen);
    return () => window.removeEventListener(BETA_OPEN_EVENT, reopen);
  }, []);

  // A page cached before the end date still carries the strip: take it down.
  useEffect(() => {
    if (shouldShowBetaBanner()) return;
    document.documentElement.removeAttribute("data-beta-banner");
    document.querySelector("[data-beta-strip]")?.setAttribute("hidden", "");
  }, []);

  const close = useCallback(() => {
    remember(never);
    setOpen(false);
    // Native <dialog> restores focus itself in current browsers; do it
    // explicitly so the strip's own trigger always gets it back.
    opener.current?.focus();
    opener.current = null;
  }, [never]);

  if (!mounted) return null;

  return (
    // Esc and a click on the backdrop both close it; focus is trapped by
    // showModal() while it is open.
    <Dialog
      open={open}
      onClose={close}
      className="beta-sheet"
      maxWidth={580}
      title={copy.title}
      titleExtra={<span className="tag tag-accent beta-dialog__badge">{BETA_BADGE}</span>}
    >
      <ol className="beta-points">
        {copy.points.map((point) => (
          <li key={point.title}>
            <strong>{point.title}</strong>
            <span>{point.body}</span>
          </li>
        ))}
      </ol>
      <p className="beta-fineprint">
        {copy.disclaimer} · <Link href="/terms">เงื่อนไขการใช้งาน</Link>
      </p>
      <label className="agree agree--flush">
        <input type="checkbox" className="agree__box" checked={never} onChange={(event) => setNever(event.target.checked)} />
        <span className="agree__text">{BETA_NOTICE_NEVER}</span>
      </label>
      <div className="dialog-actions">
        <button type="button" className="btn btn-primary" onClick={close}>
          {BETA_NOTICE_DISMISS}
        </button>
      </div>
    </Dialog>
  );
}
