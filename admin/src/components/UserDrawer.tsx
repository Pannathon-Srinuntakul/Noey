"use client";

import { useEffect, useRef } from "react";
import { b0, baht, num, pct } from "@/lib/format";
import { jobCost, type Ctx, type UserMoney } from "@/lib/money";
import { MODE_LABEL, PLAN_KEYS, STATUS_LABEL, planLabel } from "@/lib/plans";
import type { LimitFacts, UserDetail, WindowKey } from "@/lib/types";
import { LOSS, OK, Seg, TASKS, TaskBars } from "./ui";
import { LimitsSection, RunsSection, WalletSection } from "./UserBilling";

function relDay(iso: string | null): string {
  if (!iso) return "—";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return days <= 0 ? "วันนี้" : `${days} วันก่อน`;
}

export function UserDrawer({
  u, ctx, detail, detailError, isSelf, onClose, onPlan, onResetQuota, onResetWindow, onWalletAdjust, onToggleActive,
}: {
  u: UserMoney;
  ctx: Ctx;
  detail: UserDetail | null;
  detailError: string | null;
  isSelf: boolean;
  onClose: () => void;
  onPlan: (plan: string) => void;
  onResetQuota: () => void;
  onResetWindow: (w: WindowKey) => void;
  onWalletAdjust: (satang: number, note: string) => void;
  onToggleActive: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, [u.id]);

  const ttSum = TASKS.reduce((acc, t) => acc + u.tasks[t.k], 0) || 1;
  const ttMax = Math.max(...TASKS.map((t) => u.tasks[t.k]), 1);
  const tasks = TASKS.map((t) => ({
    label: t.label, color: t.color, value: baht(u.tasks[t.k]), pct: pct((u.tasks[t.k] / ttSum) * 100), w: Math.round((u.tasks[t.k] / ttMax) * 100),
  }));
  const high = u.precision_high_pct;
  // The detail call has the freshest limits; until it lands, the dashboard's
  // flattened per-user facts.
  const limits: LimitFacts | null =
    detail?.limits ??
    (u.windows
      ? {
          effective_plan: u.effective_plan ?? u.plan, unlimited: !!u.unlimited, windows: u.windows,
          quota_window: u.quota_window ?? null, quota_limit_tokens: u.quota_limit_tokens,
          quota_used_tokens: u.quota_used_tokens, quota_used_pct: u.quota_used_pct,
          wallet_balance_satang: u.wallet_balance_satang ?? 0, pending_plan: u.pending_plan ?? null,
          grace_until: u.grace_until ?? null,
        }
      : null);
  const eyebrow: React.CSSProperties = { margin: "0 0 12px", fontSize: 12.5, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--color-neutral-600)" };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14, padding: "20px 24px 16px", borderBottom: "1px solid var(--color-divider)" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p id="drawer-title" style={{ margin: 0, fontSize: 19, fontWeight: 500, wordBreak: "break-all" }}>{u.email}</p>
            <p className="num" style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--color-neutral-600)" }}>
              {planLabel(u.plan)} · {num(u.clips)} คลิป · {num(u.sttMin)} นาทีถอดเสียง · ใช้ล่าสุด {u.last_active_days === null ? "ยังไม่เคย" : u.last_active_days <= 0 ? "วันนี้" : `${u.last_active_days} วันก่อน`}
              {!u.active && " · ปิดการใช้งานแล้ว"}
            </p>
          </div>
          <button ref={closeRef} type="button" className="btn btn-secondary btn-icon" onClick={onClose} aria-label="ปิด">✕</button>
        </div>

        <div style={{ padding: "18px 24px 0" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", border: "1px solid var(--color-divider)", borderRadius: 4 }}>
            {[
              { label: "จ่าย/เดือน", value: u.internal ? "—" : b0((u.pays + u.topup) * (30 / ctx.days)) },
              { label: "ต้นทุน", value: baht(u.cost) },
              { label: "กำไร", value: u.internal ? "—" : baht(u.profit), color: u.internal ? "var(--color-neutral-600)" : u.profit >= 0 ? OK : LOSS },
            ].map((x, i) => (
              <div key={x.label} style={{ padding: "13px 15px", borderRight: i < 2 ? "1px solid var(--color-divider)" : undefined }}>
                <p style={{ margin: 0, fontSize: 12, color: "var(--color-neutral-700)" }}>{x.label}</p>
                <p className="num" style={{ margin: "4px 0 0", fontSize: 22, fontWeight: 300, lineHeight: 1.1, color: x.color }}>{x.value}</p>
              </div>
            ))}
          </div>
          {u.topup > 0 && (
            <p className="num" style={{ margin: "8px 0 0", fontSize: 12, color: "var(--color-neutral-600)" }}>
              รวมเติมเงิน {baht(u.topup)} ในช่วงนี้ · ใช้จากยอดเติม {baht(u.walletSpent)}
            </p>
          )}
          {u.planPrice > 0 && !u.subscription.live && !u.internal && (
            <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--color-neutral-600)" }}>ไม่มีการสมัครสมาชิกที่ชำระเงิน — แผนนี้ผู้ดูแลตั้งให้</p>
          )}
        </div>

        <LimitsSection limits={limits} onResetWindow={onResetWindow} onResetAll={onResetQuota} />

        <div style={{ padding: "20px 24px 0" }}>
          <p style={eyebrow}>ต้นทุนแยกตามงาน</p>
          <TaskBars rows={tasks} size="sm" />
        </div>

        <div style={{ padding: "16px 24px 0" }}>
          <p style={eyebrow}>คุณภาพที่เลือกใช้</p>
          <div style={{ display: "flex", gap: 14 }}>
            {[
              { label: "Engine pro", v: u.engine_pro_pct, color: "var(--color-accent-500)" },
              { label: "Precision high", v: high, color: "var(--color-accent-700)" },
            ].map((q) => (
              <div key={q.label} style={{ flex: 1, border: "1px solid var(--color-divider)", borderRadius: 4, padding: "12px 14px" }}>
                <p style={{ margin: 0, fontSize: 12.5, color: "var(--color-neutral-700)" }}>{q.label}</p>
                <p className="num" style={{ margin: "4px 0 8px", fontSize: 20, fontWeight: 300 }}>{q.v === null ? "—" : `${Math.round(q.v)}%`}</p>
                <div className="bar-track" style={{ height: 6 }}><div className="bar-fill" style={{ width: `${q.v ?? 0}%`, background: q.color }} /></div>
              </div>
            ))}
          </div>
          <p style={{ margin: "9px 0 0" }} className="small">
            {high === null ? "ยังไม่มีโปรเจกต์ในช่วงนี้" : high > 25 ? "Precision high กินโทเค็นวิดีโอราว 4 เท่าของ standard" : "ส่วนใหญ่อยู่ที่ standard ซึ่งเป็นค่าเริ่มต้น"}
          </p>
        </div>

        <WalletSection wallet={detail?.wallet ?? null} onAdjust={onWalletAdjust} />

        <RunsSection
          runs={detail ? detail.runs ?? [] : null}
          accuracy={detail?.estimate_accuracy ?? null}
          failed={detail?.failed_runs_30d ?? null}
          error={detailError}
        />

        <div style={{ padding: "20px 24px 0" }}>
          <p style={{ ...eyebrow, marginBottom: 10 }}>งานล่าสุด</p>
          {detailError && <p className="err" style={{ fontSize: 12.5 }}>{detailError}</p>}
          {!detail && !detailError && <p className="small">กำลังโหลด…</p>}
          {detail && detail.jobs.length === 0 && <p className="small">ยังไม่มีโปรเจกต์</p>}
          {detail && detail.jobs.length > 0 && (
            <table className="table" style={{ fontFamily: "inherit", fontSize: 12.5 }}>
              <thead>
                <tr>
                  <th>โปรเจกต์</th>
                  <th>โหมด</th>
                  <th style={{ textAlign: "right" }}>ฟุตเทจ</th>
                  <th style={{ textAlign: "right" }}>ต้นทุน</th>
                  <th style={{ textAlign: "right" }}>สถานะ</th>
                </tr>
              </thead>
              <tbody>
                {detail.jobs.map((j) => {
                  const failed = j.status === "error";
                  const done = j.status === "done" || j.status === "waiting_vo";
                  return (
                    <tr key={j.uid}>
                      <td>
                        {j.name ?? `โปรเจกต์ ${j.uid.slice(0, 8)}`}
                        <span style={{ display: "block", fontSize: 11.5, color: "var(--color-neutral-600)" }}>
                          {relDay(j.created_at)} · {j.engine ?? "—"} · {j.precision ?? "—"}
                        </span>
                      </td>
                      <td>{MODE_LABEL[j.mode] ?? j.mode}</td>
                      <td className="num" style={{ textAlign: "right" }}>{j.footage_sec === null ? "—" : `${Math.max(1, Math.round(j.footage_sec / 60))} นาที`}</td>
                      <td className="num" style={{ textAlign: "right" }}>{baht(jobCost(ctx, j))}</td>
                      <td style={{ textAlign: "right", color: failed ? LOSS : done ? OK : "var(--color-neutral-700)" }}>{STATUS_LABEL[j.status] ?? j.status}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ padding: "20px 24px 28px" }}>
          <p style={eyebrow}>สั่งงาน</p>
          <p style={{ margin: "0 0 7px", fontSize: 13, color: "var(--color-neutral-700)" }}>เปลี่ยนแผน</p>
          <Seg
            label="เปลี่ยนแผน"
            value={u.plan}
            onChange={(k) => { if (k !== u.plan) onPlan(k); }}
            options={PLAN_KEYS.map((k) => ({ value: k as string, label: planLabel(k) }))}
            style={{ marginBottom: 16, flexWrap: "wrap" }}
          />
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              className={`btn btn-secondary${u.active ? " btn-danger" : ""}`}
              onClick={onToggleActive}
              disabled={isSelf}
              title={isSelf ? "ปิดการใช้งานบัญชีของตัวเองไม่ได้" : undefined}
              style={{ fontFamily: "inherit", fontSize: 13 }}
            >
              {u.active ? "ปิดการใช้งานบัญชี" : "เปิดใช้งานบัญชีอีกครั้ง"}
            </button>
          </div>
          <p style={{ margin: "12px 0 0" }} className="small">
            {isSelf
              ? "นี่คือบัญชีของคุณเอง — ปิดการใช้งานตัวเองไม่ได้"
              : "ปิดบัญชีแล้วผู้ใช้จะออกจากระบบทุกเครื่องทันที ไฟล์และโปรเจกต์ยังอยู่ครบ"}
          </p>
        </div>
      </aside>
    </>
  );
}
