import { COMPARISON_ROWS, PLAN_COPY, TIERS, displayPrice, type PriceTable } from "@/lib/plans";

/**
 * The seven-plan comparison table. Rendered on /pricing and again on the help
 * page, from the SAME `PriceTable` and `COMPARISON_ROWS`, so the two pages
 * cannot drift apart. `labelledBy` is the id of the <h2> that introduces it.
 */
export function PlanComparisonTable({ table, labelledBy }: { table: PriceTable; labelledBy: string }) {
  return (
    <div className="table-scroll" role="region" aria-labelledby={labelledBy} tabIndex={0}>
      <table className="table">
        <caption className="sr-only">เทียบราคาและความสามารถของแพลนฟรี Lite Starter Pro Studio Agency และ Max</caption>
        <thead>
          <tr>
            <th scope="col">ความสามารถ</th>
            {TIERS.map((tier) => (
              <th key={tier} scope="col" className="c">
                {PLAN_COPY[tier].name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">ราคา (บาท / เดือน)</th>
            {TIERS.map((tier) => (
              <td key={tier} className="c num">
                {displayPrice(table, tier) ?? "—"}
              </td>
            ))}
          </tr>
          {COMPARISON_ROWS.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              {row.values.map((value, index) => (
                <td key={TIERS[index]} className={row.numeric ? "c num" : "c"}>
                  {value}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
