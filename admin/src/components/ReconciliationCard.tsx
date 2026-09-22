"use client";

import { useEffect, useState, useTransition } from "react";
import { getReconciliationAction, saveInvoiceAction, type ActionResult } from "@/app/actions";
import { monthOf, validMonth, VENDOR_LABELS } from "@/lib/billing";
import { baht, num, pct } from "@/lib/format";
import type { Reconciliation, VendorReconciliation } from "@/lib/types";
import { LOSS, NumberInput, OK } from "./ui";

/**
 * Recorded vendor cost vs what each vendor actually invoiced, per calendar
 * month (UTC). A gap above the backend's threshold means requests are going
 * unrecorded, or the price table / FX is off.
 */
export function ReconciliationCard({
  today, handle,
}: {
  today: string;
  handle: <T>(r: ActionResult<T>) => r is { ok: true; data: T };
}) {
  const [month, setMonth] = useState(monthOf(today));
  const [data, setData] = useState<Reconciliation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, number>>({});
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!validMonth(month)) return;
    let alive = true;
    void getReconciliationAction(month).then((r) => {
      if (!alive) return;
      if (r.ok) {
        setData(r.data);
        setError(null);
      } else setError(r.error);
      setDrafts({});
    });
    return () => {
      alive = false;
    };
  }, [month]);

  function save(v: VendorReconciliation) {
    const amount = drafts[v.vendor];
    if (amount === undefined) return;
    start(async () => {
      const r = await saveInvoiceAction(month, v.vendor, amount, v.invoice_note);
      if (!handle(r)) return;
      setData(r.data);
      setDrafts((d) => {
        const next = { ...d };
        delete next[v.vendor];
        return next;
      });
    });
  }

  return (
    <section className="card" style={{ marginTop: 20 }} aria-labelledby="recon-title">
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <p id="recon-title" className="card-title">กระทบยอดกับใบแจ้งหนี้</p>
        <p className="card-sub">ต้นทุนที่บันทึกไว้ เทียบกับยอดที่ผู้ให้บริการเรียกเก็บจริง</p>
        <span style={{ flex: 1 }} />
        <input className="input" type="month" aria-label="เดือน" value={month} max={monthOf(today)}
          onChange={(e) => setMonth(e.target.value)} style={{ fontFamily: "inherit", fontSize: 13, minHeight: 32 }} />
      </div>
      {error && <p role="alert" className="err" style={{ margin: "0 0 10px", fontSize: 13 }}>{error}</p>}
      <div style={{ overflowX: "auto" }}>
        <table className="table" style={{ fontFamily: "inherit", fontSize: 13, minWidth: 640 }}>
          <thead>
            <tr>
              <th>งาน</th>
              <th style={{ textAlign: "right" }}>บันทึกไว้</th>
              <th style={{ textAlign: "right" }}>ผูกกับงานผู้ใช้</th>
              <th style={{ textAlign: "right" }}>ใบแจ้งหนี้ (บาท)</th>
              <th style={{ textAlign: "right" }}>ส่วนต่าง</th>
            </tr>
          </thead>
          <tbody>
            {(data?.vendors ?? []).map((v) => (
              <tr key={v.vendor}>
                <td>
                  {VENDOR_LABELS[v.vendor]}
                  <span style={{ display: "block", fontSize: 11.5, color: "var(--color-neutral-600)" }}>
                    {num(v.rows)} รายการ{v.unpriced_rows ? ` · ไม่มีราคา ${num(v.unpriced_rows)}` : ""}
                  </span>
                </td>
                <td className="num" style={{ textAlign: "right" }}>{baht(v.recorded_thb)}</td>
                <td className="num" style={{ textAlign: "right" }}>
                  {baht(v.attributed_thb)}
                  <span style={{ display: "block", fontSize: 11.5, color: "var(--color-neutral-600)" }}>อื่นๆ {baht(v.unattributed_thb)}</span>
                </td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  <NumberInput label={`ยอดใบแจ้งหนี้ ${VENDOR_LABELS[v.vendor]}`} value={drafts[v.vendor] ?? v.invoice_thb ?? 0}
                    step={1} width={104} onChange={(n) => setDrafts((d) => ({ ...d, [v.vendor]: n }))} />
                  <button type="button" className="btn btn-secondary" disabled={pending || drafts[v.vendor] === undefined}
                    onClick={() => save(v)} style={{ fontFamily: "inherit", fontSize: 12, minHeight: 30, padding: "4px 10px", marginLeft: 6 }}>
                    บันทึก
                  </button>
                </td>
                <td className="num" style={{ textAlign: "right", color: v.gap_pct === null ? undefined : v.warn ? LOSS : OK }}>
                  {v.gap_pct === null ? "—" : pct(v.gap_pct)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ margin: "12px 0 0" }} className="small">
        ส่วนต่างเกิน {data ? pct(data.warn_pct) : "5%"} แปลว่ามีคำขอที่ไม่ได้บันทึก หรือราคา/อัตราแลกเปลี่ยนในหน้านี้ไม่ตรง ·
        สคริปต์ทดสอบของทีมไม่ถูกบันทึก จึงอยู่ในส่วนต่างเสมอ
      </p>
    </section>
  );
}
