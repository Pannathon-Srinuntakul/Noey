import type { Metadata } from "next";
import { BillingPanel, type UpgradeOption } from "@/components/account/BillingPanel";
import { formatCard, hasLiveSubscription, needsPaymentAttention, subscriptionLapsed, subscriptionStatusLabel } from "@/lib/billing";
import { formatThaiDate } from "@/lib/format";
import { MSG } from "@/lib/messages";
import { PAID_TIERS, PLAN_COPY, displayPrice, isPaidTier, isTier, planDisplayName, tierFromLookupKey, type PaidTier } from "@/lib/plans";
import { privatePageMetadata } from "@/lib/seo";
import { loadAccountData } from "@/lib/server/account-data";
import { getPriceTable } from "@/lib/server/prices";

export const metadata: Metadata = privatePageMetadata("แพลนและการชำระเงิน");

export default async function BillingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const [{ usage, billing, billingMissing }, table] = await Promise.all([
    loadAccountData("/account/billing", { usage: true, billing: true }),
    getPriceTable({ fallbackOnError: true }),
  ]);

  const billingEnabled = !!billing?.billing_enabled;
  const live = hasLiveSubscription(billing);
  const planValue = billing?.plan ?? usage?.plan ?? "free";
  const currentTier = live ? (tierFromLookupKey(table, billing?.lookup_key) ?? (isPaidTier(planValue) ? planValue : null)) : null;
  const periodEndLabel = formatThaiDate(billing?.current_period_end);
  const cancelScheduled = !!billing?.cancel_at_period_end;

  let statusLine: string | null = null;
  if (live && cancelScheduled) statusLine = periodEndLabel ? `ยกเลิกแล้ว ใช้ได้ถึง ${periodEndLabel} จากนั้นกลับเป็นแพลนฟรี` : "ยกเลิกแล้ว ใช้ได้จนจบรอบบิลนี้";
  else if (needsPaymentAttention(billing?.status)) statusLine = `${subscriptionStatusLabel(billing?.status)} อัปเดตบัตรได้ที่การ์ดการชำระเงิน`;
  else if (live && periodEndLabel) statusLine = `ต่ออายุอัตโนมัติ ${periodEndLabel}`;
  else if (subscriptionLapsed(billing?.status)) statusLine = "การชำระเงินของแพลนล่าสุดไม่สำเร็จ บัญชีจึงกลับมาใช้แพลนฟรี เลือกแพลนใหม่ได้จากปุ่มอัปเกรดแพลน";

  const options: UpgradeOption[] = PAID_TIERS.map((tier) => ({
    tier,
    name: PLAN_COPY[tier].name,
    price: displayPrice(table, tier),
    summary: PLAN_COPY[tier].dialogSummary,
    recommended: !!PLAN_COPY[tier].recommended,
    current: tier === currentTier && !cancelScheduled,
  }));

  // Preselected plan: the one picked on a plan button (?plan=pro); else, for a
  // subscriber, the next tier up; else the design's default (Pro); else the
  // first plan the user can actually switch to.
  const requested = typeof params.plan === "string" && isPaidTier(params.plan) ? params.plan : null;
  const selectable = options.filter((option) => !option.current && option.price !== null).map((option) => option.tier);
  const nextUp = currentTier ? PAID_TIERS.slice(PAID_TIERS.indexOf(currentTier) + 1).find((tier) => selectable.includes(tier)) : undefined;
  const initialPlan: PaidTier =
    requested && selectable.includes(requested)
      ? requested
      : (nextUp ?? (selectable.includes("pro") ? "pro" : (selectable[0] ?? "pro")));

  const fromSignup = params.from === "signup";
  // The backend's change-plan portal flow returns here with ?plan_change=done.
  // The plan shown may lag until Stripe's webhook reaches the backend.
  const planChangeDone = params.plan_change === "done";

  return (
    <>
      {/* Not configured (404/503 or billing_enabled=false) is a calm notice; any other failure says so plainly. */}
      {!billingEnabled ? (
        <div className="notice" role="status" style={{ marginTop: 32 }}>
          <p>
            {billing || billingMissing
              ? MSG.billingUnavailable
              : "ดึงข้อมูลการชำระเงินไม่ได้ในตอนนี้ ข้อมูลแพลนด้านล่างอาจยังไม่อัปเดต ลองรีเฟรชหน้านี้อีกครั้งในอีกสักครู่"}
          </p>
        </div>
      ) : null}
      {planChangeDone ? (
        <div className="notice" role="status" style={{ marginTop: 32 }}>
          <p>
            ยืนยันการเปลี่ยนแพลนแล้ว การอัปเกรดมีผลทันที ส่วนการลดแพลนมีผลเมื่อจบรอบบิลปัจจุบัน
            ถ้าแพลนด้านล่างยังไม่เปลี่ยน รีเฟรชหน้านี้อีกครั้งในอีกสักครู่
          </p>
        </div>
      ) : null}
      {fromSignup && requested ? (
        <div className="notice" role="status" style={{ marginTop: 32 }}>
          <p>
            {billingEnabled
              ? `สมัครบัญชีเรียบร้อยแล้ว ตอนนี้ใช้แพลนฟรีอยู่ กด “อัปเกรดแพลน” เพื่อไปหน้าชำระเงินของแพลน ${PLAN_COPY[requested].name} ได้เลย`
              : "สมัครบัญชีเรียบร้อยแล้ว ตอนนี้ใช้แพลนฟรีได้ทันที"}
          </p>
        </div>
      ) : null}
      <BillingPanel
        planName={planDisplayName(planValue)}
        planFeatures={isTier(planValue) ? PLAN_COPY[planValue].accountFeatures : []}
        statusLine={statusLine}
        statusWarn={needsPaymentAttention(billing?.status)}
        options={options}
        initialPlan={initialPlan}
        openUpgradeInitially={!!requested && !fromSignup}
        hasLiveSubscription={live}
        cancelScheduled={cancelScheduled}
        billingEnabled={billingEnabled}
        periodEndLabel={live ? periodEndLabel : null}
        cardLabel={formatCard(billing?.payment_method)}
      />
    </>
  );
}
