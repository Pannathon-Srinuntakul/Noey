import type { ReactNode } from "react";
import { WordReveal } from "./WordReveal";

/**
 * The top of every inner page: breadcrumb (or eyebrow), the H1 — which, in
 * view at load, stays put while a gold "now speaking" highlight runs across
 * it — the lead, a meta line (the visible "อัปเดตล่าสุด" date), and an
 * optional visual on the right. Starts under the floating header.
 */
export function PageHero({
  title,
  crumb,
  lead,
  meta,
  aside,
  id = "page-title",
  soft,
  size = "h-1",
  className,
  children,
}: {
  title: string;
  crumb?: ReactNode;
  lead?: ReactNode;
  meta?: ReactNode;
  aside?: ReactNode;
  id?: string;
  soft?: readonly number[];
  size?: "h-display" | "h-1" | "h-2";
  className?: string;
  children?: ReactNode;
}) {
  return (
    <header className={["phero page-top", aside ? "phero--split" : null, className].filter(Boolean).join(" ")}>
      <div className="phero__backdrop" aria-hidden="true">
        <span className="phero__beam" />
        <span className="phero__ruler" />
      </div>
      <div className="wrap phero__inner">
        <div className="phero__copy">
          {crumb ? <div className="phero__crumb">{crumb}</div> : null}
          <WordReveal as="h1" id={id} text={title} className={size} soft={soft} />
          {lead ? <div className="phero__lead">{lead}</div> : null}
          {children}
          {meta ? <div className="phero__meta">{meta}</div> : null}
        </div>
        {aside ? <div className="phero__aside">{aside}</div> : null}
      </div>
    </header>
  );
}
