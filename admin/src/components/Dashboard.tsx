"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import {
  getDashboardAction,
  getUserDetailAction,
  idleLogoutAction,
  logoutAction,
  resetQuotaAction,
  resetWindowAction,
  saveCostConfigAction,
  savePricesAction,
  setActiveAction,
  setPlanAction,
  walletAdjustAction,
  type ActionResult,
} from "@/app/actions";
import { WINDOW_LABELS } from "@/lib/billing";
import { b0, baht, num } from "@/lib/format";
import { ctxFrom, forecastDefaults, priceAt, pricesFromSatang, summarize, type ForecastIn } from "@/lib/money";
import { PAID_KEYS, planLabel } from "@/lib/plans";
import type { CostConfig, DashboardData, UserDetail } from "@/lib/types";
import { CostsTab } from "./CostsTab";
import { OverviewTab } from "./OverviewTab";
import { PlansTab } from "./PlansTab";
import { PricingTab } from "./PricingTab";
import { ConfirmDialog, Seg, type ConfirmSpec } from "./ui";
import { UserDrawer } from "./UserDrawer";
import { DEFAULT_USERS_VIEW, UsersTab, type UsersView } from "./UsersTab";

type Tab = "overview" | "users" | "plans" | "costs" | "pricing";
type Period = "today" | "7d" | "30d" | "custom";

const TABS: Array<[Tab, string]> = [
  ["overview", "ภาพรวม"], ["users", "ผู้ใช้"], ["plans", "แผน"], ["costs", "ต้นทุน"], ["pricing", "ราคาและแผน"],
];
const MAX_DAYS = 366;

function shift(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function spanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

function rangeFor(period: Period, today: string, custom: { from: string; to: string }): { from: string; to: string } | null {
  if (period === "today") return { from: today, to: today };
  if (period === "7d") return { from: shift(today, -6), to: today };
  if (period === "30d") return { from: shift(today, -29), to: today };
  const n = spanDays(custom.from, custom.to);
  return Number.isFinite(n) && n >= 1 && n <= MAX_DAYS && custom.to <= today ? custom : null;
}

function costDiff(saved: CostConfig, d: CostConfig, today: string): string[] {
  const lines: string[] = [];
  if (saved.fx_rate !== d.fx_rate) lines.push(`อัตราแลกเปลี่ยน ฿${saved.fx_rate.toFixed(2)} → ฿${d.fx_rate.toFixed(2)}`);
  for (const key of new Set([...Object.keys(saved.models), ...Object.keys(d.models)])) {
    const a = saved.models[key];
    const b = d.models[key];
    if (!a && b) lines.push(`${key} — ตั้งราคา $${b.input}/$${b.output}`);
    else if (a && b && JSON.stringify(a) !== JSON.stringify(b)) {
      const [pa, pb] = [priceAt(a, today), priceAt(b, today)];
      lines.push(`${key} — $${pa.input}/$${pa.output} → $${pb.input}/$${pb.output}`);
    }
  }
  for (const key of new Set([...Object.keys(saved.stt), ...Object.keys(d.stt)])) {
    const a = saved.stt[key];
    const b = d.stt[key];
    if (!b) continue;
    if (!a || a.usd_per_hour !== b.usd_per_hour || a.keyterms_usd_per_hour !== b.keyterms_usd_per_hour) {
      const before = a ? `$${a.usd_per_hour} + $${a.keyterms_usd_per_hour}` : "ราคาตั้งต้น";
      lines.push(`ถอดเสียง ${key} — ${before} → $${b.usd_per_hour} + $${b.keyterms_usd_per_hour} ต่อชั่วโมง`);
    }
  }
  for (const x of saved.fixed) {
    const y = d.fixed.find((z) => z.id === x.id);
    if (!y) lines.push(`ลบ ${x.label}`);
    else if (y.label !== x.label || y.value !== x.value) lines.push(`${y.label} — ${b0(x.value)} → ${b0(y.value)}`);
  }
  for (const y of d.fixed) if (!saved.fixed.find((x) => x.id === y.id)) lines.push(`เพิ่ม ${y.label || "รายการใหม่"} ${b0(y.value)}`);
  const basis = { user: "ต่อคน", clip: "ต่อคลิป" };
  for (const x of saved.per_user) {
    const y = d.per_user.find((z) => z.id === x.id);
    if (!y) lines.push(`ลบ ${x.label}`);
    else if (y.label !== x.label || y.value !== x.value || y.basis !== x.basis) lines.push(`${y.label} — ฿${x.value} ${basis[x.basis]} → ฿${y.value} ${basis[y.basis]}`);
  }
  for (const y of d.per_user) if (!saved.per_user.find((x) => x.id === y.id)) lines.push(`เพิ่ม ${y.label || "รายการใหม่"} ฿${y.value} ${basis[y.basis]}`);
  if (saved.vat_included !== d.vat_included) lines.push(d.vat_included ? "ราคาแผนรวม VAT แล้ว" : "ราคาแผนไม่รวม VAT");
  if (saved.include_internal !== d.include_internal) lines.push(d.include_internal ? "นับบัญชีผู้ดูแลในยอดรวม" : "ไม่นับบัญชีผู้ดูแลในยอดรวม");
  return lines;
}

export function Dashboard({ initial, adminEmail, idleMs }: { initial: DashboardData; adminEmail: string; idleMs: number }) {
  const [data, setData] = useState(initial);
  const [tab, setTab] = useState<Tab>("overview");
  const [period, setPeriod] = useState<Period>("30d");
  const [custom, setCustom] = useState({ from: initial.period.from, to: initial.period.to });
  const [loading, startLoad] = useTransition();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draftCost, setDraftCost] = useState<CostConfig | null>(null);
  const [draftPrices, setDraftPrices] = useState<Record<string, number> | null>(null);
  const [usersView, setUsersView] = useState<UsersView>(DEFAULT_USERS_VIEW);
  const [sel, setSel] = useState<number | null>(null);
  const [detail, setDetail] = useState<{ id: number; data: UserDetail | null; error: string | null } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [fc, setFc] = useState<ForecastIn | null>(null);

  const savedPrices = useMemo(() => pricesFromSatang(data.prices.satang), [data.prices.satang]);
  const cfg = draftCost ?? data.cost_config;
  const ctx = useMemo(() => ctxFrom(data, cfg, savedPrices), [data, cfg, savedPrices]);
  const s = useMemo(() => summarize(ctx, data.users), [ctx, data.users]);
  const fcDefaults = useMemo(() => forecastDefaults(ctx, s), [ctx, s]);

  const say = useCallback((msg: string) => setToast(msg), []);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(t);
  }, [toast]);

  const signedOut = useCallback(() => {
    // /signout is a Route Handler that clears the HttpOnly cookies — a full
    // navigation, not a client-side route change.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/signout");
  }, []);

  function handle<T>(r: ActionResult<T>): r is { ok: true; data: T } {
    if (r.ok) return true;
    if (r.signedOut) signedOut();
    else say(r.error);
    return false;
  }

  const load = useCallback(
    (range: { from: string; to: string }) => {
      startLoad(async () => {
        const r = await getDashboardAction(range.from, range.to);
        if (r.ok) {
          setData(r.data);
          setLoadError(null);
        } else if (r.signedOut) signedOut();
        else setLoadError(r.error);
      });
    },
    [signedOut],
  );

  const currentRange = () => rangeFor(period, data.today, custom) ?? { from: data.period.from, to: data.period.to };

  function choosePeriod(p: Period) {
    setPeriod(p);
    const range = rangeFor(p, data.today, custom);
    if (range) load(range);
  }

  function setCustomRange(next: { from: string; to: string }) {
    setCustom(next);
    const range = rangeFor("custom", data.today, next);
    if (range) load(range);
    else setLoadError(`ช่วงวันที่ต้องไม่เกิน ${MAX_DAYS} วัน และไม่เลยวันนี้`);
  }

  async function openUser(id: number) {
    setSel(id);
    setDetail({ id, data: null, error: null });
    const r = await getUserDetailAction(id);
    if (r.ok) setDetail({ id, data: r.data, error: null });
    else if (r.signedOut) signedOut();
    else setDetail({ id, data: null, error: r.error });
  }

  // Idle logout: the backend ends an unused admin session after the same
  // time; this makes the browser leave instead of failing on the next click.
  useEffect(() => {
    let timer = window.setTimeout(() => void idleLogoutAction(), idleMs);
    let last = Date.now();
    const bump = () => {
      const now = Date.now();
      if (now - last < 5_000) return;
      last = now;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void idleLogoutAction(), idleMs);
    };
    const events = ["pointerdown", "keydown", "wheel", "touchstart", "pointermove"] as const;
    for (const e of events) window.addEventListener(e, bump, { passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const e of events) window.removeEventListener(e, bump);
    };
  }, [idleMs]);

  useEffect(() => {
    if (sel === null || confirm) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSel(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel, confirm]);

  async function runConfirm() {
    if (!confirm) return;
    setBusy(true);
    try {
      await confirm.ok();
    } finally {
      setBusy(false);
    }
  }

  async function afterWrite(message: string, userId?: number) {
    setConfirm(null);
    say(message);
    load(currentRange());
    if (userId !== undefined && sel === userId) {
      const r = await getUserDetailAction(userId);
      if (r.ok) setDetail({ id: userId, data: r.data, error: null });
    }
  }

  const selUser = sel === null ? null : s.all.find((u) => u.id === sel) ?? null;
  const days = data.period.days;
  const periodLabel =
    period === "today" ? "วันนี้" : period === "7d" ? "7 วันล่าสุด" : period === "30d" ? "30 วันล่าสุด" : `${data.period.from} ถึง ${data.period.to}`;

  const priceDraft = draftPrices ?? savedPrices;
  const priceDirty = !!draftPrices && PAID_KEYS.some((k) => Number(draftPrices[k]) !== Number(savedPrices[k]));
  const costDirty = !!draftCost && JSON.stringify(draftCost) !== JSON.stringify(data.cost_config);
  const exportHref = `/export?from=${data.period.from}&to=${data.period.to}`;

  return (
    <div className="page">
      <header className="top">
        <div className="wrap top-row">
          <span className="brand">
            Noey Studio
            <span className="brand-kicker">แผงผู้ดูแลระบบ</span>
          </span>
          <Seg
            label="ช่วงเวลา"
            value={period}
            onChange={choosePeriod}
            options={[
              { value: "today", label: "วันนี้" }, { value: "7d", label: "7 วัน" },
              { value: "30d", label: "30 วัน" }, { value: "custom", label: "กำหนดเอง" },
            ]}
          />
          {period === "custom" && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <input className="input" type="date" aria-label="ตั้งแต่วันที่" value={custom.from} max={data.today}
                onChange={(e) => e.target.value && setCustomRange({ ...custom, from: e.target.value })} style={{ width: 148, fontFamily: "inherit" }} />
              <span style={{ color: "var(--color-neutral-600)" }}>ถึง</span>
              <input className="input" type="date" aria-label="ถึงวันที่" value={custom.to} max={data.today}
                onChange={(e) => e.target.value && setCustomRange({ ...custom, to: e.target.value })} style={{ width: 148, fontFamily: "inherit" }} />
            </div>
          )}
          <a className="btn btn-secondary" href={exportHref} download onClick={() => say(`ส่งออก ${s.all.length} แถวเป็น CSV แล้ว`)}
            style={{ fontFamily: "inherit", fontSize: 13 }}>
            ส่งออก CSV
          </a>
          <span style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--color-neutral-700)" }}>
            {adminEmail}
            <button
              type="button"
              className="btn btn-ghost"
              style={{ fontFamily: "inherit", fontSize: 13 }}
              onClick={() => setConfirm({
                title: "ออกจากระบบ", body: adminEmail, lines: ["ต้องยืนยันรหัส OTP อีกครั้งเมื่อกลับเข้ามา"],
                okLabel: "ออกจากระบบ", danger: true, ok: () => logoutAction(),
              })}
            >
              ออกจากระบบ
            </button>
          </span>
        </div>
        <div className="wrap" style={{ display: "flex", gap: 26 }}>
          <nav className="tabs" role="tablist" aria-label="ส่วนของแผงผู้ดูแล">
            {TABS.map(([k, label]) => (
              <button key={k} type="button" role="tab" className="tab-btn" aria-selected={tab === k} onClick={() => setTab(k)}>
                {label}
              </button>
            ))}
          </nav>
          <span className="num" style={{ marginLeft: "auto", alignSelf: "center", fontSize: 12.5, color: "var(--color-neutral-600)" }}>
            {loading ? "กำลังโหลด…" : `${periodLabel} · ${days} วัน · ${s.counted.length} บัญชี`}
          </span>
        </div>
      </header>

      <main className={`wrap${loading ? " loading" : ""}`} style={{ paddingTop: 24 }}>
        {loadError && (
          <p role="alert" className="err" style={{ margin: "0 0 16px", fontSize: 13 }}>{loadError}</p>
        )}
        {tab === "overview" && <OverviewTab ctx={ctx} s={s} data={data} />}
        {tab === "users" && <UsersTab s={s} view={usersView} setView={setUsersView} periodLabel={periodLabel} onOpen={openUser} />}
        {tab === "plans" && <PlansTab s={s} prices={savedPrices} onOpen={openUser} />}
        {tab === "costs" && (
          <CostsTab
            ctx={ctx}
            s={s}
            data={data}
            cfg={cfg}
            setCfg={setDraftCost}
            dirty={costDirty}
            onCancel={() => setDraftCost(null)}
            handle={handle}
            onFxChange={(fx) => setData((d) => ({ ...d, fx: { usd_thb: fx.usd_thb, source: fx.source } }))}
            ask={setConfirm}
            done={(msg) => { setConfirm(null); say(msg); }}
            onSave={() => {
              if (!draftCost) return;
              const lines = costDiff(data.cost_config, draftCost, data.today);
              setConfirm({
                title: "บันทึกค่าต้นทุน", body: "ทุกตัวเลขในหน้านี้จะคิดใหม่ตามค่านี้",
                lines: lines.length ? lines : ["ไม่มีการเปลี่ยนแปลง"], okLabel: "บันทึก",
                ok: async () => {
                  const r = await saveCostConfigAction(draftCost);
                  if (!handle(r)) return;
                  setData((d) => ({ ...d, cost_config: r.data }));
                  setDraftCost(null);
                  setConfirm(null);
                  say("บันทึกค่าต้นทุนแล้ว");
                },
              });
            }}
          />
        )}
        {tab === "pricing" && (
          <PricingTab
            ctx={ctx}
            s={s}
            data={data}
            draft={priceDraft}
            setDraft={setDraftPrices}
            dirty={priceDirty}
            onCancel={() => setDraftPrices(null)}
            fc={fc ?? fcDefaults}
            setFc={(f) => { setFc(f); if (f === null) say("คืนค่าคาดการณ์แล้ว"); }}
            fcDefaults={fcDefaults}
            handle={handle}
            ask={setConfirm}
            onBillingSaved={(bc) => {
              setData((d) => ({ ...d, billing_config: bc }));
              setConfirm(null);
              say("บันทึกราคาต่อโทเค็นแล้ว");
            }}
            onSave={() => {
              if (!draftPrices) return;
              const changed = PAID_KEYS.filter((k) => Number(draftPrices[k]) !== Number(savedPrices[k]));
              const bad = changed.find((k) => !Number.isInteger(draftPrices[k]) || draftPrices[k] < 1 || draftPrices[k] > 100_000);
              if (bad) {
                say(`ราคา ${planLabel(bad)} ต้องเป็นจำนวนเต็ม 1–100,000 บาท`);
                return;
              }
              const affected = s.all.filter((u) => changed.includes(u.plan as (typeof PAID_KEYS)[number]) && !u.internal && u.subscription.live).length;
              setConfirm({
                title: "เปลี่ยนราคาแผน",
                body:
                  data.prices.source === "stripe"
                    ? `ราคาใหม่ใช้กับการสมัครครั้งต่อไป · สมาชิกเดิม ${affected} คนยังจ่ายราคาเดิมจนกว่าจะเปลี่ยนแผน`
                    : "ราคาใหม่แสดงบนหน้าราคาของเว็บทันที",
                lines: changed.map((k) => `${planLabel(k)} — ${b0(savedPrices[k])} → ${b0(draftPrices[k])}`),
                okLabel: "เปลี่ยนราคา",
                danger: true,
                ok: async () => {
                  const r = await savePricesAction(Object.fromEntries(changed.map((k) => [k, draftPrices[k]])));
                  if (!handle(r)) return;
                  setDraftPrices(null);
                  await afterWrite(r.data.siteRefreshed ? "เปลี่ยนราคาแผนแล้ว หน้าราคาของเว็บอัปเดตแล้ว" : "เปลี่ยนราคาแผนแล้ว");
                },
              });
            }}
          />
        )}
      </main>

      {selUser && (
        <UserDrawer
          u={selUser}
          ctx={ctx}
          detail={detail && detail.id === selUser.id ? detail.data : null}
          detailError={detail && detail.id === selUser.id ? detail.error : null}
          isSelf={selUser.id === data.admin_user_id}
          onClose={() => setSel(null)}
          onPlan={(k) => {
            const lines = [
              `${planLabel(selUser.plan)} → ${planLabel(k)}`,
              k === "enterprise" ? "Enterprise ไม่คิดเงินผ่านระบบ" : `ค่าบริการ ${b0(savedPrices[selUser.plan] ?? 0)} → ${b0(savedPrices[k] ?? 0)}/เดือน`,
              "โควตาและเพดานฟุตเทจเปลี่ยนตามแผนใหม่ทันที",
            ];
            if (selUser.subscription.live && k !== "enterprise") {
              lines.push("มีการสมัครสมาชิกที่ชำระเงินอยู่ — Stripe จะปรับแผนกลับตามการสมัครเมื่อมีการเปลี่ยนแปลงครั้งถัดไป ใช้ Enterprise สำหรับบัญชีที่ให้ฟรี");
            }
            setConfirm({
              title: "เปลี่ยนแผนผู้ใช้", body: selUser.email, lines, okLabel: "เปลี่ยนแผน",
              danger: Number(savedPrices[k] ?? 0) < Number(savedPrices[selUser.plan] ?? 0),
              ok: async () => {
                const r = await setPlanAction(selUser.id, k);
                if (handle(r)) await afterWrite(`เปลี่ยนแผนเป็น ${planLabel(k)} แล้ว`, selUser.id);
              },
            });
          }}
          onResetQuota={() => {
            const windows = (detail?.data?.limits ?? selUser).windows ?? [];
            setConfirm({
              title: "รีเซ็ตทุกช่วง", body: selUser.email,
              lines: [
                ...windows.map((w) => `${WINDOW_LABELS[w.key]} ${Math.round(w.used_pct)}% → 0%`),
                "Monthly ที่นับไว้เบื้องหลังก็เริ่มใหม่ด้วย · ทุกช่วงเริ่มนับเมื่อใช้ครั้งถัดไป",
                "โทเค็นที่ใช้ก่อนหน้านี้ยังอยู่ในต้นทุน · บันทึกในประวัติผู้ดูแล",
              ],
              okLabel: "รีเซ็ตทุกช่วง",
              ok: async () => {
                const r = await resetQuotaAction(selUser.id);
                if (handle(r)) await afterWrite("รีเซ็ตทุกช่วงแล้ว", selUser.id);
              },
            });
          }}
          onResetWindow={(key) => {
            const w = ((detail?.data?.limits ?? selUser).windows ?? []).find((x) => x.key === key);
            setConfirm({
              title: `รีเซ็ต ${WINDOW_LABELS[key]}`, body: selUser.email,
              lines: [
                w ? `ใช้ไป ${Math.round(w.used_pct)}% (${num(w.used_tokens)} จาก ${num(w.limit_tokens)} โทเค็น) → 0%` : "ช่วงนี้จะเริ่มนับใหม่",
                "เริ่มนับใหม่เมื่อใช้ครั้งถัดไป · งานที่จองโควตาไว้ยังค้างอยู่",
                "โทเค็นที่ใช้ก่อนหน้านี้ยังอยู่ในต้นทุน · บันทึกในประวัติผู้ดูแล",
              ],
              okLabel: "รีเซ็ต",
              ok: async () => {
                const r = await resetWindowAction(selUser.id, key);
                if (handle(r)) await afterWrite(`รีเซ็ต ${WINDOW_LABELS[key]} แล้ว`, selUser.id);
              },
            });
          }}
          onWalletAdjust={(satang, note) => {
            const balance = detail?.data?.wallet?.balance_satang ?? selUser.wallet_balance_satang ?? 0;
            const after = Math.max(0, balance + satang);
            setConfirm({
              title: satang > 0 ? "เพิ่มยอดเงินเติม" : "หักยอดเงินเติม", body: selUser.email,
              lines: [
                `${satang > 0 ? "เพิ่ม" : "หัก"} ${baht(Math.abs(satang) / 100)} · ยอด ${baht(balance / 100)} → ${baht(after / 100)}`,
                `เหตุผล: ${note}`,
                satang > 0 ? "เป็นก้อนใหม่อายุ 12 เดือน" : "หักได้ไม่เกินยอดที่มี",
              ],
              okLabel: satang > 0 ? "เพิ่มยอด" : "หักยอด",
              danger: satang < 0,
              ok: async () => {
                const r = await walletAdjustAction(selUser.id, satang, note);
                if (handle(r)) await afterWrite("ปรับยอดเงินเติมแล้ว", selUser.id);
              },
            });
          }}
          onToggleActive={() =>
            setConfirm({
              title: selUser.active ? "ปิดการใช้งานบัญชี" : "เปิดใช้งานบัญชี",
              body: selUser.email,
              lines: selUser.active
                ? ["เข้าสู่ระบบไม่ได้ทันที และทุกเครื่องที่ล็อกอินอยู่จะถูกออกจากระบบ", "ไฟล์และโปรเจกต์ยังอยู่ครบ", "เปิดคืนได้ทุกเมื่อ"]
                : [`กลับมาใช้งานได้ตามแผน ${planLabel(selUser.plan)} · ต้องเข้าสู่ระบบใหม่`],
              okLabel: selUser.active ? "ปิดการใช้งาน" : "เปิดใช้งาน",
              danger: selUser.active,
              ok: async () => {
                const r = await setActiveAction(selUser.id, !selUser.active);
                if (handle(r)) await afterWrite(selUser.active ? "ปิดการใช้งานบัญชีแล้ว" : "เปิดใช้งานบัญชีแล้ว", selUser.id);
              },
            })
          }
        />
      )}

      {confirm && <ConfirmDialog spec={confirm} busy={busy} onCancel={() => setConfirm(null)} onOk={() => void runConfirm()} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
