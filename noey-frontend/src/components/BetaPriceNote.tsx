import { BETA_BADGE, BETA_PRICE_AFTER_SHORT, BETA_PRICE_LINE } from "@/lib/beta";
import { isBetaPriced, type PriceTable } from "@/lib/plans";
import { keepThai } from "./ds/ThaiText";

/**
 * The strip that sits above every price grid: what the discount is, when it
 * ends, and what happens to the bill after that.
 *
 * It asks the price table, not just the date, so it never claims a discount
 * next to an undiscounted number. Once the beta ends the backend charges the
 * full ladder and the strip disappears on the next revalidation — no deploy.
 *
 * `compact` is the one-line form for tight surfaces.
 */
export function BetaPriceNote({ table, compact = false }: { table: PriceTable; compact?: boolean }) {
  if (!isBetaPriced(table)) return null;
  return (
    <p className={compact ? "beta-note beta-note--compact" : "beta-note"}>
      <span className="tag tag-accent beta-note__badge">{BETA_BADGE}</span>
      <span>
        <strong className="beta-note__lead">{BETA_PRICE_LINE}</strong>
        {" \u00b7 "}
        {keepThai(BETA_PRICE_AFTER_SHORT)}
      </span>
    </p>
  );
}
