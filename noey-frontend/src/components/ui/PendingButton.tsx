import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * The site's one pending style for a button that waits on the server (every
 * form's submit: sign-in, sign-up, reset, contact, plans and checkout,
 * profile, delete account). Callers keep their own `disabled` rule exactly
 * as it was; `busy` is their pending flag.
 *
 * While busy (loading.css): the button keeps its size and colours — its
 * label and its "กำลัง…" label share one grid cell, so the width never jumps;
 * the "กำลัง…" label takes over after 150 ms, so a quick answer changes
 * nothing on screen — a small playhead runs along its bottom edge (mounted
 * while busy, appearing after the same 150 ms; still with reduced motion:
 * the track lit, the playhead parked), and it carries aria-busy. The label
 * that is not showing is hidden from assistive technology too (visibility),
 * so the button's name is the one on screen.
 */
export function PendingButton({
  busy,
  busyLabel,
  className,
  children,
  type = "submit",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  busy: boolean;
  /** What the button says while busy (its existing "กำลัง…" wording). */
  busyLabel: ReactNode;
}) {
  // A full-width button cannot change width: at rest it is just its label,
  // and gets the "กำลัง…" one only while busy. Any other keeps both, stacked
  // in one cell, so its width never changes.
  const stacked = !/\bbtn-block\b/.test(className ?? "");
  const labelled = busy || stacked;
  return (
    <button type={type} {...rest} className={[className, labelled ? "pbtn" : null].filter(Boolean).join(" ")} aria-busy={busy || undefined}>
      {labelled ? (
        <span className="pbtn__labels">
          <span>{children}</span>
          <span>{busyLabel}</span>
        </span>
      ) : (
        children
      )}
      {busy ? (
        <span className="pend" data-on="" aria-hidden="true">
          <i />
        </span>
      ) : null}
    </button>
  );
}
