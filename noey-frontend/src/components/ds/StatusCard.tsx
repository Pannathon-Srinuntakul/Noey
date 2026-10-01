import type { ReactNode } from "react";
import { NoeyMark } from "../NoeyMark";
import "../../styles/parts/status.css";

export type StatusTone = "success" | "celebrate" | "danger" | "info" | "pending" | "quiet";

/**
 * The one card every utility page is built on (verify email, reset password,
 * checkout, account deleted, errors): a state emblem — the splice mark in the
 * state's colour, with a render bar that is full with a tick (done), cut
 * (failed), running (waiting), part-way (information) or empty (quiet) — then
 * the title, what happened, and what to do next. "celebrate" is done in the
 * brand's gold, for the one paid moment (checkout).
 */
export function StatusCard({
  tone,
  eyebrow,
  title,
  titleAs: Title = "h1",
  titleId,
  children,
  actions,
  role,
  busy,
  readout,
  start,
  footer,
  className,
}: {
  tone: StatusTone;
  eyebrow?: ReactNode;
  title: ReactNode;
  titleAs?: "h1" | "h2";
  titleId?: string;
  children?: ReactNode;
  actions?: ReactNode;
  role?: "status" | "alert";
  busy?: boolean;
  /** A readout under the render bar, as the editor prints one ("EXPORT · 100%"); decoration. */
  readout?: string;
  /** The whole card reads from the left (a calm, plain ending). */
  start?: boolean;
  /** Under the actions (e.g. the computer-only note). */
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={["status", `status--${tone}`, start ? "status--start" : null, className].filter(Boolean).join(" ")}
      role={role}
      aria-busy={busy || undefined}
      aria-labelledby={titleId}
    >
      <div className="status__emblem" aria-hidden="true">
        <span className="status__halo" />
        {/* A lighter stroke at this size keeps the splice gap open (≈2px, not 1). */}
        <NoeyMark size={46} strokeWidth={11} draw className="status__mark" />
        <span className="status__meter">
          <span className="status__bar">
            <span className="status__fill" />
            <span className="status__gap" />
          </span>
          {tone === "success" || tone === "celebrate" ? (
            <svg className="status__tick" viewBox="0 0 20 20" width="20" height="20" fill="none">
              <circle cx="10" cy="10" r="9" />
              <path d="M6 10.4 8.7 13 14 7.4" pathLength={1} />
            </svg>
          ) : null}
        </span>
        {readout ? <span className="status__readout tc">{readout}</span> : null}
      </div>
      {eyebrow ? <p className="status__eyebrow">{eyebrow}</p> : null}
      <Title className="status__title" id={titleId}>
        {title}
      </Title>
      {children ? <div className="status__body">{children}</div> : null}
      {actions ? <div className="status__actions">{actions}</div> : null}
      {footer}
    </section>
  );
}
