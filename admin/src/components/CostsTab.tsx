"use client";

import { b0, baht, num, pct } from "@/lib/format";
import { modelPrice, perCredit, type Ctx, type Summary } from "@/lib/money";
import { TASK_USE_LABEL, taskForFeature } from "@/lib/plans";
import type { CostConfig, DashboardData } from "@/lib/types";
import { LOSS, NumberInput, Seg } from "./ui";

let seq = 0;
function newId(prefix: string): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq}`;
}

export function CostsTab({
  ctx, s, data, cfg, setCfg, dirty, onSave, onCancel,
}: {
  ctx: Ctx;
  s: Summary;
  data: DashboardData;
  cfg: CostConfig;
  setCfg: (c: CostConfig) => void;
  dirty: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const edit = (f: (d: CostConfig) => void) => {
    const d: CostConfig = JSON.parse(JSON.stringify(cfg));
    f(d);
    setCfg(d);
  };

  // Every model the owner priced, plus every model that did work in the period.
  const seen = new Map(data.models_seen.map((m) => [m.model, m.features]));
  const modelKeys = Array.from(new Set([...Object.keys(cfg.models), ...seen.keys()])).sort();
  const modelRows = modelKeys.map((key) => {
    let inTok = 0;
    let outTok = 0;
    let calls = 0;
    for (const u of s.counted) {
      for (const t of u.tokens) {
        if (t.model !== key) continue;
        inTok += t.input;
        outTok += t.output;
        calls += t.calls;
      }
    }
    const p = modelPrice(ctx, key);
    const usd = (inTok * p.input + outTok * p.output) / 1e6;
    const uses = Array.from(new Set((seen.get(key) ?? []).map((f) => TASK_USE_LABEL[taskForFeature(f)])));
    return { key, p, calls, inTok, outTok, usd, use: uses.length ? uses.join(" + ") : "ไม่มีการใช้งานในช่วงนี้", priced: key in cfg.models };
  });

  const pc = perCredit(cfg);
  const sttUsedPct = (s.mCredits / (Number(cfg.stt.credits) || 1)) * 100;
  const rates = data.stt_rates;
  const sttModels = Array.from(new Set([...Object.keys(rates), cfg.stt.model]));
  const cheapest = Math.min(...Object.values(rates));
  const current = cfg.stt.credits_per_hour;
  const sttWarning =
    current <= cheapest
      ? `${cfg.stt.model} อยู่ที่ ${num(current)} เครดิต/ชม. · โมเดลอื่นแพงกว่าถึง ${(Math.max(...Object.values(rates)) / current).toFixed(1)} เท่า`
      : `${cfg.stt.model} อยู่ที่ ${num(current)} เครดิต/ชม. แพงกว่าโมเดลที่ถูกที่สุด ${(current / cheapest).toFixed(1)} เท่า`;

  const activeUsers = s.counted.filter((u) => u.clips > 0).length;
  const unitRows = [
    { label: "ต่อคลิปที่สำเร็จ", value: baht(s.tClips ? (s.tToken + s.tStt + s.tExtra) / s.tClips : 0), sub: "โทเค็น ถอดเสียง และบริการต่อผู้ใช้" },
    { label: "ต่อนาทีฟุตเทจ", value: baht(s.tMin ? (s.tToken + s.tStt) / s.tMin : 0), sub: `${num(s.tMin)} นาที` },
    { label: "ต่อผู้ใช้ที่ใช้งานจริง", value: baht(activeUsers ? s.costTotal / activeUsers : 0), sub: `รวมค่าคงที่ หาร ${activeUsers} คน` },
    { label: "เสียไปกับงานล้มเหลว", value: baht(s.wasted), sub: `${s.tFailed} จาก ${num(s.tClips + s.tFailed)} งาน`, color: LOSS },
  ];

  const fixedTotal = cfg.fixed.reduce((acc, f) => acc + Number(f.value || 0), 0);
  const inputStyle: React.CSSProperties = { fontFamily: "inherit", fontSize: 13.5, minHeight: 32 };

  return (
    <div>
      <section className="card" aria-labelledby="models-title">
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
          <p id="models-title" className="card-title">ราคาต่อโมเดล</p>
          <p className="card-sub">ดอลลาร์ต่อล้านโทเค็น แก้ได้</p>
          <span style={{ flex: 1 }} />
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--color-neutral-700)" }}>
            อัตราแลกเปลี่ยน
            <NumberInput label="อัตราแลกเปลี่ยน บาทต่อดอลลาร์" value={cfg.fx_rate} step={0.5} width={86} onChange={(v) => edit((d) => { d.fx_rate = v; })} />
            ฿/USD
          </label>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="table" style={{ fontFamily: "inherit", fontSize: 13, minWidth: 720 }}>
            <thead>
              <tr>
                <th>โมเดล</th>
                <th>ใช้กับงาน</th>
                <th style={{ textAlign: "right", whiteSpace: "nowrap" }}>เข้า $/1M</th>
                <th style={{ textAlign: "right", whiteSpace: "nowrap" }}>ออก $/1M</th>
                <th style={{ textAlign: "right" }}>คำขอ</th>
                <th style={{ textAlign: "right", whiteSpace: "nowrap" }}>โทเค็น เข้า / ออก</th>
                <th style={{ textAlign: "right" }}>บาท</th>
              </tr>
            </thead>
            <tbody>
              {modelRows.map((m) => (
                <tr key={m.key}>
                  <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 11.5, wordBreak: "break-all" }}>
                    {m.key}
                    {!m.priced && <span style={{ display: "block", fontFamily: "var(--font-body)", fontSize: 11, color: "var(--color-accent-700)" }}>ราคาตั้งต้น — บันทึกเพื่อใช้ค่านี้</span>}
                  </td>
                  <td>{m.use}</td>
                  <td style={{ textAlign: "right" }}>
                    <NumberInput label={`${m.key} ราคาโทเค็นเข้า`} value={m.p.input} step={0.01} width={82}
                      onChange={(v) => edit((d) => { d.models[m.key] = { ...(d.models[m.key] ?? m.p), input: v }; })} />
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <NumberInput label={`${m.key} ราคาโทเค็นออก`} value={m.p.output} step={0.01} width={82}
                      onChange={(v) => edit((d) => { d.models[m.key] = { ...(d.models[m.key] ?? m.p), output: v }; })} />
                  </td>
                  <td className="num" style={{ textAlign: "right" }}>{num(m.calls)}</td>
                  <td className="num" style={{ textAlign: "right", whiteSpace: "nowrap" }}>{num(m.inTok)} / {num(m.outTok)}</td>
                  <td className="num" style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {baht(m.usd * cfg.fx_rate)}
                    <span style={{ display: "block", fontSize: 11.5, color: "var(--color-neutral-600)" }}>${m.usd.toFixed(2)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ margin: "12px 0 0" }} className="small">
          ราคาตั้งต้นคือราคาป้ายของผู้ให้บริการ · โทเค็นทุกตัวมาจากบันทึกการใช้งานจริงของแต่ละคำขอ
        </p>
        <div style={{ display: "flex", gap: 22, flexWrap: "wrap", marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--color-divider)", fontSize: 13 }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={cfg.vat_included} onChange={(e) => edit((d) => { d.vat_included = e.target.checked; })} />
            ราคาแผนรวม VAT 7% แล้ว (รายได้แสดงแบบหัก VAT)
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={cfg.include_internal} onChange={(e) => edit((d) => { d.include_internal = e.target.checked; })} />
            นับบัญชีผู้ดูแลในยอดรวม
          </label>
        </div>
      </section>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))" }}>
        <section className="card" aria-labelledby="stt-title">
          <p id="stt-title" className="card-title" style={{ marginBottom: 2 }}>ถอดเสียง</p>
          <p className="card-sub" style={{ marginBottom: 16 }}>บัญชีเดียวรวมทุกคน แบ่งส่วนจากบันทึกของเรา</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
            <div style={{ fontSize: 12.5, color: "var(--color-neutral-700)" }}>
              โมเดลที่ใช้
              <Seg
                label="โมเดลถอดเสียง"
                value={cfg.stt.model}
                onChange={(m) => edit((d) => { d.stt.model = m; d.stt.credits_per_hour = rates[m] ?? d.stt.credits_per_hour; })}
                options={sttModels.map((m) => ({ value: m, label: m }))}
                style={{ display: "flex", marginTop: 5 }}
              />
            </div>
            <label style={{ fontSize: 12.5, color: "var(--color-neutral-700)" }}>
              เครดิตต่อชั่วโมง
              <NumberInput label="เครดิตต่อชั่วโมง" value={cfg.stt.credits_per_hour} onChange={(v) => edit((d) => { d.stt.credits_per_hour = v; })} style={{ marginTop: 5, minHeight: 36 }} />
            </label>
            <label style={{ fontSize: 12.5, color: "var(--color-neutral-700)" }}>
              ค่าแพ็กเกจต่อเดือน
              <NumberInput label="ค่าแพ็กเกจต่อเดือน" value={cfg.stt.monthly_price} onChange={(v) => edit((d) => { d.stt.monthly_price = v; })} style={{ marginTop: 5, minHeight: 36 }} />
            </label>
            <label style={{ fontSize: 12.5, color: "var(--color-neutral-700)" }}>
              เครดิตในแพ็กเกจ
              <NumberInput label="เครดิตในแพ็กเกจ" value={cfg.stt.credits} onChange={(v) => edit((d) => { d.stt.credits = Math.round(v); })} style={{ marginTop: 5, minHeight: 36 }} />
            </label>
          </div>
          <p className="num" style={{ margin: 0, fontSize: 28, fontWeight: 300, lineHeight: 1.1 }}>{pct(sttUsedPct)}</p>
          <p className="num" style={{ margin: "5px 0 0", fontSize: 13, color: "var(--color-neutral-700)" }}>
            {num(s.mCredits)} จาก {num(cfg.stt.credits)} เครดิต · {num(s.tMin)} นาทีในช่วงที่เลือก
          </p>
          <div style={{ height: 9, background: "var(--color-neutral-200)", borderRadius: 2, margin: "12px 0 0", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${Math.min(100, sttUsedPct)}%`, background: "var(--color-accent)" }} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16, fontSize: 13 }}>
            {[
              { label: "ราคาต่อเครดิต", value: `฿${pc.toFixed(4)}` },
              { label: "ต้นทุนต่อนาทีเสียง", value: baht(pc * (Number(cfg.stt.credits_per_hour) / 60)) },
              { label: "เครดิตที่ยังไม่ได้ใช้", value: num(Math.max(0, Number(cfg.stt.credits) - s.mCredits)) },
            ].map((r) => (
              <div key={r.label} style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <span style={{ color: "var(--color-neutral-700)" }}>{r.label}</span>
                <span className="rule-fill" />
                <span className="num">{r.value}</span>
              </div>
            ))}
          </div>
          <div style={{ border: "1px solid var(--color-accent-300)", background: "var(--color-accent-100)", borderRadius: 4, padding: "11px 13px", marginTop: 16 }}>
            <p style={{ margin: 0, fontSize: 12.5, color: "var(--color-accent-900)" }}>{sttWarning}</p>
          </div>
        </section>

        <section className="card" aria-labelledby="fixed-title">
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 14 }}>
            <p id="fixed-title" className="card-title">ต้นทุนคงที่รายเดือน</p>
            <span style={{ flex: 1 }} />
            <button type="button" className="btn btn-secondary" disabled={cfg.fixed.length >= 40}
              onClick={() => edit((d) => { d.fixed.push({ id: newId("f"), label: "", value: 0 }); })}
              style={{ fontFamily: "inherit", fontSize: 12.5, minHeight: 30, padding: "4px 12px" }}>
              เพิ่มรายการ
            </button>
          </div>
          {cfg.fixed.map((f, i) => (
            <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 0", borderBottom: "1px solid var(--color-divider)" }}>
              <input className="input" type="text" aria-label="ชื่อรายการ" maxLength={80} value={f.label} placeholder="ชื่อรายการ"
                onChange={(e) => edit((d) => { d.fixed[i].label = e.target.value; })} style={{ ...inputStyle, flex: 1 }} />
              <NumberInput label={`${f.label || "รายการ"} บาทต่อเดือน`} value={f.value} width={104} onChange={(v) => edit((d) => { d.fixed[i].value = v; })} />
              <button type="button" className="remove-btn" aria-label={`ลบ ${f.label || "รายการ"}`} onClick={() => edit((d) => { d.fixed.splice(i, 1); })}>✕</button>
            </div>
          ))}
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, padding: "14px 0 0" }}>
            <span style={{ fontSize: 14, fontWeight: 500 }}>รวม</span>
            <span className="rule-fill" />
            <span className="num" style={{ fontSize: 18, fontWeight: 500 }}>{b0(fixedTotal)}</span>
          </div>
          <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--color-neutral-600)" }}>ค่าถอดเสียงอยู่ในการ์ดซ้าย ไม่ต้องใส่ซ้ำที่นี่</p>
        </section>
      </div>

      <section className="card" style={{ marginTop: 20 }} aria-labelledby="peruser-title">
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 6 }}>
          <p id="peruser-title" className="card-title">ต้นทุนต่อผู้ใช้</p>
          <p className="card-sub">บริการที่คิดเป็นรายคนหรือรายคลิป เช่น SMS OTP และอีเมล</p>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-secondary" disabled={cfg.per_user.length >= 40}
            onClick={() => edit((d) => { d.per_user.push({ id: newId("p"), label: "", value: 0, basis: "user" }); })}
            style={{ fontFamily: "inherit", fontSize: 12.5, minHeight: 30, padding: "4px 12px" }}>
            เพิ่มรายการ
          </button>
        </div>
        <div className="eyebrow" style={{ display: "flex", gap: 9, padding: "6px 0 4px", borderBottom: "1px solid var(--color-divider)" }}>
          <span style={{ flex: 1 }}>รายการ</span>
          <span style={{ width: 104, textAlign: "right" }}>ราคา</span>
          <span style={{ width: 150 }}>คิดตาม (ต่อเดือน)</span>
          <span style={{ width: 96, textAlign: "right" }}>รวมช่วงนี้</span>
          <span style={{ width: 30 }} />
        </div>
        {cfg.per_user.map((x, i) => {
          const total = s.counted.reduce((acc, u) => acc + (x.basis === "clip" ? x.value * u.clips : u.active ? (x.value * ctx.days) / 30 : 0), 0);
          return (
            <div key={x.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 0", borderBottom: "1px solid var(--color-divider)" }}>
              <input className="input" type="text" aria-label="ชื่อรายการ" maxLength={80} value={x.label} placeholder="ชื่อรายการ"
                onChange={(e) => edit((d) => { d.per_user[i].label = e.target.value; })} style={{ ...inputStyle, flex: 1 }} />
              <NumberInput label={`${x.label || "รายการ"} ราคา`} value={x.value} step={0.01} width={104} onChange={(v) => edit((d) => { d.per_user[i].value = v; })} />
              <Seg label="คิดตาม" value={x.basis} style={{ width: 150 }}
                onChange={(b) => edit((d) => { d.per_user[i].basis = b; })}
                options={[{ value: "user", label: "ต่อคน" }, { value: "clip", label: "ต่อคลิป" }]} />
              <span className="num" style={{ width: 96, textAlign: "right", fontSize: 13.5 }}>{baht(total)}</span>
              <button type="button" className="remove-btn" aria-label={`ลบ ${x.label || "รายการ"}`} onClick={() => edit((d) => { d.per_user.splice(i, 1); })}>✕</button>
            </div>
          );
        })}
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, padding: "13px 0 0" }}>
          <span style={{ fontSize: 14, fontWeight: 500 }}>รวมในช่วงที่เลือก</span>
          <span className="rule-fill" />
          <span className="num" style={{ fontSize: 18, fontWeight: 500 }}>{baht(s.tExtra)}</span>
        </div>
        <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--color-neutral-600)" }}>รายการนี้บวกเข้าไปในต้นทุนรายคนทุกหน้า รวมถึงกำไรต่อคนและจุดคุ้มทุน</p>
      </section>

      <section className="card" style={{ marginTop: 20 }} aria-labelledby="unit-title">
        <p id="unit-title" className="card-title" style={{ marginBottom: 16 }}>ต้นทุนต่อหน่วย</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 1, background: "var(--color-divider)", border: "1px solid var(--color-divider)" }}>
          {unitRows.map((u) => (
            <div key={u.label} style={{ background: "var(--color-bg)", padding: "14px 16px" }}>
              <p style={{ margin: 0, fontSize: 12.5, color: "var(--color-neutral-700)" }}>{u.label}</p>
              <p className="num" style={{ margin: "5px 0 0", fontSize: 24, fontWeight: 300, lineHeight: 1.1, color: u.color ?? "var(--color-text)" }}>{u.value}</p>
              <p style={{ margin: "5px 0 0", fontSize: 12, color: "var(--color-neutral-600)" }}>{u.sub}</p>
            </div>
          ))}
        </div>
      </section>

      {dirty && (
        <div className="sticky-save">
          <span style={{ fontSize: 13 }}>แก้ค่าต้นทุนแล้ว ยังไม่ได้บันทึก</span>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-secondary" onClick={onCancel} style={{ fontFamily: "inherit", fontSize: 13 }}>ยกเลิก</button>
          <button type="button" className="btn btn-primary" onClick={onSave} style={{ fontFamily: "inherit", fontSize: 13 }}>บันทึก</button>
        </div>
      )}
    </div>
  );
}
