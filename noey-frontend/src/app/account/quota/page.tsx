import type { Metadata } from "next";
import { ResetClock } from "@/components/account/ResetClock";
import { formatBytes } from "@/lib/format";
import { isTier, PLAN_COPY } from "@/lib/plans";
import { privatePageMetadata } from "@/lib/seo";
import { loadAccountData } from "@/lib/server/account-data";
import { clampPct, limitLabel, limitTone, planLimitNote, resetInText, sortLimits } from "@/lib/usage-limits";

export const metadata: Metadata = privatePageMetadata("โควตาและลิมิต");

/** Labels for GET /usage/me `by_task` buckets (backend USAGE_TASKS). */
const TASK_LABELS: Record<string, string> = {
  cut: "ถอดเสียง วางแผนตัด และสคริปต์พากย์",
  effects: "วางเอฟเฟกต์กล้อง",
  style: "สร้างสไตล์การตัด",
  other: "งานอื่น ๆ",
};

const TONE_COLOR = { full: "var(--color-danger, #a33a34)", near: "var(--color-accent)", ok: undefined } as const;

/*
 * Only real numbers from GET /usage/me (and /videos/storage) are rendered, and
 * never a token count — one percentage per window the plan actually enforces
 * (Free: Monthly; Lite/Starter: Weekly; Pro+: Weekly + 5-hour), with when it
 * starts over. The design's per-type counts ("6 โปรเจกต์") are not something
 * the backend records, so the task table shows shares only.
 */
export default async function QuotaPage() {
  const { usage, storage } = await loadAccountData("/account/quota", { usage: true, storage: true });

  if (!usage) {
    return (
      <div className="notice" style={{ marginTop: 32 }} role="status">
        <p>ยังดึงข้อมูลโควตาไม่ได้ในตอนนี้ ลองรีเฟรชหน้านี้อีกครั้งในอีกสักครู่</p>
      </div>
    );
  }

  const limits = sortLimits(usage.limits ?? []);
  const note = planLimitNote(usage.plan);
  const tasks = (usage.by_task ?? []).filter((task) => task.pct > 0);
  const storagePct = storage && storage.quota_bytes > 0 ? Math.min(100, (storage.used_bytes / storage.quota_bytes) * 100) : null;
  const walletBaht = usage.wallet ? usage.wallet.balance_satang / 100 : null;
  const pendingName = usage.pending_plan && isTier(usage.pending_plan.plan) ? PLAN_COPY[usage.pending_plan.plan].name : null;

  return (
    <section className="account-grid" aria-label="โควตาและลิมิต">
      <div className="card account-card">
        <div className="card-kicker">รอบปัจจุบัน</div>
        {usage.unlimited ? (
          <p style={{ margin: "14px 0 22px", fontSize: 15 }}>บัญชีนี้ไม่จำกัดโควตางาน AI</p>
        ) : limits.length === 0 ? (
          <p style={{ margin: "14px 0 22px", fontSize: 15 }}>ยังไม่มีข้อมูลโควตาของแพลนนี้</p>
        ) : (
          limits.map((limit, i) => {
            const pct = clampPct(limit.used_pct);
            const color = TONE_COLOR[limitTone(pct)];
            const labelId = `limit-${limit.key}`;
            return (
              <div key={limit.key}>
                <div className="meter-row" style={i === 0 ? { marginTop: 14 } : undefined}>
                  <span id={labelId}>{limitLabel(limit)}</span>
                  <span className="num" style={color ? { color } : undefined}>
                    ใช้ไป {Math.round(pct)}%
                  </span>
                </div>
                <div
                  className="meter"
                  role="progressbar"
                  aria-labelledby={labelId}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(pct)}
                >
                  <div className="meter__fill" style={{ width: `${pct}%`, ...(color ? { background: color } : {}) }} />
                </div>
                <p className="meter-note">
                  {resetInText(limit.active ? limit.resets_at : null)}
                  {limit.active ? <ResetClock at={limit.resets_at} /> : null}
                </p>
              </div>
            );
          })
        )}

        {storage ? (
          <>
            <div className="meter-row">
              <span id="storage-label">พื้นที่เก็บงาน</span>
              <span className="num">
                {formatBytes(storage.used_bytes)} / {storage.quota_bytes > 0 ? formatBytes(storage.quota_bytes) : "ไม่จำกัด"}
              </span>
            </div>
            {storagePct !== null ? (
              <div
                className="meter"
                role="progressbar"
                aria-labelledby="storage-label"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(storagePct)}
              >
                <div className="meter__fill" style={{ width: `${storagePct}%` }} />
              </div>
            ) : null}
            <p className="meter-note">เก็บไว้ {storage.project_count} โปรเจกต์บนบัญชี</p>
          </>
        ) : null}

        {usage.concurrency && usage.concurrency.max > 0 ? (
          <p className="meter-note">ทำงาน AI พร้อมกันได้ {usage.concurrency.max} งาน</p>
        ) : null}
        {walletBaht !== null ? (
          <p className="meter-note">
            ยอดเงินเติมคงเหลือ ฿{walletBaht.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ·
            ใช้ต่อได้เมื่อโควตาของแพลนหมด
          </p>
        ) : null}
        {pendingName ? <p className="meter-note">เปลี่ยนเป็นแพลน {pendingName} เมื่อจบรอบบิลนี้</p> : null}
        {note ? <p className="meter-note">{note}</p> : null}
      </div>

      <div className="card account-card">
        <div className="card-kicker">งานที่ใช้โควตาในรอบนี้</div>
        {tasks.length > 0 ? (
          <table className="table" style={{ marginTop: 14 }}>
            <thead>
              <tr>
                <th scope="col">งาน</th>
                <th scope="col" className="r">
                  สัดส่วน
                </th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.task}>
                  <td>{TASK_LABELS[task.task] ?? task.task}</td>
                  <td className="r num">{Math.round(task.pct)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p style={{ margin: "14px 0 0", fontSize: 15, color: "var(--color-neutral-800)" }}>ยังไม่มีงานที่ใช้โควตาในรอบนี้</p>
        )}
        <p className="meter-note" style={{ marginTop: 16 }}>
          การแก้ไทม์ไลน์ การสลับช็อต และการเรนเดอร์ซ้ำ ไม่นับโควตา
        </p>
      </div>
    </section>
  );
}
