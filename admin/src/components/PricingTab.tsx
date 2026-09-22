"use client";

import { b0, baht, num, pct } from "@/lib/format";
import { forecast, planRow, type Ctx, type ForecastIn, type Summary } from "@/lib/money";
import { PLAN_QUOTA, PRICED_KEYS, planLabel } from "@/lib/plans";
import type { ActionResult } from "@/app/actions";
import type { BillingConfigView, DashboardData } from "@/lib/types";
import { BillingConfigCard } from "./BillingConfigCard";
import { LOSS, NumberInput, OK, type ConfirmSpec } from "./ui";

export function PricingTab({
  ctx, s, data, draft, setDraft, dirty, onSave, onCancel, fc, setFc, fcDefaults, handle, ask, onBillingSaved,
}: {
  ctx: Ctx;
  s: Summary;
  data: DashboardData;
  draft: Record<string, number>;
  setDraft: (p: Record<string, number>) => void;
  dirty: boolean;
  onSave: () => void;
  onCancel: () => void;
  fc: ForecastIn;
  setFc: (f: ForecastIn | null) => void;
  fcDefaults: ForecastIn;
  handle: <T>(r: ActionResult<T>) => r is { ok: true; data: T };
  ask: (spec: ConfirmSpec) => void;
  onBillingSaved: (cfg: BillingConfigView) => void;
}) {
  const stripe = data.prices.source === "stripe";
  const out = forecast(ctx, s, fc);
  const fcCards = [
    { label: "ผู้ใช้ทั้งหมด", value: num(out.users), sub: `จ่ายเงิน ${num(out.payingUsers)} คน` },
    { label: "รายได้ต่อเดือน", value: b0(out.revenue), sub: ctx.cfg.vat_included ? "หัก VAT แล้ว" : "ไม่มี VAT" },
    { label: "ต้นทุนตามการใช้งาน", value: b0(out.variable), sub: "โทเค็น + ถอดเสียง" },
    { label: "ต้นทุนคงที่", value: b0(out.fixed), sub: fc.fixed === null ? "จากต้นทุนคงที่ + บัญชีผู้ดูแล" : "กรอกเอง" },
    {
      label: out.profit >= 0 ? "กำไรต่อเดือน" : "ขาดทุนต่อเดือน", value: b0(out.profit), color: out.profit >= 0 ? OK : LOSS,
      sub: out.revenue > 0 ? `${pct((out.profit / out.revenue) * 100)} ของรายได้` : "—",
    },
  ];
  const fcNote =
    out.profit >= 0 ? `กำไร ${b0(out.profit)}/เดือน` : `ยังขาดอีก Starter ${out.needStarter} คน หรือ Pro ${out.needPro} คน`;

  const set = (field: "counts" | "price" | "cost", k: string, v: number) =>
    setFc({ ...fc, [field]: { ...fc[field], [k]: Math.max(0, v) } });

  return (
    <div>
      <section className="card" aria-labelledby="prices-title">
        <p id="prices-title" className="card-title" style={{ marginBottom: 2 }}>ราคาต่อแผน</p>
        <p className="card-sub" style={{ marginBottom: 14 }}>แก้ราคาแล้วกดบันทึก · คอลัมน์ท้ายคือจำนวนคลิปที่ทำให้แผนนั้นขาดทุน</p>
        <div style={{ overflowX: "auto" }}>
          <table className="table" style={{ fontFamily: "inherit", fontSize: 13.5, minWidth: 860 }}>
            <thead>
              <tr>
                <th>แผน</th>
                <th>เพดานฟุตเทจ</th>
                <th style={{ textAlign: "right" }}>ราคา/เดือน</th>
                <th style={{ textAlign: "right" }}>ผู้ใช้</th>
                <th style={{ textAlign: "right" }}>รายได้</th>
                <th style={{ textAlign: "right" }}>ต้นทุนเฉลี่ย/คน</th>
                <th style={{ textAlign: "right" }}>กำไร/คน</th>
                <th style={{ textAlign: "right" }}>อัตรากำไร</th>
                <th style={{ textAlign: "right" }}>ขาดทุนเมื่อเกิน</th>
              </tr>
            </thead>
            <tbody>
              {PRICED_KEYS.map((k) => {
                const row = planRow(ctx, s, k, Number(draft[k] ?? ctx.prices[k] ?? 0));
                const color = row.price === 0 ? LOSS : row.perUser >= 0 ? OK : LOSS;
                return (
                  <tr key={k}>
                    <td>
                      <span style={{ fontWeight: 500 }}>{planLabel(k)}</span>
                      <span style={{ display: "block", fontSize: 11.5, color: "var(--color-neutral-600)" }}>
                        {k === "free" ? "ไม่มีราคาขาย" : stripe ? `Stripe · noey_${k}_monthly` : `ยังไม่เชื่อม Stripe · noey_${k}_monthly`}
                      </span>
                    </td>
                    <td style={{ color: "var(--color-neutral-700)", fontSize: 13 }}>{PLAN_QUOTA[k]}</td>
                    <td style={{ textAlign: "right" }}>
                      <NumberInput label={`ราคา ${planLabel(k)} ต่อเดือน`} value={Number(draft[k] ?? 0)} width={96} min={k === "free" ? 0 : 1}
                        disabled={k === "free"} onChange={(v) => setDraft({ ...draft, [k]: Math.round(v) })} />
                    </td>
                    <td className="num" style={{ textAlign: "right" }}>{row.users}</td>
                    <td className="num" style={{ textAlign: "right" }}>{b0(row.revenue)}</td>
                    <td className="num" style={{ textAlign: "right" }}>{baht(row.avgCost)}{s.planVarEstimated[k] ? " *" : ""}</td>
                    <td className="num" style={{ textAlign: "right", color, fontWeight: 500 }}>{baht(row.perUser)}</td>
                    <td className="num" style={{ textAlign: "right", color }}>{row.margin === null ? "—" : pct(row.margin)}</td>
                    <td className="num" style={{ textAlign: "right" }}>{row.breakClips === null ? "ขาดทุนตั้งแต่คลิปแรก" : `${row.breakClips} คลิป/เดือน`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {dirty && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--color-divider)" }}>
            <span className="small">ยังไม่ได้บันทึกราคาใหม่</span>
            <span style={{ flex: 1 }} />
            <button type="button" className="btn btn-secondary" onClick={onCancel} style={{ fontFamily: "inherit", fontSize: 13 }}>ยกเลิก</button>
            <button type="button" className="btn btn-primary" onClick={onSave} style={{ fontFamily: "inherit", fontSize: 13 }}>บันทึกราคา</button>
          </div>
        )}
        <p style={{ margin: "13px 0 0" }} className="small">
          {stripe
            ? "ราคาเก็บที่ Stripe — บันทึกแล้วจะสร้างราคาใหม่ให้แผนนั้น ผู้ที่สมัครอยู่แล้วจ่ายราคาเดิมจนกว่าจะเปลี่ยนแผน · Enterprise ผู้ดูแลตั้งให้เท่านั้น"
            : "ยังไม่ได้เชื่อม Stripe — ราคาที่บันทึกแสดงบนหน้าราคาของเว็บทันที · Enterprise ผู้ดูแลตั้งให้เท่านั้น"}
          {Object.values(s.planVarEstimated).some(Boolean) && " · * ยังไม่มีผู้ใช้ในแผนนี้ ใช้ต้นทุนต่อคนโดยประมาณ"}
        </p>
      </section>

      <BillingConfigCard s={s} data={data} handle={handle} ask={ask} onSaved={onBillingSaved} />

      <section className="card" style={{ marginTop: 20 }} aria-labelledby="fc-title">
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 16 }}>
          <p id="fc-title" className="card-title">คาดการณ์</p>
          <p className="card-sub">กรอกได้ทุกช่อง</p>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-secondary" onClick={() => setFc(null)} style={{ fontFamily: "inherit", fontSize: 13 }}>คืนค่าตามข้อมูลจริง</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(178px, 1fr))", gap: 14 }}>
          {PRICED_KEYS.map((k) => (
            <div key={k} style={{ border: "1px solid var(--color-divider)", borderRadius: 4, padding: "13px 14px" }}>
              <p style={{ margin: "0 0 10px", fontSize: 13.5, fontWeight: 500 }}>{planLabel(k)}</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {([["counts", "คน"], ["price", "ราคา"], ["cost", "ต้นทุน"]] as const).map(([field, lbl]) => (
                  <label key={field} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--color-neutral-700)" }}>
                    <span style={{ width: 42 }}>{lbl}</span>
                    <NumberInput label={`${planLabel(k)} ${lbl}`} value={fc[field][k] ?? fcDefaults[field][k] ?? 0} onChange={(v) => set(field, k, v)} />
                  </label>
                ))}
              </div>
            </div>
          ))}
          <div style={{ border: "1px solid var(--color-divider)", borderRadius: 4, padding: "13px 14px" }}>
            <p style={{ margin: "0 0 10px", fontSize: 13.5, fontWeight: 500 }}>ต้นทุนคงที่</p>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--color-neutral-700)" }}>
              <span style={{ width: 42 }}>บาท</span>
              <NumberInput label="ต้นทุนคงที่ต่อเดือน" value={Math.round(out.fixed)} onChange={(v) => setFc({ ...fc, fixed: Math.max(0, v) })} />
            </label>
            <p style={{ margin: "9px 0 0", fontSize: 11.5, color: "var(--color-neutral-600)" }}>เซิร์ฟเวอร์ ค่าบริการรายเดือน และบัญชีผู้ดูแล</p>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(168px, 1fr))", border: "1px solid var(--color-divider)", borderRadius: 4, marginTop: 18 }}>
          {fcCards.map((o) => (
            <div key={o.label} style={{ padding: "15px 18px", borderRight: "1px solid var(--color-divider)" }}>
              <p style={{ margin: 0, fontSize: 12.5, color: "var(--color-neutral-700)" }}>{o.label}</p>
              <p className="num" style={{ margin: "5px 0 0", fontSize: 26, fontWeight: 300, lineHeight: 1.1, color: o.color ?? "var(--color-text)" }}>{o.value}</p>
              <p style={{ margin: "5px 0 0", fontSize: 12, color: "var(--color-neutral-600)" }}>{o.sub}</p>
            </div>
          ))}
        </div>
        <p style={{ margin: "13px 0 0" }} className="small">{fcNote}</p>
      </section>
    </div>
  );
}
