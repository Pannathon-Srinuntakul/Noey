import { BETA_PRICE_NOTE, BETA_STRIKE_LABEL } from "@/lib/beta";
import { CLIPS_FOOTNOTE, COMPARISON_ROWS, PLAN_COPY, TIERS, displayPrice, isBetaPriced, strikePrice, type PriceTable } from "@/lib/plans";
import "../styles/parts/plans.css";
import { IconCheck } from "./ds/icons";
import { keepThaiProse } from "./ds/ThaiProse";

/**
 * The seven-plan comparison table. Rendered on /pricing and again on the help
 * page, from the SAME `PriceTable` and `COMPARISON_ROWS`, so the two pages
 * cannot drift apart. `labelledBy` is the id of the <h2> that introduces it.
 *
 * The header row and the first column stay in place while the rest scrolls
 * (the page on wide screens, the table's own box on narrow ones), and the
 * row and column under the pointer light up like a selection in the editor.
 */
export function PlanComparisonTable({ table, labelledBy }: { table: PriceTable; labelledBy: string }) {
  return (
    <div className="cmp">
      <div className="cmp__scroll" role="region" aria-labelledby={labelledBy} tabIndex={0}>
        <table className="table cmp__table">
          <caption className="sr-only">เทียบราคาและความสามารถของแพลนฟรี Lite Starter Pro Studio Agency และ Max</caption>
          <thead>
            <tr>
              <th scope="col" className="cmp__corner">
                ความสามารถ
              </th>
              {TIERS.map((tier) => (
                <th key={tier} scope="col" className={PLAN_COPY[tier].recommended ? "c cmp__plan cmp__plan--recommended" : "c cmp__plan"}>
                  {PLAN_COPY[tier].name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="cmp__price">
              <th scope="row">ราคา (บาท / เดือน)</th>
              {TIERS.map((tier) => {
                const full = strikePrice(table, tier);
                return (
                  <td key={tier} className="c num">
                    {full ? (
                      <s className="price-strike">
                        <span className="sr-only">{BETA_STRIKE_LABEL} </span>
                        {full}
                      </s>
                    ) : null}
                    {displayPrice(table, tier) ?? "—"}
                  </td>
                );
              })}
            </tr>
            {COMPARISON_ROWS.map((row) => (
              <tr key={row.label}>
                <th scope="row">{keepThaiProse(row.label)}</th>
                {row.values.map((value, index) => (
                  <td key={TIERS[index]} className={[row.numeric ? "c num" : "c", value === "—" ? "cmp__none" : null].filter(Boolean).join(" ")}>
                    {value === "มี" ? (
                      // A tick reads faster than fifty "มี"; the word stays for screen readers.
                      <>
                        <IconCheck size={16} className="cmp__yes" />
                        <span className="sr-only">มี</span>
                      </>
                    ) : (
                      keepThaiProse(value)
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* The clip counts in the table are estimates; say on what. */}
      <p className="table-note">{keepThaiProse(CLIPS_FOOTNOTE)}</p>
      {isBetaPriced(table) ? <p className="table-note">{keepThaiProse(BETA_PRICE_NOTE)}</p> : null}
    </div>
  );
}
