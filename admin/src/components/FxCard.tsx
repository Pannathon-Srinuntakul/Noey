"use client";

import { useEffect, useState, useTransition } from "react";
import { getFxAction, refreshFxAction, setFxOverrideAction, type ActionResult } from "@/app/actions";
import { FX_BAND, fxSourceLabel } from "@/lib/billing";
import { thaiDay } from "@/lib/format";
import type { CostConfig, FxView } from "@/lib/types";
import { NumberInput } from "./ui";

/**
 * The USD→THB rate new usage is priced with. The backend fetches it daily;
 * an override typed here wins until cleared. Saved on its own (audited),
 * outside the cost-config draft — only the manual fallback rate is part of
 * that draft.
 */
export function FxCard({
  cfg, edit, handle, onChange,
}: {
  cfg: CostConfig;
  edit: (f: (d: CostConfig) => void) => void;
  handle: <T>(r: ActionResult<T>) => r is { ok: true; data: T };
  onChange: (fx: FxView) => void;
}) {
  const [fx, setFx] = useState<FxView | null>(null);
  const [draft, setDraft] = useState<number | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let alive = true;
    void getFxAction().then((r) => {
      if (alive && r.ok) setFx(r.data);
    });
    return () => {
      alive = false;
    };
  }, []);

  function apply(r: ActionResult<FxView>) {
    if (!handle(r)) return;
    setFx(r.data);
    setDraft(null);
    onChange(r.data);
  }

  const shown = draft ?? fx?.override ?? fx?.usd_thb ?? cfg.fx_rate;
  const inBand = shown >= FX_BAND[0] && shown <= FX_BAND[1];

  return (
    <section className="card" aria-labelledby="fx-title">
      <p id="fx-title" className="card-title" style={{ marginBottom: 2 }}>อัตราแลกเปลี่ยน</p>
      <p className="card-sub" style={{ marginBottom: 14 }}>ใช้คิดต้นทุนจริงของแต่ละคำขอ ไม่มีผลกับโควตาของผู้ใช้</p>
      <p className="num" style={{ margin: 0, fontSize: 28, fontWeight: 300, lineHeight: 1.1 }}>
        {fx ? `฿${fx.usd_thb.toFixed(2)}` : "—"}
        <span style={{ fontSize: 13, color: "var(--color-neutral-600)" }}> / USD</span>
      </p>
      <p style={{ margin: "5px 0 0", fontSize: 13, color: "var(--color-neutral-700)" }}>
        {fx ? fxSourceLabel(fx.source) : "กำลังโหลด…"}
        {fx?.fetched && ` · ดึงล่าสุด ${thaiDay(fx.fetched.date)} ฿${fx.fetched.usd_thb.toFixed(2)}`}
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--color-neutral-700)" }}>
          กำหนดเอง
          <NumberInput label="อัตราแลกเปลี่ยนที่กำหนดเอง บาทต่อดอลลาร์" value={shown} step={0.05} width={86} onChange={setDraft} />
        </label>
        <button type="button" className="btn btn-secondary" disabled={pending || draft === null || !inBand}
          onClick={() => start(async () => apply(await setFxOverrideAction(draft)))}
          style={{ fontFamily: "inherit", fontSize: 12.5, minHeight: 30, padding: "4px 12px" }}>
          ใช้ค่านี้
        </button>
        {fx?.override !== null && fx?.override !== undefined && (
          <button type="button" className="btn btn-secondary" disabled={pending}
            onClick={() => start(async () => apply(await setFxOverrideAction(null)))}
            style={{ fontFamily: "inherit", fontSize: 12.5, minHeight: 30, padding: "4px 12px" }}>
            กลับไปใช้ค่าที่ดึงอัตโนมัติ
          </button>
        )}
        <button type="button" className="btn btn-secondary" disabled={pending}
          onClick={() => start(async () => apply(await refreshFxAction()))}
          style={{ fontFamily: "inherit", fontSize: 12.5, minHeight: 30, padding: "4px 12px" }}>
          ดึงตอนนี้
        </button>
      </div>
      {!inBand && <p className="err" style={{ margin: "8px 0 0", fontSize: 12 }}>ต้องอยู่ระหว่าง ฿{FX_BAND[0]}–{FX_BAND[1]}</p>}

      <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--color-divider)", fontSize: 12.5, color: "var(--color-neutral-700)" }}>
        ค่าสำรองเมื่อดึงไม่ได้เกิน 7 วัน
        <NumberInput label="อัตราแลกเปลี่ยนสำรอง บาทต่อดอลลาร์" value={cfg.fx_rate} step={0.5} width={86} onChange={(v) => edit((d) => { d.fx_rate = v; })} />
        ฿/USD
      </label>
    </section>
  );
}
