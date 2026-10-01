import type { Metadata } from "next";
import { BillingPanel, type UpgradeOption } from "@/components/account/BillingPanel";
import { formatCard, hasLiveSubscription, needsPaymentAttention, subscriptionLapsed, subscriptionStatusLabel } from "@/lib/billing";
import { formatShortDate, toDate } from "@/lib/format";
import { MSG } from "@/lib/messages";
import { BETA_PRICE_NOTE_SHORT, isBetaActive } from "@/lib/beta";
import {
  APPROX_CUTS_PER_MONTH,
  CLIPS_BASIS_SHORT,
  COMPARISON_ROWS,
  CUTS_APPROX_PREFIX,
  CUTS_APPROX_SHORT,
  FOOTAGE_PER_PROJECT,
  FREE_CLIPS_CAPTION,
  PAID_TIERS,
  PLAN_COPY,
  TIERS,
  clipsHighLine,
  displayPrice,
  isBetaPriced,
  isPaidTier,
  isTier,
  planDisplayName,
  strikePrice,
  tierFromLookupKey,
  type PaidTier,
  type Tier,
} from "@/lib/plans";
import { privatePageMetadata } from "@/lib/seo";
import { loadAccountData } from "@/lib/server/account-data";
import { getPriceTable } from "@/lib/server/prices";
import { keepThaiProse } from "@/components/ds/ThaiProse";

export const metadata: Metadata = privatePageMetadata("แพลนและการชำระเงิน");

/** A plan's place in the ladder, as /pricing's cards number it (P0 … P6). */
const reelOf = (tier: Tier) => `P${TIERS.indexOf(tier)}`;

/** A plan's monthly clips as /pricing's cards print them ("ตัดได้ราว 30 คลิป / เดือน"). */
const clipsSpec = (tier: PaidTier) => `${CUTS_APPROX_PREFIX} ${APPROX_CUTS_PER_MONTH[tier]} คลิป / เดือน`;

/** A plan's storage, from the comparison table's own row (the only place it is stated per plan). */
const STORAGE_ROW = COMPARISON_ROWS.find((row) => row.label === "พื้นที่เก็บงานบนบัญชี");
const storageOf = (tier: Tier) => STORAGE_ROW?.values[TIERS.indexOf(tier)] ?? null;

const DAY_MONTH = new Intl.DateTimeFormat("th-TH-u-ca-gregory", { day: "numeric", month: "short", timeZone: "Asia/Bangkok" });

/**
 * The billing cycle that ends at `end`: every plan bills monthly, so it began
 * one calendar month earlier (Stripe keeps the day, clamped to the shorter
 * month's last day). Where today sits in it, for the payment card's track.
 */
function billingCycle(endValue: string | number | null | undefined, now = Date.now()) {
  const end = toDate(endValue);
  if (!end) return null;
  const year = end.getUTCFullYear();
  const month = end.getUTCMonth() - 1;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const start = new Date(end);
  start.setUTCFullYear(year, month, Math.min(end.getUTCDate(), lastDay));
  const span = end.getTime() - start.getTime();
  if (span <= 0) return null;
  const progress = Math.min(1, Math.max(0, (now - start.getTime()) / span));
  const daysLeft = Math.max(0, Math.ceil((end.getTime() - now) / 86_400_000));
  return { startLabel: DAY_MONTH.format(start), endLabel: DAY_MONTH.format(end), progress, daysLeft };
}

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
  // Short month, Common Era year: the same calendar as the beta strip and the
  // plan dialog on this page ("31 ธ.ค. 2026").
  const periodEndLabel = formatShortDate(billing?.current_period_end);
  const cancelScheduled = !!billing?.cancel_at_period_end;

  let statusLine: string | null = null;
  if (live && cancelScheduled) statusLine = periodEndLabel ? `ยกเลิกแล้ว ใช้ได้ถึง ${periodEndLabel} จากนั้นกลับเป็นแพลนฟรี` : "ยกเลิกแล้ว ใช้ได้จนจบรอบบิลนี้";
  else if (needsPaymentAttention(billing?.status)) statusLine = `${subscriptionStatusLabel(billing?.status)} อัปเดตบัตรได้ที่การ์ดการชำระเงิน`;
  else if (live && periodEndLabel) statusLine = `ต่ออายุอัตโนมัติ ${periodEndLabel}`;
  else if (subscriptionLapsed(billing?.status)) statusLine = "การชำระเงินของแพลนล่าสุดไม่สำเร็จ บัญชีจึงกลับมาใช้แพลนฟรี เลือกแพลนใหม่ได้จากปุ่ม “เลือกแพลน”";

  // Every row of the plan picker states the same three things, so the plans
  // can be compared down the list.
  const options: UpgradeOption[] = PAID_TIERS.map((tier) => ({
    tier,
    reel: reelOf(tier),
    name: PLAN_COPY[tier].name,
    price: displayPrice(table, tier),
    fullPrice: strikePrice(table, tier),
    // Pro and up also state their ระดับละเอียด count, as a fact of its own (a
    // plan bought for that setting states both — lib/plans.ts).
    specs: [
      clipsSpec(tier),
      clipsHighLine(tier),
      `ฟุตเทจตัดฉากเด่น ${FOOTAGE_PER_PROJECT[tier]}ต่อโปรเจกต์`,
      storageOf(tier) ? `เก็บได้ ${storageOf(tier)}` : null,
    ].filter((spec): spec is string => !!spec),
    recommended: !!PLAN_COPY[tier].recommended,
    current: tier === currentTier && !cancelScheduled,
  }));

  // The plan card, drawn from the same parts and words as its /pricing card.
  const planTier: Tier | null = isTier(planValue) ? planValue : null;
  const plan = planTier
    ? {
        reel: reelOf(planTier),
        beta: live && isBetaActive() && strikePrice(table, planTier) !== null,
        usage: {
          prefix: planTier === "free" ? CUTS_APPROX_SHORT : CUTS_APPROX_PREFIX,
          count: APPROX_CUTS_PER_MONTH[planTier],
          unit: planTier === "free" ? "คลิป" : "คลิป / เดือน",
          caption: planTier === "free" ? FREE_CLIPS_CAPTION : null,
        },
        high: clipsHighLine(planTier),
        basis: CLIPS_BASIS_SHORT,
        features: PLAN_COPY[planTier].features,
      }
    : null;

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
        <div className="notice" role="status">
          <p>
            {keepThaiProse(
              billing || billingMissing
                ? MSG.billingUnavailable
                : "ดึงข้อมูลการชำระเงินไม่ได้ในตอนนี้ ข้อมูลแพลนด้านล่างอาจยังไม่อัปเดต ลองรีเฟรชหน้านี้อีกครั้งในอีกสักครู่",
            )}
          </p>
        </div>
      ) : null}
      {planChangeDone ? (
        <div className="notice" role="status">
          <p>
            {keepThaiProse(
              "ยืนยันการเปลี่ยนแพลนแล้ว การอัปเกรดมีผลทันที ส่วนการลดแพลนมีผลเมื่อจบรอบบิลปัจจุบัน ถ้าแพลนด้านล่างยังไม่เปลี่ยน รีเฟรชหน้านี้อีกครั้งในอีกสักครู่",
            )}
          </p>
        </div>
      ) : null}
      {fromSignup && requested ? (
        <div className="notice" role="status">
          <p>
            {keepThaiProse(
              billingEnabled
                ? `สมัครบัญชีเรียบร้อยแล้ว ตอนนี้ใช้แพลนฟรีอยู่ กด “เลือกแพลน” เพื่อไปหน้าชำระเงินของแพลน ${PLAN_COPY[requested].name} ได้เลย`
                : "สมัครบัญชีเรียบร้อยแล้ว ตอนนี้ใช้แพลนฟรีได้ทันที",
            )}
          </p>
        </div>
      ) : null}
      <BillingPanel
        planName={planDisplayName(planValue)}
        plan={plan}
        freePlan={planTier === "free" && !live}
        statusLine={statusLine}
        statusWarn={needsPaymentAttention(billing?.status)}
        options={options}
        initialPlan={initialPlan}
        openUpgradeInitially={!!requested && !fromSignup}
        hasLiveSubscription={live}
        cancelScheduled={cancelScheduled}
        billingEnabled={billingEnabled}
        periodEndLabel={live ? periodEndLabel : null}
        cycle={live ? billingCycle(billing?.current_period_end) : null}
        cardLabel={formatCard(billing?.payment_method)}
        betaNote={isBetaPriced(table) ? BETA_PRICE_NOTE_SHORT : null}
      />
    </>
  );
}
