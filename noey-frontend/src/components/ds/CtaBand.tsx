import type { ReactNode } from "react";
import { NoeyMark } from "../NoeyMark";
import { WordReveal } from "./WordReveal";

/**
 * The closing scene of a page: a fade to black (the band is a night scene in
 * both themes), the splice mark drawing itself in, then the call to action.
 * It hands straight over to the end-credits footer.
 */
export function CtaBand({
  id,
  title,
  titleAs = "h2",
  children,
  actions,
  compact = false,
  end = true,
}: {
  id?: string;
  title: string;
  titleAs?: "h2" | "h3";
  children?: ReactNode;
  actions: ReactNode;
  compact?: boolean;
  /** The band closes the page (the footer then skips its own fade). */
  end?: boolean;
}) {
  const classes = ["cta-band", "theme-night", compact ? "cta-band--compact" : null, end ? "cta-band--end" : null].filter(Boolean).join(" ");
  return (
    <section className={classes} aria-labelledby={id}>
      <div className="cta-band__fade" aria-hidden="true" />
      <div className="wrap cta-band__inner">
        <div className="cta-band__mark" data-reveal="draw" aria-hidden="true">
          <NoeyMark size={compact ? 56 : 88} draw />
        </div>
        <WordReveal as={titleAs} id={id} text={title} className={compact ? "h-2" : "h-display"} />
        {children ? <div className="cta-band__text">{children}</div> : null}
        <div className="cta-band__actions">{actions}</div>
      </div>
    </section>
  );
}
