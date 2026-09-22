"use client";

import { RUN_KIND_LABEL, accuracyVerdict, ratioLabel } from "@/lib/billing";
import { b0, baht, num, pct, thaiDay, thaiMonth } from "@/lib/format";
import { breakEvenByPlan, dailyChart, monthBars, type Ctx, type Summary } from "@/lib/money";
import { planLabel } from "@/lib/plans";
import type { DashboardData } from "@/lib/types";
import { LOSS, OK, TASKS, TaskBars } from "./ui";

export function OverviewTab({ ctx, s, data }: { ctx: Ctx; s: Summary; data: DashboardData }) {
  const profitColor = s.profit >= 0 ? OK : LOSS;
  const vatNote = ctx.cfg.vat_included ? " · หัก VAT แล้ว" : "";

  const kpis = [
    {
      label: "รายได้", value: b0(s.tRevenue),
      sub: `สมาชิก ${s.payers} คน${s.tTopup > 0 ? ` · เติมเงิน ${b0(s.tTopup)}` : ""}${vatNote}`,
    },
    { label: "ต้นทุนรวม", value: b0(s.costTotal), sub: `ใช้งาน ${b0(s.tToken + s.tStt + s.tExtra)} · คงที่ ${b0(s.otherFixed)}` },
    {
      label: "กำไรสุทธิ", value: b0(s.profit), color: profitColor,
      sub: s.monthlyProfit >= 0 ? `ทั้งเดือนคาดว่ากำไร ${b0(s.monthlyProfit)}` : `ทั้งเดือนคาดว่าขาดทุน ${b0(Math.abs(s.monthlyProfit))}`,
    },
    { label: "อัตรากำไร", value: s.tRevenue > 0 ? pct((s.profit / s.tRevenue) * 100) : "—", color: profitColor, sub: `ในนั้นเป็นต้นทุนผู้ใช้ฟรี ${b0(s.freeCost)}` },
  ];

  const acc = data.estimate_accuracy;
  const verdict = accuracyVerdict(acc?.overall);
  const unitKpis = [
    {
      label: "ต้นทุนต่อ 1 ล้านโทเค็น", value: s.costPer1M === null ? "—" : baht(s.costPer1M),
      sub: `อ้างอิง ฿${num(ctx.referencePer1M ?? 50)} · ${num(s.tRateTokens)} โทเค็นในช่วงนี้`,
      color: s.costPer1M !== null && s.costPer1M > (ctx.referencePer1M ?? 50) ? LOSS : undefined,
    },
    {
      label: "กำไรต่อ 1 ล้านโทเค็น", value: s.marginPer1M === null ? "—" : baht(s.marginPer1M),
      sub: `ขาย ฿${num(ctx.sellPer1M)} · ${s.marginPer1M === null ? "ยังไม่มีการใช้ที่คิดโทเค็น" : pct((s.marginPer1M / ctx.sellPer1M) * 100)}`,
      color: s.marginPer1M === null ? undefined : s.marginPer1M >= 0 ? OK : LOSS,
    },
    {
      label: "ยอดเงินเติมคงเหลือ", value: baht(s.tWalletBalance),
      sub: `ใช้ไปในช่วงนี้ ${baht(s.tWalletSpent)} · เติม ${s.topupBuyers} คน`,
    },
    {
      label: "ประเมินเทียบใช้จริง", value: acc && acc.overall.runs > 0 ? ratioLabel(acc.overall.median_ratio) : "—",
      sub: acc && acc.overall.runs > 0
        ? `${acc.overall.runs} งาน · p90 ${ratioLabel(acc.overall.p90_ratio)} · เกินเพดาน ${acc.overall.over_ceiling}`
        : "ยังไม่มีงานที่ปิดแล้ว",
      color: verdict === "under" || verdict === "over" ? LOSS : verdict === "good" ? OK : undefined,
    },
  ];
  const cb = data.circuit_breaker;

  const byPlan = breakEvenByPlan(ctx, s);
  const bePct = Math.min(100, (s.mRevenue / Math.max(1, s.monthlyCost)) * 100);

  const chart = dailyChart(ctx, data, s);
  const H = 172;
  const maxDay = Math.max(...chart.days.map((d) => d.variable + d.fixed), 1);

  const taskSum = TASKS.reduce((acc, t) => acc + Math.max(0, s.taskTotals[t.k]), 0) || 1;
  const taskMax = Math.max(...TASKS.map((t) => Math.max(0, s.taskTotals[t.k])), 1);
  const taskRows = TASKS.map((t) => {
    const v = Math.max(0, s.taskTotals[t.k]);
    return { label: t.label, color: t.color, value: baht(v), pct: pct((v / taskSum) * 100), w: Math.round((v / taskMax) * 100) };
  });

  const months = monthBars(ctx, data, s);
  const mMax = Math.max(...months.map((m) => Math.max(m.revenue, m.cost)), 1);

  const heavyFree = s.counted.filter((u) => !u.internal && u.planPrice === 0).sort((a, b) => b.cost - a.cost)[0];
  const notes = [
    cb && cb.enabled && cb.tripped
      ? {
          color: LOSS,
          title: cb.hard_stopped ? "เพดานค่าใช้จ่ายวันนี้เกินจุดหยุดทันทีแล้ว — งานที่กำลังทำถูกหยุด" : "ถึงเพดานค่าใช้จ่ายวันนี้แล้ว — ไม่รับงานใหม่",
          body: `ใช้ไป ${baht(cb.spend_today_thb)} จากเพดาน ${baht(cb.daily_cap_thb, 0)} (วัน UTC ${cb.day}) · ปรับได้ที่แท็บต้นทุน`,
        }
      : null,
    verdict === "under" || verdict === "over"
      ? {
          color: LOSS,
          title: verdict === "under" ? "การประเมินต่ำกว่าที่ใช้จริง" : "การประเมินสูงเกินจริงมาก",
          body: verdict === "under"
            ? "งานใช้โทเค็นเกินที่จองไว้ ผู้ใช้อาจถูกหยุดกลางงาน — ควรปรับค่าประเมินในระบบ"
            : "ผู้ใช้อาจถูกปฏิเสธงานที่จริงๆ ยังพอ — ควรปรับค่าประเมินในระบบ",
        }
      : null,
    heavyFree && heavyFree.cost > 0
      ? {
          color: LOSS,
          title: `${heavyFree.email} อยู่แผน${planLabel(heavyFree.plan)}แต่ก่อต้นทุน ${baht(heavyFree.cost)}`,
          body: `${Math.round(heavyFree.clips)} คลิป ไม่มีรายได้กลับมา · แผนฟรีทั้งหมดรวม ${baht(s.freeCost)}`,
        }
      : null,
    s.costPer1M !== null && s.marginPer1M !== null
      ? {
          color: s.marginPer1M >= 0 ? OK : LOSS,
          title: `ต้นทุนจริง ${baht(s.costPer1M)} ต่อ 1 ล้านโทเค็น · กำไร ${baht(s.marginPer1M)}`,
          body: `ขาย ฿${ctx.sellPer1M} ต่อ 1 ล้านโทเค็นทุกแผน · คิดจากต้นทุนที่บันทึกไว้ของแต่ละคำขอ (ยังไม่รวม VAT ผู้ให้บริการและค่าธรรมเนียมบัตร)`,
        }
      : null,
    { color: LOSS, title: `งานล้มเหลว ${s.tFailed} งาน เสียเปล่า ${baht(s.wasted)}`, body: "ส่วนใหญ่จ่ายค่าถอดเสียงไปแล้วก่อนจะพัง" },
    { color: "var(--color-neutral-500)", title: `ไม่ได้เข้ามาเกิน 14 วัน ${s.idle} คน`, body: "จำนวนนี้ยังตามถามเองได้ทีละคน" },
  ].filter(Boolean) as Array<{ color: string; title: string; body: string }>;

  return (
    <div>
      <div className="kpis">
        {kpis.map((k) => (
          <div key={k.label} className="kpi">
            <p className="kpi-label">{k.label}</p>
            <p className="kpi-value" style={k.color ? { color: k.color } : undefined}>{k.value}</p>
            <p className="kpi-sub">{k.sub}</p>
          </div>
        ))}
      </div>

      <div className="kpis" style={{ marginTop: 20 }}>
        {unitKpis.map((k) => (
          <div key={k.label} className="kpi">
            <p className="kpi-label">{k.label}</p>
            <p className="kpi-value" style={{ fontSize: 26, ...(k.color ? { color: k.color } : {}) }}>{k.value}</p>
            <p className="kpi-sub">{k.sub}</p>
          </div>
        ))}
      </div>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))" }}>
        <section className="card" aria-labelledby="ledger-title">
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
            <p id="ledger-title" className="card-title">เงินหายไปกับอะไร</p>
            <span style={{ flex: 1 }} />
            <span className="eyebrow">สัดส่วนของรายได้</span>
          </div>
          {s.ledger.map((l) => (
            <div key={l.label} style={{ display: "flex", alignItems: "center", gap: 14, padding: "9px 0", borderBottom: "1px solid var(--color-divider)" }}>
              <span style={{ width: 14, fontSize: 14, color: "var(--color-neutral-500)", textAlign: "center" }}>{l.sign}</span>
              <span style={{ fontSize: 14, fontWeight: l.bold ? 500 : undefined }}>{l.label}</span>
              <span style={{ flex: 1, height: 1, background: "var(--color-divider)", marginTop: 4 }} />
              <span className="num" style={{ width: 52, fontSize: 12.5, color: "var(--color-neutral-600)", textAlign: "right", whiteSpace: "nowrap" }}>
                {l.bold || l.first ? "" : pct((Math.abs(l.value) / Math.max(1, s.tRevenue)) * 100)}
              </span>
              <span className="num" style={{ width: 112, textAlign: "right", fontSize: 15, color: l.bold ? profitColor : "var(--color-text)", fontWeight: l.bold ? 500 : undefined }}>
                {baht(l.value)}
              </span>
            </div>
          ))}
          <p style={{ margin: "13px 0 0" }} className="small">ค่าถอดเสียงจ่ายตามที่ใช้จริง ไม่มีแพ็กเกจล่วงหน้า · รายได้เติมเงินนับตอนซื้อ ก่อนหักค่าธรรมเนียมชำระเงิน</p>
        </section>

        <section className="card" style={{ borderColor: "var(--color-accent)" }} aria-labelledby="be-title">
          <p id="be-title" className="card-title" style={{ marginBottom: 2 }}>จุดคุ้มทุน</p>
          <p className="card-sub" style={{ marginBottom: 14 }}>ที่ปริมาณการใช้งานเท่าทุกวันนี้</p>
          <p className="num" style={{ margin: 0, fontSize: 28, fontWeight: 300, lineHeight: 1.1, color: "var(--color-accent-700)" }}>
            {s.deficit > 0 ? b0(s.deficit) : "คุ้มทุนแล้ว"}
          </p>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--color-neutral-700)" }}>
            {s.deficit > 0 ? "รายได้ต่อเดือนที่ยังขาดอยู่" : "รายได้ครอบคลุมต้นทุนแล้ว"}
          </p>
          <div style={{ height: 9, background: "var(--color-neutral-200)", borderRadius: 2, margin: "14px 0 8px", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${bePct}%`, background: "var(--color-accent)" }} />
          </div>
          <p className="num" style={{ margin: 0, fontSize: 12.5, color: "var(--color-neutral-600)" }}>
            รายได้ {b0(s.mRevenue)} จากที่ต้องได้ {b0(s.monthlyCost)} ต่อเดือน
          </p>
          <div style={{ height: 1, background: "var(--color-divider)", margin: "15px 0 13px" }} />
          <p style={{ margin: "0 0 8px", fontSize: 12.5, color: "var(--color-neutral-700)" }}>ต้องได้ลูกค้าเพิ่มกี่คน</p>
          {byPlan.map((p) => (
            <div key={p.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 0", fontSize: 13 }}>
              <span style={{ width: 66 }}>{planLabel(p.key)}</span>
              <span className="rule-fill" />
              <span className="num" style={{ color: "var(--color-neutral-700)" }}>
                {baht(p.margin, 0)}/คน{s.planVarEstimated[p.key] ? " *" : ""}
              </span>
              <span className="num" style={{ width: 56, textAlign: "right", fontWeight: 500 }}>
                {s.deficit <= 0 ? "—" : p.need === null ? "ไม่คุ้ม" : `${p.need} คน`}
              </span>
            </div>
          ))}
          {byPlan.some((p) => s.planVarEstimated[p.key]) && (
            <p style={{ margin: "8px 0 0", fontSize: 11.5, color: "var(--color-neutral-600)" }}>* ยังไม่มีผู้ใช้ในแผนนี้ ใช้ต้นทุนต่อคนโดยประมาณ</p>
          )}
        </section>
      </div>

      <section className="card" style={{ marginTop: 20, paddingBottom: 16 }} aria-labelledby="daily-title">
        <div style={{ display: "flex", alignItems: "baseline", gap: 16, flexWrap: "wrap", marginBottom: 18 }}>
          <p id="daily-title" className="card-title">ต้นทุนรายวัน 30 วันล่าสุด</p>
          <div style={{ display: "flex", gap: 16, marginLeft: "auto", fontSize: 12.5, color: "var(--color-neutral-700)" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 11, height: 11, background: "var(--color-accent-500)" }} />ตามการใช้งาน</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 11, height: 11, background: "var(--color-neutral-400)" }} />ค่าคงที่ต่อวัน</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 16, height: 2, background: "var(--color-accent-800)" }} />รายได้ต่อวัน</span>
          </div>
        </div>
        <div style={{ position: "relative", height: H, display: "flex", alignItems: "flex-end", gap: 4, borderBottom: "1px solid var(--color-divider)" }} role="img" aria-label="กราฟต้นทุนรายวัน">
          {chart.days.map((d) => (
            <div
              key={d.date}
              className="chart-col"
              title={`${thaiDay(d.date)} · ใช้งาน ${baht(d.variable)} · คงที่ ${baht(d.fixed)}`}
              style={{ opacity: d.inPeriod ? 1 : 0.38 }}
            >
              <div style={{ height: Math.round((d.variable / maxDay) * H), background: "var(--color-accent-500)" }} />
              <div style={{ height: Math.round((d.fixed / maxDay) * H), background: "var(--color-neutral-400)" }} />
            </div>
          ))}
          <div style={{ position: "absolute", left: 0, right: 0, bottom: Math.min(H, Math.round((chart.revenuePerDay / maxDay) * H)), height: 2, background: "var(--color-accent-800)" }} />
        </div>
        <div className="num" style={{ display: "flex", justifyContent: "space-between", marginTop: 7, fontSize: 12, color: "var(--color-neutral-600)" }}>
          <span>{thaiDay(data.chart.from)}</span>
          <span>สูงสุด {baht(maxDay)}/วัน · รายได้ {baht(chart.revenuePerDay)}/วัน</span>
          <span>{thaiDay(data.chart.to)}</span>
        </div>
      </section>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))" }}>
        <section className="card" aria-labelledby="task-title">
          <p id="task-title" className="card-title" style={{ marginBottom: 16 }}>ต้นทุนแยกตามงาน</p>
          <TaskBars rows={taskRows} />
        </section>

        <section className="card" aria-labelledby="mom-title">
          <p id="mom-title" className="card-title" style={{ marginBottom: 2 }}>เทียบเดือนต่อเดือน</p>
          <p className="card-sub" style={{ marginBottom: 18 }}>ซ้าย รายได้ · ขวา ต้นทุน</p>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 26, height: 136, borderBottom: "1px solid var(--color-divider)", padding: "0 6px" }}>
            {months.map((m) => (
              <div key={m.key} style={{ flex: 1, display: "flex", alignItems: "flex-end", justifyContent: "center", gap: 5, height: "100%" }}>
                <div title={`รายได้ ${b0(m.revenue)}`} style={{ width: 24, height: Math.round((m.revenue / mMax) * 136), background: "var(--color-accent-800)" }} />
                <div title={`ต้นทุน ${b0(m.cost)}`} style={{ width: 24, height: Math.round((m.cost / mMax) * 136), background: "var(--color-neutral-400)" }} />
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 26, marginTop: 8, padding: "0 6px" }}>
            {months.map((m) => (
              <div key={m.key} style={{ flex: 1, textAlign: "center" }}>
                <p style={{ margin: 0, fontSize: 13 }}>{thaiMonth(m.key)}</p>
                <p className="num" style={{ margin: "2px 0 0", fontSize: 12.5, color: m.revenue - m.cost >= 0 ? OK : LOSS }}>{baht(m.revenue - m.cost, 0)}</p>
              </div>
            ))}
          </div>
          <p style={{ margin: "12px 0 0", fontSize: 11.5, color: "var(--color-neutral-600)" }}>
            ต้นทุนมาจากการใช้งานจริงบวกค่าคงที่ · รายได้เดือนก่อนๆ ประมาณจากสมาชิกที่ยังจ่ายอยู่ในตอนนี้
          </p>
        </section>
      </div>

      <section className="card" style={{ marginTop: 20 }} aria-labelledby="acc-title">
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
          <p id="acc-title" className="card-title">ประเมินเทียบใช้จริง</p>
          <p className="card-sub">ใช้จริง ÷ ที่ประเมินตอนเริ่มงาน · 1.00 = ตรง · เกินเพดาน = ใช้เกิน 1.2 เท่าของที่ประเมิน</p>
        </div>
        {!acc || acc.by_kind.length === 0 ? (
          <p className="small">ยังไม่มีงานที่ปิดแล้วในช่วงนี้</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table" style={{ fontFamily: "inherit", fontSize: 13, minWidth: 640 }}>
              <thead>
                <tr>
                  <th>งาน</th>
                  <th>ความละเอียด</th>
                  <th style={{ textAlign: "right" }}>งาน</th>
                  <th style={{ textAlign: "right" }}>ค่ากลาง</th>
                  <th style={{ textAlign: "right" }}>p90</th>
                  <th style={{ textAlign: "right" }}>เกินเพดาน</th>
                  <th style={{ textAlign: "right" }}>หยุดกลางคัน</th>
                </tr>
              </thead>
              <tbody>
                {acc.by_kind.map((r) => {
                  const v = accuracyVerdict(r);
                  return (
                    <tr key={`${r.kind}-${r.precision}`}>
                      <td>{RUN_KIND_LABEL[r.kind] ?? r.kind}</td>
                      <td>{r.precision}</td>
                      <td className="num" style={{ textAlign: "right" }}>{num(r.runs)}</td>
                      <td className="num" style={{ textAlign: "right", color: v === "under" || v === "over" ? LOSS : undefined }}>{ratioLabel(r.median_ratio)}</td>
                      <td className="num" style={{ textAlign: "right" }}>{ratioLabel(r.p90_ratio)}</td>
                      <td className="num" style={{ textAlign: "right", color: r.over_ceiling ? LOSS : undefined }}>{num(r.over_ceiling)}</td>
                      <td className="num" style={{ textAlign: "right" }}>{num(r.limit_stops)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {acc && acc.estimator_versions.length > 0 && (
          <p className="small" style={{ margin: "10px 0 0" }}>ตัวประเมินเวอร์ชัน {acc.estimator_versions.join(", ")} · รายคนดูได้ในหน้าผู้ใช้</p>
        )}
      </section>

      <section className="card" style={{ marginTop: 20, paddingBottom: 8 }} aria-labelledby="notes-title">
        <p id="notes-title" className="card-title" style={{ marginBottom: 12 }}>สิ่งที่ควรดู</p>
        {notes.map((n) => (
          <div key={n.title} style={{ display: "flex", gap: 14, padding: "12px 0", borderTop: "1px solid var(--color-divider)" }}>
            <span style={{ width: 5, flexShrink: 0, background: n.color, borderRadius: 1 }} />
            <div>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 500 }}>{n.title}</p>
              <p style={{ margin: "3px 0 0", fontSize: 13, color: "var(--color-neutral-700)" }}>{n.body}</p>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
