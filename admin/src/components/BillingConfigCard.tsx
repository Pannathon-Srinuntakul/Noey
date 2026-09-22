"use client";

import { useState } from "react";
import { saveBillingConfigAction, type ActionResult } from "@/app/actions";
import { WINDOW_LABELS, validPer1M } from "@/lib/billing";
import { b0, baht, num } from "@/lib/format";
import type { Summary } from "@/lib/money";
import { PLAN_LIMITS, PRICED_KEYS, fiveHourLimit, planLabel, weeklyLimit } from "@/lib/plans";
import type { BillingConfigView, DashboardData } from "@/lib/types";
import { LOSS, NumberInput, OK, type ConfirmSpec } from "./ui";

/**
 * The token economics: the reference cost and sell price per 1M (editable —
 * they only change how this dashboard computes margin), the prices users are
 * actually charged (fixed in code, read-only here), the rate card, each
 * plan's limits, and the top-up (extra usage) money.
 */
export function BillingConfigCard({
  s, data, handle, ask, onSaved,
}: {
  s: Summary;
  data: DashboardData;
  handle: <T>(r: ActionResult<T>) => r is { ok: true; data: T };
  ask: (spec: ConfirmSpec) => void;
  onSaved: (cfg: BillingConfigView) => void;
}) {
  const bc = data.billing_config;
  const rc = bc?.rate_card ?? data.rate_card;
  const saved = { ref: bc?.reference_thb_per_1m ?? rc?.reference_thb_per_1m ?? 50, sell: bc?.sell_thb_per_1m ?? rc?.sell_thb_per_1m ?? 250 };
  const [draft, setDraft] = useState<{ ref: number; sell: number } | null>(null);
  const d = draft ?? saved;
  const dirty = draft !== null && (draft.ref !== saved.ref || draft.sell !== saved.sell);
  const valid = validPer1M(d.ref) && validPer1M(d.sell);
  const charged = bc?.charged_sell_thb_per_1m ?? rc?.sell_thb_per_1m ?? 250;
  const topupPer1M = bc?.topup_thb_per_1m ?? rc?.topup_thb_per_1m ?? 350;

  function save() {
    const lines: string[] = [];
    if (d.ref !== saved.ref) lines.push(`ต้นทุนอ้างอิง ฿${saved.ref} → ฿${d.ref} ต่อ 1 ล้านโทเค็น`);
    if (d.sell !== saved.sell) lines.push(`ราคาขายที่ใช้คิดกำไร ฿${saved.sell} → ฿${d.sell} ต่อ 1 ล้านโทเค็น`);
    lines.push(`ผู้ใช้ยังถูกคิด ฿${charged} ต่อ 1 ล้านโทเค็นตามเดิม — ค่านี้เปลี่ยนแค่ตัวเลขในหน้านี้`);
    ask({
      title: "บันทึกราคาต่อโทเค็น", body: "บันทึกในประวัติผู้ดูแล", lines, okLabel: "บันทึก",
      ok: async () => {
        const r = await saveBillingConfigAction(d.ref, d.sell);
        if (!handle(r)) return;
        setDraft(null);
        onSaved(r.data);
      },
    });
  }

  const llm = rc ? Object.entries(rc.llm) : [];

  return (
    <section className="card" style={{ marginTop: 20 }} aria-labelledby="tok-title">
      <p id="tok-title" className="card-title" style={{ marginBottom: 2 }}>ราคาต่อโทเค็นและขีดจำกัด</p>
      <p className="card-sub" style={{ marginBottom: 16 }}>ผู้ใช้เห็นเป็นเปอร์เซ็นต์และเวลารีเซ็ตเท่านั้น ไม่เห็นจำนวนโทเค็น · เติมเงินเห็นเป็นยอดบาท</p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 1, background: "var(--color-divider)", border: "1px solid var(--color-divider)" }}>
        <div style={{ background: "var(--color-bg)", padding: "14px 16px" }}>
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--color-neutral-700)" }}>ต้นทุนอ้างอิง / 1M</p>
          <NumberInput label="ต้นทุนอ้างอิงต่อ 1 ล้านโทเค็น บาท" value={d.ref} step={1} width={96} onChange={(v) => setDraft({ ...d, ref: v })} style={{ marginTop: 6 }} />
          <p style={{ margin: "5px 0 0", fontSize: 12, color: "var(--color-neutral-600)" }}>
            จริงตอนนี้ {s.costPer1M === null ? "—" : baht(s.costPer1M)}
          </p>
        </div>
        <div style={{ background: "var(--color-bg)", padding: "14px 16px" }}>
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--color-neutral-700)" }}>ราคาขาย / 1M (ใช้คิดกำไร)</p>
          <NumberInput label="ราคาขายต่อ 1 ล้านโทเค็น บาท" value={d.sell} step={1} width={96} onChange={(v) => setDraft({ ...d, sell: v })} style={{ marginTop: 6 }} />
          <p style={{ margin: "5px 0 0", fontSize: 12, color: s.marginPer1M !== null && s.marginPer1M < 0 ? LOSS : "var(--color-neutral-600)" }}>
            กำไร {s.marginPer1M === null ? "—" : baht(s.marginPer1M)} ต่อ 1M
          </p>
        </div>
        <div style={{ background: "var(--color-bg)", padding: "14px 16px" }}>
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--color-neutral-700)" }}>ผู้ใช้ถูกคิดจริง / 1M</p>
          <p className="num" style={{ margin: "6px 0 0", fontSize: 24, fontWeight: 300, lineHeight: 1.1 }}>{b0(charged)}</p>
          <p style={{ margin: "5px 0 0", fontSize: 12, color: "var(--color-neutral-600)" }}>ทุกแผน · กำหนดในโค้ด</p>
        </div>
        <div style={{ background: "var(--color-bg)", padding: "14px 16px" }}>
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--color-neutral-700)" }}>เติมเงิน / 1M</p>
          <p className="num" style={{ margin: "6px 0 0", fontSize: 24, fontWeight: 300, lineHeight: 1.1 }}>{b0(topupPer1M)}</p>
          <p style={{ margin: "5px 0 0", fontSize: 12, color: "var(--color-neutral-600)" }}>ใช้หลังโควตาแผนหมด · อายุ 12 เดือน</p>
        </div>
      </div>
      {dirty && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
          {!valid && <span className="err" style={{ fontSize: 12 }}>ต้องมากกว่า 0 และไม่เกิน ฿10,000</span>}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-secondary" onClick={() => setDraft(null)} style={{ fontFamily: "inherit", fontSize: 12.5 }}>ยกเลิก</button>
          <button type="button" className="btn btn-primary" disabled={!valid} onClick={save} style={{ fontFamily: "inherit", fontSize: 12.5 }}>บันทึก</button>
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))" }}>
        <div>
          <p className="eyebrow" style={{ margin: "0 0 8px" }}>ขีดจำกัดต่อแผน (โทเค็น)</p>
          <div style={{ overflowX: "auto" }}>
            <table className="table" style={{ fontFamily: "inherit", fontSize: 12.5 }}>
              <thead>
                <tr>
                  <th>แผน</th>
                  <th style={{ textAlign: "right" }}>ต่อเดือน</th>
                  <th style={{ textAlign: "right" }}>ช่วงที่บังคับ</th>
                  <th style={{ textAlign: "right" }}>งานพร้อมกัน</th>
                  <th style={{ textAlign: "right" }}>พื้นที่</th>
                </tr>
              </thead>
              <tbody>
                {PRICED_KEYS.map((k) => {
                  const l = PLAN_LIMITS[k];
                  const shown = l.windows.map((w) =>
                    `${WINDOW_LABELS[w]} ${num(w === "monthly" ? l.monthly : w === "weekly" ? weeklyLimit(l.monthly) : fiveHourLimit(l.monthly))}`);
                  return (
                    <tr key={k}>
                      <td>{planLabel(k)}</td>
                      <td className="num" style={{ textAlign: "right" }}>{num(l.monthly)}</td>
                      <td className="num" style={{ textAlign: "right", fontSize: 11.5 }}>
                        {shown.map((x) => <span key={x} style={{ display: "block" }}>{x}</span>)}
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>{l.concurrency}</td>
                      <td className="num" style={{ textAlign: "right" }}>{l.storageGb} GB</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="small" style={{ margin: "8px 0 0" }}>Weekly = ต่อเดือน ÷ 4.33 · 5-hour = 40% ของ Weekly · ช่วงเริ่มนับเมื่อใช้ครั้งแรก · บัญชีผู้ดูแลและ Enterprise ไม่จำกัด</p>
        </div>

        <div>
          <p className="eyebrow" style={{ margin: "0 0 8px" }}>อัตราแปลงเป็นโทเค็น {rc ? `(${rc.version})` : ""}</p>
          <table className="table" style={{ fontFamily: "inherit", fontSize: 12.5 }}>
            <thead>
              <tr>
                <th>งาน</th>
                <th style={{ textAlign: "right" }}>เข้า</th>
                <th style={{ textAlign: "right" }}>ออก</th>
              </tr>
            </thead>
            <tbody>
              {llm.map(([fam, r]) => (
                <tr key={fam}>
                  <td>
                    AI {fam === "flash" ? "รุ่นเร็ว" : fam === "pro" ? "รุ่นแม่นยำ" : fam}
                    {r.long_threshold && (
                      <span style={{ display: "block", fontSize: 11, color: "var(--color-neutral-600)" }}>
                        พรอมต์เกิน {num(r.long_threshold)}: ×{r.input_long} / ×{r.output_long}
                      </span>
                    )}
                  </td>
                  <td className="num" style={{ textAlign: "right" }}>×{r.input}</td>
                  <td className="num" style={{ textAlign: "right" }}>×{r.output}</td>
                </tr>
              ))}
              {rc && (
                <tr>
                  <td>ถอดเสียง</td>
                  <td className="num" colSpan={2} style={{ textAlign: "right" }}>{rc.stt_per_sec} ต่อวินาทีเสียง</td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="small" style={{ margin: "8px 0 0" }}>
            อินพุตที่แคชไว้คิด {rc ? Math.round(rc.cached_ratio * 100) : 10}% · ตารางนี้ตายตัว เปลี่ยนได้เฉพาะออกเวอร์ชันใหม่ในโค้ด ·
            ราคาผู้ให้บริการหรือค่าเงินเปลี่ยนแค่กำไรของเรา ไม่ทำให้โควตาผู้ใช้หมดเร็วขึ้น
          </p>

          <p className="eyebrow" style={{ margin: "18px 0 8px" }}>เติมเงินในช่วงนี้</p>
          {[
            { label: "รายได้จากเติมเงิน", value: baht(s.tTopup), color: s.tTopup > 0 ? OK : undefined },
            { label: "ผู้ที่เติมเงิน", value: `${num(s.topupBuyers)} คน` },
            { label: "ใช้จากยอดเติม", value: baht(s.tWalletSpent) },
            { label: "ยอดคงเหลือทุกบัญชี (ยังต้องให้บริการ)", value: baht(s.tWalletBalance) },
          ].map((r) => (
            <div key={r.label} style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "4px 0", fontSize: 13 }}>
              <span style={{ color: "var(--color-neutral-700)" }}>{r.label}</span>
              <span className="rule-fill" />
              <span className="num" style={{ color: r.color }}>{r.value}</span>
            </div>
          ))}
          <p className="small" style={{ margin: "6px 0 0" }}>ยอดก่อนหักค่าธรรมเนียมชำระเงิน (PromptPay 1.65% · บัตร 3.65% + ฿10) · ไม่รวมยอดที่ผู้ดูแลเพิ่มให้</p>
        </div>
      </div>
    </section>
  );
}
