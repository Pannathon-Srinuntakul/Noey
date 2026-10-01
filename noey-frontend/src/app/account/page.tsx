import type { Metadata } from "next";
import Link from "next/link";
import { IconArrowRight, IconChevronRight } from "@/components/ds/icons";
import { LevelMeter } from "@/components/ds/LevelMeter";
import { Waveform } from "@/components/ds/Waveform";
import { ComputerOnly } from "@/components/ComputerOnly";
import { NoeyMark } from "@/components/NoeyMark";
import { hasLiveSubscription, needsPaymentAttention, subscriptionStatusLabel } from "@/lib/billing";
import { formatBytes, formatShortDate } from "@/lib/format";
import { planDisplayName } from "@/lib/plans";
import { privatePageMetadata } from "@/lib/seo";
import { loadAccountData } from "@/lib/server/account-data";
import { EDITOR_OPEN_PATH } from "@/lib/editor-handoff";
import { keepThaiProse } from "@/components/ds/ThaiProse";
import { limitLabel, limitTone } from "@/lib/usage-limits";

export const metadata: Metadata = privatePageMetadata("บัญชีของฉัน");

/**
 * The "บัญชีของฉัน" tab. The editor card is the hero of the page — its
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
  // The window the number is about, by its name on the quota tab: the only
  // one a paid plan has ("Monthly limit"), or the fullest when there are more.
  const fullest = [...(usage?.limits ?? [])].sort((a, b) => b.used_pct - a.used_pct)[0];
  const quotaName = !usage?.unlimited && fullest ? limitLabel(fullest) : "โควตารอบนี้";
  // Under the plan: when it renews, or until when a cancelled one runs.
  const periodEnd = hasLiveSubscription(billing) ? formatShortDate(billing?.current_period_end) : null;
  const renewal = periodEnd ? (billing?.cancel_at_period_end ? `ใช้ได้ถึง ${periodEnd}` : `ต่ออายุ ${periodEnd}`) : null;
  const quotaPct = !usage?.unlimited && typeof usage?.usage_pct === "number" ? usage.usage_pct : null;
  // The same warning tones as the quota tab (80% near, 95% full).
  const quotaTone = quotaPct === null ? "ok" : limitTone(quotaPct);
  const storagePct = storage && storage.quota_bytes > 0 ? Math.min(100, (storage.used_bytes / storage.quota_bytes) * 100) : null;

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
              <p>
                {keepThaiProse(
                  "โปรเจกต์ การสร้างงานใหม่ และไทม์ไลน์ อยู่ในห้องตัดต่อบนเว็บทั้งหมด ไม่ต้องติดตั้งโปรแกรม บัญชีเดียวกันนี้เข้าใช้ได้เลย",
                )}
              </p>
              {/* On a phone or a tablet only (its own rule), above the button. */}
              <ComputerOnly />
              <a href={EDITOR_OPEN_PATH} className="btn btn-primary btn-lg acct-hero__open" data-magnetic="">
                เปิดห้องตัดต่อ
                <IconArrowRight size={18} />
              </a>
            </div>
            <div className="acct-hero__art" aria-hidden="true" data-play="">
              <span className="acct-hero__glow" />
              <NoeyMark size={88} className="acct-hero__mark" />
              <span className="acct-hero__track">
                {/* One bar pitch whatever the lane's width (account.css picks one). */}
                <Waveform bars={48} seed={23} className="acct-hero__wave acct-hero__wave--short" still />
                <Waveform bars={120} seed={23} className="acct-hero__wave acct-hero__wave--long" still />
                <Waveform bars={72} seed={23} className="acct-hero__wave acct-hero__wave--mid" still />
                <span className="acct-hero__head" />
              </span>
            </div>
          </div>
        </div>
        <div className="card account-card acct-summary">
          <div className="card-kicker">สรุปบัญชี</div>
          {/* Each row opens the tab that holds its detail; the levels are the
              quota tab's own meters (LevelMeter: one rule for both), small. */}
          <dl className="kv acct-summary__rows">
            <div>
              <dt>แพลนปัจจุบัน</dt>
              <dd>
                <Link href="/account/billing" className="acct-summary__link">
                  {plan ? planDisplayName(plan) : "—"}
                  <IconChevronRight size={15} />
                </Link>
              </dd>
              {/* A failed charge is said here too, not only on the billing tab
                  (the same sentence the billing tab shows). */}
              {/* A second <dd> for the same term (a <p> is not allowed in a <dl>'s group). */}
              {needsPaymentAttention(billing?.status) ? (
                <dd className="acct-summary__warn">
                  {keepThaiProse(`${subscriptionStatusLabel(billing?.status)} อัปเดตบัตรได้ที่การ์ดการชำระเงิน`)}
                </dd>
              ) : renewal ? (
                <dd className="acct-summary__sub">{keepThaiProse(renewal)}</dd>
              ) : null}
            </div>
            <div>
              <dt>{quotaName}</dt>
              <dd className={quotaTone === "ok" ? "num" : `num num--${quotaTone}`}>
                <Link href="/account/quota" className="acct-summary__link">
                  {quota}
                  <IconChevronRight size={15} />
                </Link>
              </dd>
              {quotaPct !== null ? <LevelMeter value={quotaPct} className="acct-summary__meter" /> : null}
            </div>
            {storage ? (
              <div>
                <dt>พื้นที่เก็บงาน</dt>
                <dd className="num">
                  {/* Storage is detailed on the quota tab too. */}
                  <Link href="/account/quota" className="acct-summary__link">
                    {formatBytes(storage.used_bytes)} / {storage.quota_bytes > 0 ? formatBytes(storage.quota_bytes) : "ไม่จำกัด"}
                    <IconChevronRight size={15} />
                  </Link>
                </dd>
                {storagePct !== null ? <LevelMeter value={storagePct} className="acct-summary__meter" /> : null}
              </div>
            ) : null}
          </dl>
        </div>
      </section>
    </>
  );
}
