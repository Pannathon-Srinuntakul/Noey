"use client";

import { useEffect, useState } from "react";
import { getCircuitBreakerAction, saveCircuitBreakerAction, type ActionResult } from "@/app/actions";
import { validBreaker } from "@/lib/billing";
import { baht, pct } from "@/lib/format";
import type { BreakerSettings, CircuitBreaker } from "@/lib/types";
import { LOSS, NumberInput, OK, type ConfirmSpec } from "./ui";

/**
 * The system-wide daily AI spend cap (UTC day, every account's recorded
 * vendor cost). At the cap new jobs are refused; at cap × hard-stop ratio
 * calls already running stop too. Admin accounts are never blocked. Saved
 * on its own through the confirm dialog; the backend audits it.
 */
export function BreakerCard({
  initial, handle, ask, done,
}: {
  initial: CircuitBreaker | undefined;
  handle: <T>(r: ActionResult<T>) => r is { ok: true; data: T };
  ask: (spec: ConfirmSpec) => void;
  done: (message: string) => void;
}) {
  const [cb, setCb] = useState<CircuitBreaker | null>(initial ?? null);
  const [draft, setDraft] = useState<BreakerSettings | null>(null);

  useEffect(() => {
    let alive = true;
    void getCircuitBreakerAction().then((r) => {
      if (alive && r.ok) setCb(r.data);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!cb) {
    return (
      <section className="card" aria-labelledby="cb-title">
        <p id="cb-title" className="card-title">เพดานค่าใช้จ่ายรายวัน</p>
        <p className="small">กำลังโหลด…</p>
      </section>
    );
  }

  const saved: BreakerSettings = {
    enabled: cb.enabled, daily_cap_thb: cb.daily_cap_thb, hard_stop_ratio: cb.hard_stop_ratio, alert_email: cb.alert_email,
  };
  const d = draft ?? saved;
  const set = (patch: Partial<BreakerSettings>) => setDraft({ ...d, ...patch });
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);
  const valid = validBreaker({ ...d, alert_email: d.alert_email?.trim() || null });
  const usedPct = cb.daily_cap_thb > 0 ? (cb.spend_today_thb / cb.daily_cap_thb) * 100 : 0;
  const state = !cb.enabled
    ? { label: "ปิดอยู่ — ไม่มีเพดาน", color: LOSS }
    : cb.hard_stopped
      ? { label: "หยุดทุกงานแล้ว (เกินเพดาน × ตัวคูณ)", color: LOSS }
      : cb.tripped
        ? { label: "ไม่รับงานใหม่แล้ววันนี้", color: LOSS }
        : { label: "ปกติ", color: OK };

  function save() {
    const next: BreakerSettings = { ...d, alert_email: d.alert_email?.trim() || null };
    const lines: string[] = [];
    if (next.enabled !== saved.enabled) lines.push(next.enabled ? "เปิดเพดาน" : "ปิดเพดาน — ค่าใช้จ่ายรายวันไม่มีขีดจำกัด");
    if (next.daily_cap_thb !== saved.daily_cap_thb) lines.push(`เพดานต่อวัน ${baht(saved.daily_cap_thb, 0)} → ${baht(next.daily_cap_thb, 0)}`);
    if (next.hard_stop_ratio !== saved.hard_stop_ratio) lines.push(`หยุดงานที่กำลังทำที่ ×${saved.hard_stop_ratio} → ×${next.hard_stop_ratio}`);
    if (next.alert_email !== saved.alert_email) lines.push(`อีเมลแจ้งเตือน ${saved.alert_email ?? "ผู้ดูแลทุกคน"} → ${next.alert_email ?? "ผู้ดูแลทุกคน"}`);
    ask({
      title: "บันทึกเพดานค่าใช้จ่าย", body: "มีผลกับทุกบัญชียกเว้นผู้ดูแล · บันทึกในประวัติผู้ดูแล",
      lines: lines.length ? lines : ["ไม่มีการเปลี่ยนแปลง"], okLabel: "บันทึก", danger: !next.enabled,
      ok: async () => {
        const r = await saveCircuitBreakerAction(next);
        if (!handle(r)) return;
        setCb(r.data);
        setDraft(null);
        done("บันทึกเพดานค่าใช้จ่ายแล้ว");
      },
    });
  }

  return (
    <section className="card" aria-labelledby="cb-title">
      <p id="cb-title" className="card-title" style={{ marginBottom: 2 }}>เพดานค่าใช้จ่ายรายวัน</p>
      <p className="card-sub" style={{ marginBottom: 14 }}>ต้นทุน AI รวมทุกบัญชีต่อวัน (ตามเวลา UTC) · ถึงเพดานแล้วไม่รับงานใหม่ · บัญชีผู้ดูแลไม่ถูกหยุด</p>
      <p className="num" style={{ margin: 0, fontSize: 28, fontWeight: 300, lineHeight: 1.1 }}>
        {baht(cb.spend_today_thb)}
        <span style={{ fontSize: 13, color: "var(--color-neutral-600)" }}> / {baht(cb.daily_cap_thb, 0)} วันนี้</span>
      </p>
      <div className="bar-track" style={{ height: 6, margin: "10px 0 6px" }}>
        <div className="bar-fill" style={{ width: `${Math.min(100, usedPct)}%`, background: usedPct >= 100 ? LOSS : "var(--color-accent-500)" }} />
      </div>
      <p style={{ margin: 0, fontSize: 13, color: state.color }}>{state.label} · {pct(usedPct)} ของเพดาน</p>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--color-divider)", fontSize: 12.5, color: "var(--color-neutral-700)" }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          เปิดเพดาน
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ flex: 1 }}>เพดานต่อวัน (บาท)</span>
          <NumberInput label="เพดานค่าใช้จ่ายต่อวัน บาท" value={d.daily_cap_thb} step={100} width={104} onChange={(v) => set({ daily_cap_thb: v })} />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ flex: 1 }}>หยุดงานที่กำลังทำเมื่อถึง × เพดาน</span>
          <NumberInput label="ตัวคูณหยุดงานที่กำลังทำ" value={d.hard_stop_ratio} step={0.05} min={1} width={104} onChange={(v) => set({ hard_stop_ratio: v })} />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ flex: 1 }}>อีเมลแจ้งเตือน</span>
          <input className="input" type="email" aria-label="อีเมลแจ้งเตือนเมื่อถึงเพดาน" maxLength={255} value={d.alert_email ?? ""}
            placeholder="ผู้ดูแลทุกคน" onChange={(e) => set({ alert_email: e.target.value })}
            style={{ width: 200, fontFamily: "inherit", fontSize: 13, minHeight: 32 }} />
        </label>
      </div>
      {dirty && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
          {!valid && <span className="err" style={{ fontSize: 12 }}>เพดาน 0–10,000,000 บาท · ตัวคูณ 1–10 · อีเมลต้องถูกต้อง</span>}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-secondary" onClick={() => setDraft(null)} style={{ fontFamily: "inherit", fontSize: 12.5 }}>ยกเลิก</button>
          <button type="button" className="btn btn-primary" disabled={!valid} onClick={save} style={{ fontFamily: "inherit", fontSize: 12.5 }}>บันทึก</button>
        </div>
      )}
    </section>
  );
}
