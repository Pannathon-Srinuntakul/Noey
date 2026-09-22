"use client";

import { useState } from "react";
import { b0, baht, daysAgo, num } from "@/lib/format";
import type { Summary, UserMoney } from "@/lib/money";
import { PLAN_KEYS, planLabel } from "@/lib/plans";
import { LOSS, OK, Seg } from "./ui";

type SortKey = "email" | "plan" | "pays" | "cost" | "profit" | "clips" | "perClip" | "sttMin" | "failed" | "quota" | "last";

export interface UsersView {
  filter: "all" | "paying" | "free" | "idle";
  planFilter: string;
  q: string;
  threshold: number;
  sortKey: SortKey;
  sortDir: 1 | -1;
}

export const DEFAULT_USERS_VIEW: UsersView = { filter: "all", planFilter: "all", q: "", threshold: 150, sortKey: "cost", sortDir: -1 };

const COLUMNS: Array<[SortKey, string, "left" | "right"]> = [
  ["email", "ผู้ใช้", "left"], ["plan", "แผน", "left"], ["pays", "จ่าย", "right"], ["cost", "ต้นทุน", "right"],
  ["profit", "กำไร", "right"], ["clips", "คลิป", "right"], ["perClip", "ต้นทุน/คลิป", "right"],
  ["sttMin", "นาทีถอดเสียง", "right"], ["failed", "ล้มเหลว", "right"], ["quota", "โควตาวันนี้", "right"], ["last", "ใช้ล่าสุด", "right"],
];

function sortValue(u: UserMoney, k: SortKey): number | string {
  switch (k) {
    case "email": return u.email;
    case "plan": return PLAN_KEYS.indexOf(u.plan as (typeof PLAN_KEYS)[number]);
    case "pays": return u.pays;
    case "cost": return u.cost;
    case "profit": return u.profit;
    case "clips": return u.clips;
    case "perClip": return u.clips ? u.cost / u.clips : 0;
    case "sttMin": return u.sttMin;
    case "failed": return u.failed;
    case "quota": return u.quota_used_pct ?? -1;
    case "last": return u.last_active_days ?? 99_999;
  }
}

function userNote(u: UserMoney): string {
  if (u.internal) return "บัญชีผู้ดูแล · ไม่คิดเงิน";
  if (u.planPrice > 0 && !u.subscription.live) return "แผนที่ผู้ดูแลตั้งให้ ไม่มีการชำระเงิน";
  if (u.subscription.cancel_at_period_end) return "ยกเลิกเมื่อจบรอบบิล";
  if (!u.email_verified) return "ยังไม่ยืนยันอีเมล";
  if (u.last_active_days === null) return "สมัครแล้วไม่เคยใช้งาน";
  return u.created_at ? `สมัคร ${new Date(u.created_at).toLocaleDateString("th-TH", { day: "numeric", month: "short" })}` : "";
}

export function UsersTab({
  s, view, setView, periodLabel, onOpen,
}: {
  s: Summary;
  view: UsersView;
  setView: (v: UsersView) => void;
  periodLabel: string;
  onOpen: (id: number) => void;
}) {
  const [qDraft, setQDraft] = useState(view.q);
  let rows = s.all.slice();
  // By what the account actually pays, not its plan's list price: an
  // admin-granted plan and a deactivated account both sit on a priced plan
  // and pay nothing.
  if (view.filter === "paying") rows = rows.filter((u) => u.pays > 0);
  if (view.filter === "free") rows = rows.filter((u) => u.planPrice === 0);
  if (view.filter === "idle") rows = rows.filter((u) => u.last_active_days === null || u.last_active_days >= 14);
  if (view.planFilter !== "all") rows = rows.filter((u) => u.plan === view.planFilter);
  const q = view.q.trim().toLowerCase();
  if (q) rows = rows.filter((u) => u.email.toLowerCase().includes(q));
  rows.sort((a, b) => {
    const x = sortValue(a, view.sortKey);
    const y = sortValue(b, view.sortKey);
    if (typeof x === "string" && typeof y === "string") return x.localeCompare(y) * view.sortDir * -1;
    return ((x as number) - (y as number)) * view.sortDir;
  });

  const rt = {
    pays: rows.reduce((acc, u) => acc + u.pays, 0),
    cost: rows.reduce((acc, u) => acc + u.cost, 0),
    clips: rows.reduce((acc, u) => acc + u.clips, 0),
    sttMin: rows.reduce((acc, u) => acc + u.sttMin, 0),
    failed: rows.reduce((acc, u) => acc + u.failed, 0),
  };
  const td: React.CSSProperties = { textAlign: "right" };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <Seg
          label="กรองผู้ใช้"
          value={view.filter}
          onChange={(filter) => setView({ ...view, filter })}
          options={[
            { value: "all", label: "ทั้งหมด" }, { value: "paying", label: "จ่ายเงิน" },
            { value: "free", label: "ฟรี" }, { value: "idle", label: "ไม่ได้ใช้ 14 วัน" },
          ]}
        />
        <Seg
          label="กรองตามแผน"
          value={view.planFilter}
          onChange={(planFilter) => setView({ ...view, planFilter })}
          options={[{ value: "all", label: "ทุกแผน" }, ...PLAN_KEYS.map((k) => ({ value: k as string, label: planLabel(k) }))]}
        />
        <input
          className="input"
          type="search"
          aria-label="ค้นหาอีเมล"
          value={qDraft}
          onChange={(e) => { setQDraft(e.target.value); setView({ ...view, q: e.target.value.slice(0, 100) }); }}
          placeholder="ค้นหาอีเมล"
          style={{ width: 190, fontFamily: "inherit" }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto", fontSize: 13, color: "var(--color-neutral-700)" }}>
          <span>เตือนเมื่อต้นทุนต่อคนเกิน</span>
          <input
            className="input num"
            type="number"
            aria-label="เพดานต้นทุนต่อคน"
            value={view.threshold}
            min={0}
            onChange={(e) => setView({ ...view, threshold: Math.max(0, Number(e.target.value) || 0) })}
            style={{ width: 88, fontFamily: "inherit", textAlign: "right" }}
          />
          <span>บาท</span>
        </div>
      </div>

      <div style={{ border: "1px solid var(--color-divider)", borderRadius: 4, overflow: "auto" }}>
        <table className="table" style={{ fontFamily: "inherit", fontSize: 13.5, minWidth: 1040 }}>
          <thead>
            <tr>
              {COLUMNS.map(([k, label, align], i) => {
                const active = view.sortKey === k;
                return (
                  <th
                    key={k}
                    className="th-sort"
                    aria-sort={active ? (view.sortDir < 0 ? "descending" : "ascending") : "none"}
                    onClick={() => setView({ ...view, sortKey: k, sortDir: active ? (view.sortDir === 1 ? -1 : 1) : -1 })}
                    style={{
                      textAlign: align,
                      paddingLeft: i === 0 ? 16 : undefined,
                      paddingRight: i === COLUMNS.length - 1 ? 16 : undefined,
                      color: active ? "var(--color-accent-700)" : undefined,
                    }}
                  >
                    {label}{active ? (view.sortDir < 0 ? " ↓" : " ↑") : ""}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => {
              const over = u.cost > view.threshold;
              const note = !u.active ? "ปิดการใช้งานแล้ว" : over ? `เกินเพดาน ${baht(u.cost, 0)}` : userNote(u);
              return (
                <tr
                  key={u.id}
                  className="clickable-row"
                  tabIndex={0}
                  onClick={() => onOpen(u.id)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(u.id); } }}
                  style={{ opacity: u.active ? undefined : 0.5, boxShadow: over ? `inset 3px 0 0 ${LOSS}` : undefined }}
                >
                  <td style={{ paddingLeft: 16 }}>
                    <span style={{ display: "block" }}>{u.email}</span>
                    <span style={{ display: "block", fontSize: 12, marginTop: 2, color: !u.active || over ? LOSS : "var(--color-neutral-600)" }}>{note}</span>
                  </td>
                  <td><span className={`tag ${u.planPrice > 0 ? "tag-accent" : "tag-neutral"}`}>{planLabel(u.plan)}</span></td>
                  <td className="num" style={td}>{u.internal ? "—" : b0(u.pays)}</td>
                  <td className="num" style={td}>{baht(u.cost)}</td>
                  <td className="num" style={{ ...td, fontWeight: 500, color: u.internal ? "var(--color-neutral-600)" : u.profit >= 0 ? OK : LOSS }}>{u.internal ? "—" : baht(u.profit)}</td>
                  <td className="num" style={td}>{num(u.clips)}</td>
                  <td className="num" style={td}>{u.clips ? baht(u.cost / u.clips) : "—"}</td>
                  <td className="num" style={td}>{num(u.sttMin)}</td>
                  <td className="num" style={{ ...td, color: u.failed > 1 ? LOSS : "var(--color-neutral-700)" }}>{u.failed}</td>
                  <td className="num" style={td}>{u.quota_used_pct === null ? "ไม่จำกัด" : `${Math.round(u.quota_used_pct)}%`}</td>
                  <td className="num" style={{ ...td, paddingRight: 16, color: u.last_active_days === null || u.last_active_days >= 14 ? "var(--color-neutral-500)" : "var(--color-text)" }}>
                    {daysAgo(u.last_active_days)}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr style={{ background: "var(--color-neutral-100)" }}>
              <td style={{ paddingLeft: 16, fontWeight: 500 }}>รวม {rows.length} คน</td>
              <td />
              <td className="num" style={{ ...td, fontWeight: 500 }}>{b0(rt.pays)}</td>
              <td className="num" style={{ ...td, fontWeight: 500 }}>{baht(rt.cost)}</td>
              <td className="num" style={{ ...td, fontWeight: 500, color: rt.pays - rt.cost >= 0 ? OK : LOSS }}>{baht(rt.pays - rt.cost)}</td>
              <td className="num" style={{ ...td, fontWeight: 500 }}>{num(rt.clips)}</td>
              <td className="num" style={{ ...td, fontWeight: 500 }}>{rt.clips ? baht(rt.cost / rt.clips) : "—"}</td>
              <td className="num" style={{ ...td, fontWeight: 500 }}>{num(rt.sttMin)}</td>
              <td className="num" style={{ ...td, fontWeight: 500 }}>{rt.failed}</td>
              <td />
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <p style={{ margin: "12px 0 0" }} className="small">
        ตัวเลขตามช่วง {periodLabel} · กำไรรายคนยังไม่หักค่าคงที่ · คลิกหัวคอลัมน์เพื่อเรียง คลิกแถวเพื่อดูรายละเอียด
      </p>
    </div>
  );
}
