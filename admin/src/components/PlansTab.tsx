"use client";

import { b0, baht, daysAgo, num, pct } from "@/lib/format";
import type { Summary } from "@/lib/money";
import { PLAN_KEYS, planLabel } from "@/lib/plans";
import { LOSS, OK } from "./ui";

export function PlansTab({ s, prices, onOpen }: { s: Summary; prices: Record<string, number>; onOpen: (id: number) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {PLAN_KEYS.map((k) => {
        const g = s.all.filter((u) => u.plan === k);
        if (k === "enterprise" && g.length === 0) return null;
        const paying = g.filter((u) => !u.internal);
        const rev = g.reduce((acc, u) => acc + u.pays, 0);
        const cst = g.reduce((acc, u) => acc + u.cost, 0);
        const prof = rev - cst;
        const clips = g.reduce((acc, u) => acc + u.clips, 0);
        const price = Number(prices[k] || 0);
        const stats = [
          { label: "รายได้", value: b0(rev) },
          { label: "ต้นทุน", value: baht(cst) },
          { label: "กำไร", value: baht(prof), color: prof >= 0 ? OK : LOSS },
          { label: "อัตรากำไร", value: rev > 0 ? pct((prof / rev) * 100) : "—", color: prof >= 0 ? OK : LOSS },
          { label: "คลิป", value: num(clips) },
          { label: "ต้นทุน/คน", value: g.length ? baht(cst / g.length) : "—" },
        ];
        const priceText = k === "enterprise" ? "ผู้ดูแลตั้งให้ ไม่มีราคาขาย" : price === 0 ? "ไม่มีค่าบริการ" : `${b0(price)}/เดือน`;
        const note = paying.length === 0 && price > 0 ? "ยังไม่มีใครซื้อแผนนี้" : "";
        return (
          <section key={k} style={{ border: "1px solid var(--color-divider)", borderRadius: 4 }} aria-label={`แผน ${planLabel(k)}`}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", padding: "16px 20px 14px", borderBottom: "1px solid var(--color-divider)" }}>
              <span style={{ fontSize: 18, fontWeight: 500 }}>{planLabel(k)}</span>
              <span style={{ fontSize: 13, color: "var(--color-neutral-600)" }}>{priceText}</span>
              <span className="tag tag-neutral">{g.length} คน</span>
              <span style={{ fontSize: 12.5, color: "var(--color-neutral-600)" }}>{note}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(118px, 1fr))", borderBottom: "1px solid var(--color-divider)" }}>
              {stats.map((st) => (
                <div key={st.label} style={{ padding: "13px 20px", borderRight: "1px solid var(--color-divider)" }}>
                  <p style={{ margin: 0, fontSize: 12.5, color: "var(--color-neutral-700)" }}>{st.label}</p>
                  <p className="num" style={{ margin: "4px 0 0", fontSize: 21, fontWeight: 300, lineHeight: 1.1, color: st.color ?? "var(--color-text)" }}>{st.value}</p>
                </div>
              ))}
            </div>
            {g.length === 0 && <p style={{ margin: 0, padding: "16px 20px", fontSize: 13, color: "var(--color-neutral-600)" }}>ยังไม่มีผู้ใช้ในแผนนี้</p>}
            {g.length > 0 && (
              <table className="table" style={{ fontFamily: "inherit", fontSize: 13.5 }}>
                <tbody>
                  {g
                    .slice()
                    .sort((a, b) => b.cost - a.cost)
                    .map((u) => (
                      <tr key={u.id} className="clickable-row" tabIndex={0} onClick={() => onOpen(u.id)}
                        onKeyDown={(e) => { if (e.key === "Enter") onOpen(u.id); }}>
                        <td style={{ paddingLeft: 20 }}>
                          {u.email}
                          <span style={{ fontSize: 11.5, color: "var(--color-neutral-600)", marginLeft: 8 }}>
                            {u.internal ? "บัญชีผู้ดูแล" : !u.active ? "ปิดใช้งาน" : ""}
                          </span>
                        </td>
                        <td className="num" style={{ textAlign: "right" }}>{u.internal ? "—" : b0(u.pays)}</td>
                        <td className="num" style={{ textAlign: "right" }}>{baht(u.cost)}</td>
                        <td className="num" style={{ textAlign: "right", fontWeight: 500, color: u.internal ? "var(--color-neutral-600)" : u.profit >= 0 ? OK : LOSS }}>
                          {u.internal ? "—" : baht(u.profit)}
                        </td>
                        <td className="num" style={{ textAlign: "right" }}>{num(u.clips)} คลิป</td>
                        <td className="num" style={{ textAlign: "right" }}>{num(u.sttMin)} นาที</td>
                        <td className="num" style={{ textAlign: "right", paddingRight: 20, color: "var(--color-neutral-600)" }}>{daysAgo(u.last_active_days)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}
    </div>
  );
}
