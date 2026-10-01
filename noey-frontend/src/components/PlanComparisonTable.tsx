import { BETA_PRICE_NOTE, BETA_STRIKE_LABEL } from "@/lib/beta";
import {
  APPROX_CUTS_PER_MONTH,
  APPROX_HIGH_CUTS_PER_MONTH,
  CLIPS_FOOTNOTE,
  COMPARISON_ROWS,
  CUTS_APPROX_SHORT,
  CUTS_OVER_FOOTAGE_SHORT,
  CUTS_SHORT_OF_BUDGET,
  FREE_ONCE,
  PLAN_COPY,
  TIERS,
  displayPrice,
  isBetaPriced,
  strikePrice,
  type Precision,
  type PriceTable,
  type Tier,
} from "@/lib/plans";
import "../styles/parts/plans.css";
import { IconArrowRight, IconCheck } from "./ds/icons";
import { keepThaiProse } from "./ds/ThaiProse";
import { ClipsBasis, CutsCount, CutsNumber, CutsWord } from "./pricing/CutsCount";

/**
 * A clip-count cell, marked for /pricing's calculator: the same text as the
 * row's value at the default. The ระดับละเอียด row exists only in ตัดฉากเด่น
 * (the calculator hides the row in the other modes), so its words are fixed.
 */
function CutsCell({ tier, precision }: { tier: Tier; precision: Precision }) {
  if (precision === "high") {
    const count = APPROX_HIGH_CUTS_PER_MONTH[tier];
    if (!count) return "—";
    return (
      <CutsCount tier={tier} precision="high">
        {`${CUTS_APPROX_SHORT} `}
        <CutsNumber value={count} /> คลิป
      </CutsCount>
    );
  }
  return (
    <CutsCount tier={tier} over={CUTS_OVER_FOOTAGE_SHORT} short={CUTS_SHORT_OF_BUDGET}>
      <CutsWord word="hedge" />{" "}
      <span className="kt">
        <CutsNumber value={APPROX_CUTS_PER_MONTH[tier]} /> <CutsWord word="unit" />
      </span>
      {tier === "free" ? ` ${FREE_ONCE}` : null}
    </CutsCount>
  );
}

/**
 * The seven-plan comparison table. Rendered on /pricing and again on the help
 * page, from the SAME `PriceTable` and `COMPARISON_ROWS`, so the two pages
 * cannot drift apart. `labelledBy` is the id of the <h2> that introduces it;
 * the table's caption takes that id plus "-caption".
 *
 * The header row and the first column stay in place while the rest scrolls
 * (the page on wide screens, the table's own box on narrow ones), and the
 * row and column under the pointer light up like a selection in the editor.
 */
export function PlanComparisonTable({
  table,
  labelledBy,
  footnote = true,
}: {
  table: PriceTable;
  labelledBy: string;
  /**
   * The basis of the clip counts under the table. "live" (/pricing) states the
   * mode and length the calculator above has set, marked so it follows them.
   */
  footnote?: boolean | "live";
}) {
  return (
    <div className="cmp">
      {/* Where the table scrolls sideways (narrow screens), say so above it:
          the fading right edge alone was easy to miss. */}
      <p className="cmp__hint" aria-hidden="true">
        เลื่อนดูทุกแพลน
        <IconArrowRight size={14} />
      </p>
      {/* Named by the table's caption: the section around it is already
          named by the heading, and two landmarks would share one name. */}
      <div className="cmp__scroll" role="region" aria-labelledby={`${labelledBy}-caption`} tabIndex={0}>
        <table className="table cmp__table">
          <caption id={`${labelledBy}-caption`} className="sr-only">
            เทียบราคาและความสามารถของแพลนฟรี Lite Starter Pro Studio Agency และ Max
          </caption>
          <thead>
            <tr>
              <th scope="col" className="cmp__corner">
                ความสามารถ
              </th>
              {TIERS.map((tier) => (
                <th key={tier} scope="col" data-plan-col={tier} className={PLAN_COPY[tier].recommended ? "c cmp__plan cmp__plan--recommended" : "c cmp__plan"}>
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
                  <td key={tier} data-plan-col={tier} className={PLAN_COPY[tier].recommended ? "c num cmp__rec" : "c num"}>
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
              <tr key={row.label} data-cuts-row={row.cuts === "high" ? "high" : undefined}>
                <th scope="row">{keepThaiProse(row.label)}</th>
                {row.values.map((value, index) => (
                  <td
                    key={TIERS[index]}
                    data-plan-col={TIERS[index]}
                    className={[row.numeric ? "c num" : "c", value === "—" ? "cmp__none" : null, PLAN_COPY[TIERS[index]].recommended ? "cmp__rec" : null]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    {row.cuts && value !== "—" ? (
                      <CutsCell tier={TIERS[index]} precision={row.cuts} />
                    ) : value === "มี" ? (
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
      {footnote === "live" ? (
        <p className="table-note">
          {"จำนวนคลิปในตาราง"}
          <ClipsBasis />
          {" ตามที่ตั้งไว้ในส่วนแพลนด้านบน ปัดลง"}
        </p>
      ) : footnote ? (
        <p className="table-note">{keepThaiProse(CLIPS_FOOTNOTE)}</p>
      ) : null}
      {isBetaPriced(table) ? <p className="table-note">{keepThaiProse(BETA_PRICE_NOTE)}</p> : null}
    </div>
  );
}
