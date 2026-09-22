"use client";

import { useState } from "react";
import {
  RUN_KIND_LABEL, WALLET_ADJUST_MAX_SATANG, WINDOW_LABELS, accuracyVerdict, bahtToSatang, failedRunsVerdict,
  formatResetAt, outcomeLabel,
  ratioLabel,
} from "@/lib/billing";
import { baht, num } from "@/lib/format";
import { runRatio } from "@/lib/money";
import { planLabel } from "@/lib/plans";
import type { EstimateAccuracy, FailedRunsSummary, LimitFacts, RunFacts, WalletSummary, WindowKey } from "@/lib/types";
import { LOSS, NumberInput, OK } from "./ui";

/**
 * The billing half of the user drawer: limit windows with REAL rate-card
 * tokens (the admin sees them; the user sees only the percentage), the top-up
 * balance, and the last paid runs with estimate vs actual. Every write goes
 * through the dashboard's confirm dialog and is audited by the backend.
 */

const eyebrow: React.CSSProperties = {
  margin: "0 0 12px", fontSize: 12.5, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--color-neutral-600)",
};

function barColor(pct: number): string {
  return pct >= 100 ? LOSS : pct >= 80 ? "var(--color-accent-700)" : "var(--color-accent-500)";
}

export function LimitsSection({
  limits, onResetWindow, onResetAll,
}: {
  limits: LimitFacts | null;
  onResetWindow: (w: WindowKey) => void;
  onResetAll: () => void;
}) {
  return (
    <div style={{ padding: "20px 24px 0" }}>
      <p style={eyebrow}>ขีดจำกัดการใช้งาน</p>
      {!limits && <p className="small">กำลังโหลด…</p>}
      {limits?.unlimited && <p className="small">บัญชีนี้ไม่จำกัด (ผู้ดูแล/Enterprise) — ยังบันทึกการใช้และต้นทุนตามปกติ</p>}
      {limits && !limits.unlimited && (
        <>
          {limits.windows.map((w) => (
            <div key={w.key} style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 5, fontSize: 13 }}>
                <span style={{ fontWeight: 500 }}>{WINDOW_LABELS[w.key]}</span>
                <span className="num" style={{ color: w.used_pct >= 100 ? LOSS : "var(--color-neutral-700)" }}>{Math.round(w.used_pct)}%</span>
                <span style={{ flex: 1 }} />
                <button type="button" className="btn btn-secondary" onClick={() => onResetWindow(w.key)}
                  style={{ fontFamily: "inherit", fontSize: 12, minHeight: 28, padding: "2px 10px" }}>
                  รีเซ็ต
                </button>
              </div>
              <div className="bar-track" style={{ height: 6 }}>
                <div className="bar-fill" style={{ width: `${Math.min(100, w.used_pct)}%`, background: barColor(w.used_pct) }} />
              </div>
              <p className="num" style={{ margin: "5px 0 0", fontSize: 11.5, color: "var(--color-neutral-600)" }}>
                ใช้ {num(w.used_tokens)}{w.reserved_tokens ? ` + จอง ${num(w.reserved_tokens)}` : ""} จาก {num(w.limit_tokens)} โทเค็น ·{" "}
                {w.active ? `รีเซ็ต ${formatResetAt(w.resets_at)}` : formatResetAt(null)}
              </p>
            </div>
          ))}
          {(limits.pending_plan || limits.grace_until) && (
            <p className="small" style={{ margin: "0 0 10px" }}>
              {limits.pending_plan &&
                `เปลี่ยนเป็น ${planLabel(limits.pending_plan.plan)} ${limits.pending_plan.at ? formatResetAt(limits.pending_plan.at) : "เมื่อจบรอบบิล"}`}
              {limits.pending_plan && limits.grace_until && " · "}
              {limits.grace_until && `ชำระเงินไม่ผ่าน ใช้ต่อได้ถึง ${formatResetAt(limits.grace_until)} แล้วกลับเป็นแผนฟรี`}
            </p>
          )}
          <button type="button" className="btn btn-secondary" onClick={onResetAll} style={{ fontFamily: "inherit", fontSize: 12.5 }}>
            รีเซ็ตทุกช่วง
          </button>
          <p className="small" style={{ margin: "8px 0 0" }}>
            รีเซ็ตแล้วช่วงนั้นเริ่มนับใหม่เมื่อใช้ครั้งถัดไป · งานที่จองโควตาไว้ยังค้างอยู่ · โทเค็นที่ใช้ไปยังอยู่ในต้นทุน
          </p>
        </>
      )}
    </div>
  );
}

const ENTRY_LABEL: Record<string, string> = {
  purchase: "เติมเงิน", debit: "ใช้กับงาน", refund: "คืนเงิน", expire: "หมดอายุ", adjust: "ผู้ดูแลปรับ",
  reversal: "เติมเงินถูกยกเลิก (คืนเงิน/โต้แย้งการชำระ)",
};

export function WalletSection({
  wallet, onAdjust,
}: {
  wallet: WalletSummary | null;
  onAdjust: (satang: number, note: string) => void;
}) {
  const [amount, setAmount] = useState(0);
  const [note, setNote] = useState("");
  const satang = bahtToSatang(amount);
  const valid = satang !== 0 && Math.abs(satang) <= WALLET_ADJUST_MAX_SATANG && note.trim().length > 0;
  const next = wallet?.lots[0]?.expires_at ?? null;

  return (
    <div style={{ padding: "20px 24px 0" }}>
      <p style={eyebrow}>ยอดเงินเติม</p>
      {!wallet && <p className="small">กำลังโหลด…</p>}
      {wallet && (
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
            <p className="num" style={{ margin: 0, fontSize: 22, fontWeight: 300 }}>{baht(wallet.balance_satang / 100)}</p>
            <p className="num small" style={{ margin: 0 }}>
              {wallet.reserved_satang ? `จองไว้ ${baht(wallet.reserved_satang / 100)} · ` : ""}
              {next ? `ก้อนแรกหมดอายุ ${formatResetAt(next)}` : "ไม่มียอดคงเหลือ"}
            </p>
          </div>
          {wallet.history.length > 0 && (
            <div style={{ marginTop: 10 }}>
              {wallet.history.slice(0, 6).map((h, i) => (
                <div key={i} className="num" style={{ display: "flex", gap: 10, padding: "5px 0", borderTop: "1px solid var(--color-divider)", fontSize: 12.5 }}>
                  <span>{ENTRY_LABEL[h.kind] ?? h.kind}</span>
                  <span style={{ color: "var(--color-neutral-600)" }}>{h.created_at ? formatResetAt(h.created_at) : ""}</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ color: h.amount_satang < 0 ? LOSS : OK }}>{h.amount_satang > 0 ? "+" : ""}{baht(h.amount_satang / 100)}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
            <NumberInput label="ปรับยอดเงิน (บาท ติดลบ = หัก)" value={amount} step={1} min={-100_000} width={96} onChange={setAmount} />
            <input className="input" type="text" aria-label="เหตุผลที่ปรับยอด" maxLength={200} value={note} placeholder="เหตุผล (บันทึกในประวัติ)"
              onChange={(e) => setNote(e.target.value)} style={{ flex: 1, minWidth: 150, fontFamily: "inherit", fontSize: 13, minHeight: 32 }} />
            <button type="button" className="btn btn-secondary" disabled={!valid}
              onClick={() => { onAdjust(satang, note.trim()); setAmount(0); setNote(""); }}
              style={{ fontFamily: "inherit", fontSize: 12.5, minHeight: 32 }}>
              ปรับยอด
            </button>
          </div>
          <p className="small" style={{ margin: "6px 0 0" }}>ยอดบวกเพิ่มเป็นก้อนใหม่อายุ 12 เดือน · ยอดลบหักจากก้อนที่ใกล้หมดอายุก่อน ไม่ต่ำกว่าศูนย์</p>
        </>
      )}
    </div>
  );
}

export function RunsSection({
  runs, accuracy, failed, error,
}: {
  runs: RunFacts[] | null;
  accuracy: EstimateAccuracy | null;
  failed?: FailedRunsSummary | null;
  error: string | null;
}) {
  const verdict = accuracyVerdict(accuracy?.overall);
  const o = accuracy?.overall;
  const failedVerdict = failedRunsVerdict(failed);
  return (
    <div style={{ padding: "20px 24px 0" }}>
      <p style={{ ...eyebrow, marginBottom: 6 }}>ประเมินเทียบใช้จริง</p>
      {error && <p className="err" style={{ fontSize: 12.5 }}>{error}</p>}
      {!runs && !error && <p className="small">กำลังโหลด…</p>}
      {o && o.runs > 0 && (
        <p className="num small" style={{ margin: "0 0 10px", color: verdict === "good" ? undefined : LOSS }}>
          90 วัน · {o.runs} งาน · ใช้จริง/ประเมิน กลาง {ratioLabel(o.median_ratio)} · p90 {ratioLabel(o.p90_ratio)} · เกินเพดาน {o.over_ceiling} · หยุดกลางคัน {o.limit_stops}
        </p>
      )}
      {failed && failedVerdict !== "none" && (
        <p className="num small" style={{ margin: "0 0 10px", color: failedVerdict === "watch" ? LOSS : undefined }}>
          30 วัน · ผิดพลาดฝั่งระบบ {failed.runs} งาน · คืนโควตา {failed.refunded_runs} ({num(failed.refunded_tokens)} โทเค็น)
          {failed.charged_after_cap_runs > 0 && ` · เกินสิทธิ์คืนแล้วคิดตามใช้ ${failed.charged_after_cap_runs}`} · ต้นทุนเรา {baht(failed.cost_thb)}
          {failedVerdict === "watch" && " · ควรตรวจสอบ"}
        </p>
      )}
      {runs && runs.length === 0 && <p className="small">ยังไม่มีงานที่คิดโควตา</p>}
      {runs && runs.length > 0 && (
        <div style={{ maxHeight: 320, overflowY: "auto" }}>
          <table className="table" style={{ fontFamily: "inherit", fontSize: 12 }}>
            <thead>
              <tr>
                <th>งาน</th>
                <th style={{ textAlign: "right" }}>ประเมิน</th>
                <th style={{ textAlign: "right" }}>ใช้จริง</th>
                <th style={{ textAlign: "right" }}>คิด</th>
                <th style={{ textAlign: "right" }}>ต้นทุน</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const ratio = runRatio(r);
                const over = r.ceiling_tokens > 0 && r.actual_tokens > r.ceiling_tokens;
                return (
                  <tr key={r.id}>
                    <td>
                      {RUN_KIND_LABEL[r.kind] ?? r.kind}
                      <span style={{ display: "block", fontSize: 11, color: r.outcome && r.outcome !== "ok" ? LOSS : "var(--color-neutral-600)" }}>
                        {r.created_at ? formatResetAt(r.created_at) : ""} · {r.precision ?? "standard"} ·{" "}
                        {outcomeLabel(r.outcome, r.status)}
                      </span>
                    </td>
                    <td className="num" style={{ textAlign: "right" }}>{num(r.estimate_tokens)}</td>
                    <td className="num" style={{ textAlign: "right", color: over ? LOSS : undefined }}>
                      {num(r.actual_tokens)}
                      <span style={{ display: "block", fontSize: 11, color: "var(--color-neutral-600)" }}>{ratioLabel(ratio)}</span>
                    </td>
                    <td className="num" style={{ textAlign: "right" }}>
                      {r.unlimited ? "ไม่จำกัด" : r.charged_tokens === null ? "—" : num(r.charged_tokens)}
                      {!!r.charged_wallet_satang && (
                        <span style={{ display: "block", fontSize: 11, color: "var(--color-neutral-600)" }}>+ {baht(r.charged_wallet_satang / 100)}</span>
                      )}
                    </td>
                    <td className="num" style={{ textAlign: "right" }}>{baht(r.cost_thb)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
