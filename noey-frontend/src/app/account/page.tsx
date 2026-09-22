import type { Metadata } from "next";
import { formatBytes } from "@/lib/format";
import { planDisplayName } from "@/lib/plans";
import { privatePageMetadata } from "@/lib/seo";
import { loadAccountData } from "@/lib/server/account-data";
import { APP_URL } from "@/lib/site";

export const metadata: Metadata = privatePageMetadata("บัญชีของฉัน");

export default async function AccountAppPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { notice } = await searchParams;
  const { usage, billing, storage } = await loadAccountData("/account", { usage: true, billing: true, storage: true });
  const plan = billing?.plan ?? usage?.plan ?? null;

  let quota = "—";
  if (usage?.unlimited) quota = "ไม่จำกัด";
  else if (typeof usage?.usage_pct === "number") quota = `ใช้ไป ${Math.round(usage.usage_pct)}%`;

  return (
    <>
      {notice === "password-reset" ? (
        <div className="notice" role="status" style={{ marginTop: 32 }}>
          <p>ตั้งรหัสผ่านใหม่เรียบร้อยแล้ว ตอนนี้เข้าสู่ระบบด้วยรหัสผ่านใหม่อยู่</p>
        </div>
      ) : null}
      <section className="account-grid" aria-label="ห้องตัดต่อและสรุปบัญชี">
        <div className="card account-card">
          <div className="card-kicker">ห้องตัดต่อ</div>
          <h2>งานทั้งหมดอยู่ในเบราว์เซอร์</h2>
          <p>โปรเจกต์ การสร้างงานใหม่ ไทม์ไลน์ และการอัดเสียงพากย์ อยู่ในห้องตัดต่อบนเว็บทั้งหมด ไม่ต้องติดตั้งโปรแกรม บัญชีเดียวกันนี้เข้าใช้ได้เลย</p>
          <a href={APP_URL} className="btn btn-primary btn-lg" style={{ alignSelf: "flex-start" }}>
            เปิดห้องตัดต่อ
          </a>
        </div>
        <div className="card account-card">
          <div className="card-kicker">สรุปบัญชี</div>
          <dl className="kv">
            <div>
              <dt>แพลนปัจจุบัน</dt>
              <dd>{plan ? planDisplayName(plan) : "—"}</dd>
            </div>
            <div>
              <dt>โควตารอบนี้</dt>
              <dd className="num">{quota}</dd>
            </div>
            {storage ? (
              <div>
                <dt>พื้นที่เก็บงาน</dt>
                <dd className="num">
                  {formatBytes(storage.used_bytes)} / {storage.quota_bytes > 0 ? formatBytes(storage.quota_bytes) : "ไม่จำกัด"}
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
      </section>
    </>
  );
}
