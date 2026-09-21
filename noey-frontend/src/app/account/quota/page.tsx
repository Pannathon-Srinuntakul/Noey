import type { Metadata } from "next";
import { formatBytes, formatThaiDateTime, isoDate } from "@/lib/format";
import { privatePageMetadata } from "@/lib/seo";
import { loadAccountData } from "@/lib/server/account-data";

export const metadata: Metadata = privatePageMetadata("โควตาและลิมิต");

/** Labels for GET /usage/me `by_task` buckets (backend USAGE_TASKS). */
const TASK_LABELS: Record<string, string> = {
  cut: "วางแผนตัดและสคริปต์พากย์",
  effects: "วางเอฟเฟกต์กล้อง",
  style: "สร้างสไตล์การตัด",
  other: "งานอื่น ๆ",
};

/*
 * Only real numbers from GET /usage/me (and /videos/storage) are rendered.
 * The design also shows a "5-hour window" meter, a "weekly cap" meter and a
 * per-type table with counts ("6 โปรเจกต์", "3 ครั้ง"). The backend has none
 * of those: its quota is ONE token budget per period (today: a UTC day,
 * `period_start` below) and `by_task` gives shares, not counts. Rather than
 * draw meters for limits that do not exist, this page shows the one real
 * meter, the real period start, and the real per-task shares.
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

  const pct = typeof usage.usage_pct === "number" ? Math.max(0, Math.min(100, usage.usage_pct)) : null;
  const tasks = (usage.by_task ?? []).filter((task) => task.pct > 0);
  const storagePct = storage && storage.quota_bytes > 0 ? Math.min(100, (storage.used_bytes / storage.quota_bytes) * 100) : null;

  return (
    <section className="account-grid" aria-label="โควตาและลิมิต">
      <div className="card account-card">
        <div className="card-kicker">รอบปัจจุบัน</div>
        {usage.unlimited ? (
          <p style={{ margin: "14px 0 22px", fontSize: 15 }}>แพลนนี้ไม่จำกัดโควตางาน AI</p>
        ) : (
          <>
            <div className="meter-row" style={{ marginTop: 14 }}>
              <span id="quota-label">โควตารอบปัจจุบัน</span>
              <span className="num">ใช้ไป {pct === null ? "—" : `${Math.round(pct)}%`}</span>
            </div>
            <div
              className="meter"
              role="progressbar"
              aria-labelledby="quota-label"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct === null ? undefined : Math.round(pct)}
            >
              <div className="meter__fill" style={{ width: `${pct ?? 0}%` }} />
            </div>
          </>
        )}
        <p className="meter-note">
          เริ่มนับรอบนี้เมื่อ <time dateTime={isoDate(usage.period_start)}>{formatThaiDateTime(usage.period_start) ?? "—"}</time>
        </p>
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
