import type { Metadata } from "next";
import { IconArrowRight } from "@/components/ds/icons";
import { Waveform } from "@/components/ds/Waveform";
import { NoeyMark } from "@/components/NoeyMark";
import { formatBytes } from "@/lib/format";
import { planDisplayName } from "@/lib/plans";
import { privatePageMetadata } from "@/lib/seo";
import { loadAccountData } from "@/lib/server/account-data";
import { EDITOR_OPEN_PATH } from "@/lib/editor-handoff";

export const metadata: Metadata = privatePageMetadata("บัญชีของฉัน");

/**
 * The "ห้องตัดต่อ" tab. The editor card is the hero of the page — its
 * "เปิดห้องตัดต่อ" is the strongest button on it — with the account summary
 * beside it. The button stays a plain link (no prefetch: it hands off to the
 * editor through a redirect).
 */
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
        <div className="notice" role="status">
          <p>ตั้งรหัสผ่านใหม่เรียบร้อยแล้ว ตอนนี้เข้าสู่ระบบด้วยรหัสผ่านใหม่อยู่</p>
        </div>
      ) : null}
      {notice === "google-welcome" ? (
        <div className="notice" role="status">
          <p>สร้างบัญชีด้วย Google เรียบร้อยแล้ว ครั้งหน้ากด “เข้าสู่ระบบด้วย Google” ได้เลย</p>
          <p>บัญชีนี้ยังไม่มีรหัสผ่าน ถ้าอยากเข้าสู่ระบบด้วยอีเมลได้ด้วย ตั้งรหัสผ่านได้ที่หน้าข้อมูลส่วนตัว</p>
        </div>
      ) : null}
      <section className="account-grid acct-home" aria-label="ห้องตัดต่อและสรุปบัญชี">
        <div className="card account-card acct-hero">
          <div className="card-kicker">ห้องตัดต่อ</div>
          <div className="acct-hero__main">
            <div className="acct-hero__copy">
              <h2>งานทั้งหมดอยู่ในเบราว์เซอร์</h2>
              <p>โปรเจกต์ การสร้างงานใหม่ ไทม์ไลน์ และการอัดเสียงพากย์ อยู่ในห้องตัดต่อบนเว็บทั้งหมด ไม่ต้องติดตั้งโปรแกรม บัญชีเดียวกันนี้เข้าใช้ได้เลย</p>
              <a href={EDITOR_OPEN_PATH} className="btn btn-primary btn-lg acct-hero__open" data-magnetic="">
                เปิดห้องตัดต่อ
                <IconArrowRight size={18} />
              </a>
            </div>
            <div className="acct-hero__art" aria-hidden="true" data-play="">
              <span className="acct-hero__glow" />
              <NoeyMark size={88} className="acct-hero__mark" />
              <span className="acct-hero__track">
                <Waveform bars={48} seed={23} className="acct-hero__wave" />
                <span className="acct-hero__head" />
              </span>
            </div>
          </div>
        </div>
        <div className="card account-card acct-summary">
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
