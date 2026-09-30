import type { Metadata } from "next";
import Link from "next/link";
import { ResetClock } from "@/components/account/ResetClock";
import { LevelMeter } from "@/components/ds/LevelMeter";
import { keepThaiProse } from "@/components/ds/ThaiText";
import { formatBytes } from "@/lib/format";
import { isTier, PLAN_COPY } from "@/lib/plans";
import { privatePageMetadata } from "@/lib/seo";
import { loadAccountData } from "@/lib/server/account-data";
import { clampPct, limitLabel, limitTone, neverResets, planLimitNote, resetInText, sortLimits, spentCreditText } from "@/lib/usage-limits";

export const metadata: Metadata = privatePageMetadata("โควตาและลิมิต");

/** Labels for GET /usage/me `by_task` buckets (backend USAGE_TASKS). */
const TASK_LABELS: Record<string, string> = {
  cut: "ถอดเสียง วางแผนตัด และสคริปต์พากย์",
  effects: "วางเอฟเฟกต์กล้อง",
  style: "สร้างสไตล์การตัด",
  other: "งานอื่น ๆ",
};


/*
 * Only real numbers from GET /usage/me (and /videos/storage) are rendered, and
 * never a token count — one percentage per window the plan actually enforces
 * (Free: Trial credit, a one-off `lifetime` window; Lite/Starter: Weekly; Pro+:
 * Weekly + 5-hour), with when it starts over. A window that carries
 * `resets: false` never starts over, so it gets the spent-credit line and an
 * upgrade link instead of a countdown. The design's per-type counts
 * ("6 โปรเจกต์") are not something the backend records, so the task table shows
 * shares only.
 */
export default async function QuotaPage() {
  const { usage, storage } = await loadAccountData("/account/quota", { usage: true, storage: true });

  if (!usage) {
    return (
      <div className="notice" role="status">
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
    <section className="account-grid acct-quota" aria-label="โควตาและลิมิต">
      <div className="card account-card">
        <div className="card-kicker">รอบปัจจุบัน</div>
        {usage.unlimited ? (
          <p className="acct-quota__empty">บัญชีนี้ไม่จำกัดโควตางาน AI</p>
        ) : limits.length === 0 ? (
          <p className="acct-quota__empty">ยังไม่มีข้อมูลโควตาของแพลนนี้</p>
        ) : (
          limits.map((limit) => {
            const pct = clampPct(limit.used_pct);
            const tone = limitTone(pct);
            const labelId = `limit-${limit.key}`;
            return (
              <div key={limit.key} className="acct-quota__limit">
                <div className="meter-row">
                  <span id={labelId}>{limitLabel(limit)}</span>
                  <span className={tone === "ok" ? "num" : `num num--${tone}`}>ใช้ไป {Math.round(pct)}%</span>
                </div>
                {/* An audio level meter (a real progress bar for assistive tech). */}
                <LevelMeter value={pct} labelledBy={labelId} />
                {neverResets(limit) ? (
                  <p className="meter-note">
                    {spentCreditText(pct)} <Link href="/pricing">ดูแพลนทั้งหมด</Link>
                  </p>
                ) : (
                  <p className="meter-note">
                    {resetInText(limit.active ? limit.resets_at : null)}
                    {limit.active ? <ResetClock at={limit.resets_at} /> : null}
                  </p>
                )}
              </div>
            );
          })
        )}

        {storage ? (
          <div className="acct-quota__limit">
            <div className="meter-row">
              <span id="storage-label">พื้นที่เก็บงาน</span>
              <span className="num">
                {formatBytes(storage.used_bytes)} / {storage.quota_bytes > 0 ? formatBytes(storage.quota_bytes) : "ไม่จำกัด"}
              </span>
            </div>
            {storagePct !== null ? <LevelMeter value={storagePct} labelledBy="storage-label" /> : null}
            <p className="meter-note">เก็บไว้ {storage.project_count} โปรเจกต์บนบัญชี</p>
          </div>
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
        {note ? <p className="meter-note">{keepThaiProse(note)}</p> : null}
      </div>

      <div className="card account-card">
        <div className="card-kicker">งานที่ใช้โควตาในรอบนี้</div>
        {tasks.length > 0 ? (
          <table className="table acct-tasks">
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
                  <td>{keepThaiProse(TASK_LABELS[task.task] ?? task.task)}</td>
                  <td className="r num">
                    <span className="acct-tasks__share">
                      <span className="acct-tasks__bar" aria-hidden="true">
                        <span style={{ width: `${Math.min(100, Math.max(0, task.pct))}%` }} />
                      </span>
                      {Math.round(task.pct)}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="acct-quota__empty">ยังไม่มีงานที่ใช้โควตาในรอบนี้</p>
        )}
        <p className="meter-note acct-tasks__note">{keepThaiProse("การแก้ไทม์ไลน์ การสลับช็อต และการเรนเดอร์ซ้ำ ไม่นับโควตา")}</p>
      </div>
    </section>
  );
}
