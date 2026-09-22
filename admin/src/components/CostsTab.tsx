"use client";

import type { ActionResult } from "@/app/actions";
import { b0, baht, num, thaiDay } from "@/lib/format";
import { modelPrice, patchStepAt, priceAt, sttPrice, tokenCost, type Ctx, type Summary } from "@/lib/money";
import { TASK_USE_LABEL, taskForFeature } from "@/lib/plans";
import type { CostConfig, DashboardData, FxView, ModelPrice, TokenRow } from "@/lib/types";
import { BreakerCard } from "./BreakerCard";
import { VendorQuotaCard } from "./VendorQuotaCard";
import { FxCard } from "./FxCard";
import { ReconciliationCard } from "./ReconciliationCard";
import { LOSS, NumberInput, OK, Seg, type ConfirmSpec } from "./ui";

let seq = 0;
function newId(prefix: string): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq}`;
}

export function CostsTab({
  ctx, s, data, cfg, setCfg, dirty, onSave, onCancel, handle, onFxChange, ask, done,
}: {
  ctx: Ctx;
  s: Summary;
  data: DashboardData;
  cfg: CostConfig;
  setCfg: (c: CostConfig) => void;
  dirty: boolean;
  onSave: () => void;
  onCancel: () => void;
  handle: <T>(r: ActionResult<T>) => r is { ok: true; data: T };
  onFxChange: (fx: FxView) => void;
  ask: (spec: ConfirmSpec) => void;
  done: (message: string) => void;
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
    const rows: TokenRow[] = [];
    for (const u of s.counted) for (const t of u.tokens) if (t.model === key) rows.push(t);
    const inTok = rows.reduce((a, t) => a + t.input, 0);
    const outTok = rows.reduce((a, t) => a + t.output, 0);
    const calls = rows.reduce((a, t) => a + t.calls, 0);
    const failed = rows.reduce((a, t) => a + (t.failed_calls ?? 0), 0);
    const full = modelPrice(ctx, key);
    const p = priceAt(full, ctx.today);
    const uses = Array.from(new Set((seen.get(key) ?? []).map((f) => TASK_USE_LABEL[taskForFeature(f)])));
    return {
      key, full, p, calls, failed, inTok, outTok, thb: tokenCost(ctx, rows),
      use: uses.length ? uses.join(" + ") : "ไม่มีการใช้งานในช่วงนี้", priced: key in cfg.models,
    };
  });
  const setPrice = (key: string, full: ModelPrice, patch: Partial<ModelPrice>) =>
    edit((d) => { d.models[key] = patchStepAt(d.models[key] ?? full, ctx.today, patch); });

  // Speech-to-text is pay-as-you-go per hour of billed audio.
  const sttModels = Array.from(new Set([...Object.keys(cfg.stt), ...Object.keys(data.stt_defaults ?? {})])).sort();
  const sttHours = s.tMin / 60;

  const activeUsers = s.counted.filter((u) => u.clips > 0).length;
  const unitRows = [
    { label: "ต่อคลิปที่สำเร็จ", value: baht(s.tClips ? (s.tToken + s.tStt + s.tExtra) / s.tClips : 0), sub: "โทเค็น ถอดเสียง และบริการต่อผู้ใช้" },
    { label: "ต่อนาทีฟุตเทจ", value: baht(s.tMin ? (s.tToken + s.tStt) / s.tMin : 0), sub: `${num(s.tMin)} นาที` },
    { label: "ต่อผู้ใช้ที่ใช้งานจริง", value: baht(activeUsers ? s.costTotal / activeUsers : 0), sub: `รวมค่าคงที่ หาร ${activeUsers} คน` },
    { label: "เสียไปกับงานล้มเหลว", value: baht(s.wasted), sub: `${s.tFailed} จาก ${num(s.tClips + s.tFailed)} งาน`, color: LOSS },
    {
      label: "ต้นทุนต่อ 1 ล้านโทเค็น", value: s.costPer1M === null ? "—" : baht(s.costPer1M),
      sub: `อ้างอิง ฿${num(ctx.referencePer1M ?? 50)} · ต้นทุนจริงที่บันทึกไว้`,
    },
    {
      label: "กำไรต่อ 1 ล้านโทเค็น", value: s.marginPer1M === null ? "—" : baht(s.marginPer1M),
      sub: `ขาย ฿${num(ctx.sellPer1M)} ทุกแผน`, color: s.marginPer1M !== null && s.marginPer1M < 0 ? LOSS : OK,
    },
  ];

  const fixedTotal = cfg.fixed.reduce((acc, f) => acc + Number(f.value || 0), 0);
  const inputStyle: React.CSSProperties = { fontFamily: "inherit", fontSize: 13.5, minHeight: 32 };

  return (
    <div>
      <section className="card" aria-labelledby="models-title">
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
          <p id="models-title" className="card-title">ราคาต่อโมเดล</p>
          <p className="card-sub">ดอลลาร์ต่อล้านโทเค็น ราคาที่ใช้วันนี้ แก้ได้ · มีผลกับคำขอถัดไปเท่านั้น</p>
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
                  <td>
                    {m.use}
                    {m.p.until && m.p.then && (
                      <span style={{ display: "block", fontSize: 11.5, color: "var(--color-neutral-600)" }}>
                        ถึง {thaiDay(m.p.until)} แล้วเป็น ${m.p.then.input} / ${m.p.then.output}
                      </span>
                    )}
                    {m.p.long_threshold && (
                      <span style={{ display: "block", fontSize: 11.5, color: "var(--color-neutral-600)" }}>
                        พรอมต์เกิน {num(m.p.long_threshold)}: ${m.p.input_long} / ${m.p.output_long}
                      </span>
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <NumberInput label={`${m.key} ราคาโทเค็นเข้า`} value={m.p.input} step={0.01} width={82}
                      onChange={(v) => setPrice(m.key, m.full, { input: v })} />
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <NumberInput label={`${m.key} ราคาโทเค็นออก`} value={m.p.output} step={0.01} width={82}
                      onChange={(v) => setPrice(m.key, m.full, { output: v })} />
                  </td>
                  <td className="num" style={{ textAlign: "right" }}>
                    {num(m.calls)}
                    {m.failed > 0 && <span style={{ display: "block", fontSize: 11.5, color: LOSS }}>ล้มเหลว {num(m.failed)}</span>}
                  </td>
                  <td className="num" style={{ textAlign: "right", whiteSpace: "nowrap" }}>{num(m.inTok)} / {num(m.outTok)}</td>
                  <td className="num" style={{ textAlign: "right", whiteSpace: "nowrap" }}>{baht(m.thb)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ margin: "12px 0 0" }} className="small">
          ราคาตั้งต้นคือราคาป้ายของผู้ให้บริการ · บาทคือต้นทุนที่บันทึกไว้ตอนเกิดคำขอ (รวมคำขอที่ล้มเหลว) ·
          แถวเก่าก่อนมีการบันทึกต้นทุนคิดจากราคาในหน้านี้
        </p>
        <div style={{ display: "flex", gap: 22, flexWrap: "wrap", marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--color-divider)", fontSize: 13 }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={cfg.vat_included} onChange={(e) => edit((d) => { d.vat_included = e.target.checked; })} />
            ราคาแผนรวม VAT 7% แล้ว (รายได้แสดงแบบหัก VAT) — ปิดไว้ เพราะยังไม่ได้จด VAT
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
          <p className="card-sub" style={{ marginBottom: 16 }}>จ่ายตามใช้ ดอลลาร์ต่อชั่วโมงเสียง · บัญชีเดียวรวมทุกคน แบ่งส่วนจากบันทึกของเรา</p>
          {sttModels.map((model) => {
            const p = sttPrice(ctx, model);
            const set = (patch: Partial<typeof p>) => edit((d) => { d.stt[model] = { ...(d.stt[model] ?? p), ...patch }; });
            return (
              <div key={model} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
                <p style={{ gridColumn: "1 / -1", margin: 0, fontFamily: "ui-monospace, monospace", fontSize: 11.5 }}>
                  {model}
                  {!(model in cfg.stt) && <span style={{ fontFamily: "var(--font-body)", fontSize: 11, color: "var(--color-accent-700)" }}> · ราคาตั้งต้น</span>}
                </p>
                <label style={{ fontSize: 12.5, color: "var(--color-neutral-700)" }}>
                  $ ต่อชั่วโมง
                  <NumberInput label={`${model} ดอลลาร์ต่อชั่วโมง`} value={p.usd_per_hour} step={0.01} onChange={(v) => set({ usd_per_hour: v })} style={{ marginTop: 5, minHeight: 36 }} />
                </label>
                <label style={{ fontSize: 12.5, color: "var(--color-neutral-700)" }}>
                  + คำเฉพาะ $ ต่อชั่วโมง
                  <NumberInput label={`${model} ค่าคำเฉพาะต่อชั่วโมง`} value={p.keyterms_usd_per_hour} step={0.01} onChange={(v) => set({ keyterms_usd_per_hour: v })} style={{ marginTop: 5, minHeight: 36 }} />
                </label>
              </div>
            );
          })}
          <p className="num" style={{ margin: 0, fontSize: 28, fontWeight: 300, lineHeight: 1.1 }}>{baht(s.tStt)}</p>
          <p className="num" style={{ margin: "5px 0 0", fontSize: 13, color: "var(--color-neutral-700)" }}>
            {num(s.tMin)} นาที ({sttHours.toFixed(1)} ชั่วโมง) ในช่วงที่เลือก
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16, fontSize: 13 }}>
            {[
              { label: "ต้นทุนต่อนาทีเสียง (จริง)", value: baht(s.tMin ? s.tStt / s.tMin : 0) },
              { label: "คาดทั้งเดือน", value: baht(s.mStt) },
            ].map((r) => (
              <div key={r.label} style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <span style={{ color: "var(--color-neutral-700)" }}>{r.label}</span>
                <span className="rule-fill" />
                <span className="num">{r.value}</span>
              </div>
            ))}
          </div>
        </section>

        <FxCard cfg={cfg} edit={edit} handle={handle} onChange={onFxChange} />

        <BreakerCard initial={data.circuit_breaker} handle={handle} ask={ask} done={done} />

        <VendorQuotaCard />

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

      <ReconciliationCard today={data.today} handle={handle} />

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
