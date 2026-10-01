"use client";

import Link from "next/link";
import { useActionState, useState, type CSSProperties } from "react";
import {
  cancelPlanAction,
  choosePlanAction,
  openPortalAction,
  resumePlanAction,
} from "@/app/actions/billing";
import { BETA_BADGE, BETA_DISCOUNT_PERCENT } from "@/lib/beta";
import type { ActionState } from "@/lib/messages";
import { PendingButton } from "../ui/PendingButton";
import type { PaidTier } from "@/lib/plans";
import { Dialog } from "../ui/Dialog";
import { keepThai } from "../ds/ThaiText";

export interface UpgradeOption {
  tier: PaidTier;
  /** The plan's place in the ladder, as /pricing numbers it ("P3"). */
  reel: string;
  name: string;
  /** Formatted price, or null when the backend does not list this tier. */
  price: string | null;
  /** Full price to strike through beside it during the beta; null otherwise. */
  fullPrice: string | null;
  /** The same facts on every row (footage, concurrency, storage), so plans compare down the list. */
  specs: readonly string[];
  current: boolean;
  /** Shows the "แนะนำ" tag (Pro). */
  recommended: boolean;
}

/** The plan card's parts, as /pricing's card prints them (plans.ts). */
export interface PlanCardParts {
  reel: string;
  /** The "เบต้า −50%" chip beside the struck price (a discounted plan, during the beta). */
  beta: boolean;
  /** The free plan's one-off nature ("ทดลองใช้ครั้งเดียว ไม่รีเซ็ต"); null on a paid plan. */
  caption: string | null;
  /**
   * No clip count here (owner, 2026-10-01): a count is pinned to one mode and
   * raw-clip length, so the card says what it depends on and links to
   * /pricing's calculator, where the reader can set both.
   */
  clips: { note: string; link: string; href: string };
  features: readonly string[];
}

/** This billing cycle: its two ends and where today is in it (0–1). */
export interface BillingCycle {
  startLabel: string;
  endLabel: string;
  progress: number;
  daysLeft: number;
}

export interface BillingPanelProps {
  planName: string;
  plan: PlanCardParts | null;
  /** On the free plan (no subscription): its price is 0 บาท, as on /pricing. */
  freePlan: boolean;
  statusLine: string | null;
  statusWarn: boolean;
  options: UpgradeOption[];
  initialPlan: PaidTier;
  openUpgradeInitially: boolean;
  hasLiveSubscription: boolean;
  cancelScheduled: boolean;
  billingEnabled: boolean;
  periodEndLabel: string | null;
  cycle: BillingCycle | null;
  cardLabel: string | null;
  /** One line about the beta price and what follows it; null once the beta ends. */
  betaNote: string | null;
}

/** The cancel dialog's opening words (the period's end follows them). */
const CANCEL_LEAD = "ยังใช้งานได้จนจบรอบบิลที่จ่ายไปแล้ว";

function Message({ state }: { state: ActionState | undefined }) {
  if (state?.error) {
    return (
      <p className="form-error" role="alert">
        {state.error}
      </p>
    );
  }
  if (state?.success) {
    return (
      <p className="form-success" role="status">
        {state.success}
      </p>
    );
  }
  return null;
}

/**
 * The beta terms over the plan picker, as the strip above /pricing's cards
 * draws them: the badge, the price line in bold, then what follows it — one
 * run of text beside the badge (the note is a flex row: loose pieces of text
 * would each become a column of their own).
 */
function BetaNoteLine({ text }: { text: string }) {
  const at = text.indexOf(" · ");
  return (
    <p className="beta-note beta-note--compact">
      <span className="tag tag-accent beta-note__badge">{BETA_BADGE}</span>
      <span>
        {at > 0 ? (
          <>
            <strong className="beta-note__lead">{text.slice(0, at)}</strong>
            <span className="beta-note__sep">{" \u00b7 "}</span>
            {keepThai(text.slice(at + 3))}
          </>
        ) : (
          keepThai(text)
        )}
      </span>
    </p>
  );
}

/**
 * The design's "แพลนและการชำระเงิน" tab: current-plan card with the upgrade
 * and cancel dialogs, and the payment card whose buttons open the Stripe
 * Customer Portal. When billing is not configured every pay button is
 * disabled (the page shows a notice above).
 */
export function BillingPanel(props: BillingPanelProps) {
  const {
    planName,
    plan,
    freePlan,
    statusLine,
    statusWarn,
    options,
    initialPlan,
    openUpgradeInitially,
    hasLiveSubscription,
    cancelScheduled,
    billingEnabled,
    periodEndLabel,
    cycle,
    cardLabel,
    betaNote,
  } = props;

  // Arriving from a plan button (/account/billing?plan=pro) opens the dialog with that plan picked.
  const [upgradeOpen, setUpgradeOpen] = useState(() => openUpgradeInitially && billingEnabled);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [selected, setSelected] = useState<PaidTier>(initialPlan);
  // Recurring-billing consent (design: payAgree). Checked again on the server.
  const [payAgreed, setPayAgreed] = useState(false);
  const [planState, planAction, planPending] = useActionState<ActionState | undefined, FormData>(choosePlanAction, undefined);
  const [cancelState, cancelAction, cancelPending] = useActionState<ActionState | undefined>(async () => {
    const result = await cancelPlanAction();
    if (result.ok) setCancelOpen(false);
    return result;
  }, undefined);
  const [resumeState, resumeAction, resumePending] = useActionState<ActionState | undefined>(resumePlanAction, undefined);
  const [portalState, portalAction, portalPending] = useActionState<ActionState | undefined>(openPortalAction, undefined);

  const selectedOption = options.find((option) => option.tier === selected);
  // The plan held, priced as /pricing prices it (the same table).
  const currentOption = hasLiveSubscription ? options.find((option) => option.current && option.price !== null) : undefined;
  const canSubmit = billingEnabled && !!selectedOption && !selectedOption.current && selectedOption.price !== null && payAgreed;
  // Before a first subscription there is no Stripe customer: the card is
  // added during Checkout, so "add card" starts the upgrade flow instead.
  const hasCustomer = hasLiveSubscription || !!cardLabel;
  // The period's end is printed once: when the plan card's status line
  // already carries it ("ต่ออายุอัตโนมัติ …", "ยกเลิกแล้ว ใช้ได้ถึง …"), the
  // payment card does not repeat it.
  const showPeriodEnd = !!periodEndLabel && !statusLine?.includes(periodEndLabel);
  // A plain renewal is said once — by the cycle track on the payment card,
  // which names the date and the days left; the plan card keeps a line only
  // for a state that needs one (cancelled, a payment problem).
  const renewalOnTrack = !!cycle && !cancelScheduled && !statusWarn && !!statusLine?.startsWith("ต่ออายุอัตโนมัติ");

  return (
    <section className="account-grid acct-billing" aria-label="แพลนและการชำระเงิน">
      <div className="card account-card acct-plan">
        <div className="card-kicker">แพลนปัจจุบัน</div>
        {/* The plan and its price beside its features when the card is wide. */}
        <div className="plan-body">
          <div className="plan-main">
            <div className="plan-head">
              {plan ? (
                <span className="trk tc" aria-hidden="true">
                  {plan.reel}
                </span>
              ) : null}
              <span className="plan-name">{planName}</span>
            </div>
            {currentOption || freePlan ? (
              <div className="plan-price">
                {currentOption?.fullPrice ? <s className="num price-strike">{currentOption.fullPrice}</s> : null}
                <span className="num plan-price__value">{currentOption ? currentOption.price : "0"}</span>
                <span className="plan-price__unit">{currentOption ? "บาท / เดือน" : "บาท"}</span>
                {currentOption && plan?.beta ? <span className="tag tag-accent plan-price__beta">{`${BETA_BADGE} −${BETA_DISCOUNT_PERCENT}%`}</span> : null}
              </div>
            ) : null}
            {statusLine && !renewalOnTrack ? <p className={statusWarn ? "plan-status plan-status--warn" : "plan-status"}>{keepThai(statusLine)}</p> : null}
            {plan ? (
              <div className="plan-usage">
                {plan.caption ? <p className="plan-usage__caption">{keepThai(plan.caption)}</p> : null}
                <p className="plan-usage__basis">
                  {keepThai(plan.clips.note)}{" "}
                  <Link href={plan.clips.href}>
                    {keepThai(plan.clips.link)}
                  </Link>
                </p>
              </div>
            ) : null}
          </div>
          {plan && plan.features.length > 0 ? (
            <ul className="plan-features">
              {/* A copy line joins facts with " · "; here each fact is its own
                  ticked row, so no line ends on a dot. A piece with no words of
                  its own ("10 GB") stays with the fact it qualifies. */}
              {plan.features
                .flatMap((feature) =>
                  feature.split(" · ").reduce<string[]>((facts, piece) => {
                    if (facts.length > 0 && !/[\u0E00-\u0E7F]/.test(piece)) facts[facts.length - 1] += ` · ${piece}`;
                    else facts.push(piece);
                    return facts;
                  }, []),
                )
                .map((fact) => (
                  <li key={fact}>{keepThai(fact)}</li>
                ))}
            </ul>
          ) : null}
        </div>
        <div className="button-row">
          <button type="button" className="btn btn-primary" onClick={() => setUpgradeOpen(true)} disabled={!billingEnabled}>
            {hasLiveSubscription ? "เปลี่ยนแพลน" : "เลือกแพลน"}
          </button>
          {/* Cancelling is there, but quieter than changing plan. */}
          {hasLiveSubscription && !cancelScheduled ? (
            <button type="button" className="btn btn-ghost" onClick={() => setCancelOpen(true)} disabled={!billingEnabled}>
              ยกเลิกแพลน
            </button>
          ) : null}
          {hasLiveSubscription && cancelScheduled ? (
            <form action={resumeAction}>
              <PendingButton className="btn btn-secondary" disabled={!billingEnabled || resumePending} busy={resumePending} busyLabel="กำลังดำเนินการ…">
                ใช้แพลนนี้ต่อ
              </PendingButton>
            </form>
          ) : null}
        </div>
        {/* Only the message that matches the CURRENT state (after cancel -> resume, the cancel note is stale). */}
        <div aria-live="polite">
          {resumeState?.error ? <Message state={resumeState} /> : null}
          {resumeState?.ok && !cancelScheduled ? <Message state={resumeState} /> : null}
          {cancelState?.ok && cancelScheduled ? <Message state={cancelState} /> : null}
        </div>
      </div>

      <div className="card account-card acct-pay">
        <div className="card-kicker">การชำระเงิน</div>
        {cycle ? (
          // The cycle as a clip on a lane: gold up to today, the playhead on
          // today, its two dates at its ends (the period end is the renewal,
          // or the last day of a cancelled plan).
          <div
            className="acct-cycle"
            role="img"
            aria-label={`รอบบิลนี้ ${cycle.startLabel} ถึง ${cycle.endLabel} ${cancelScheduled ? "ใช้ได้อีก" : "ต่ออายุในอีก"} ${cycle.daysLeft} วัน`}
          >
            <div className="acct-cycle__top">
              <span className="acct-cycle__title">รอบบิลนี้</span>
              <span className="acct-cycle__left">{`${cancelScheduled ? "ใช้ได้อีก" : "ต่ออายุในอีก"} ${cycle.daysLeft} วัน`}</span>
            </div>
            <div className="acct-cycle__lane" style={{ "--cycle": cycle.progress } as CSSProperties}>
              <span className="acct-cycle__fill" />
              <span className="acct-cycle__head">
                <span className="acct-cycle__today">วันนี้</span>
              </span>
            </div>
            <div className="acct-cycle__ends">
              <span>{cycle.startLabel}</span>
              <span>{cancelScheduled ? `ใช้ได้ถึง ${cycle.endLabel}` : cycle.endLabel}</span>
            </div>
          </div>
        ) : null}
        <dl className="kv">
          <div>
            <dt>วิธีชำระเงิน</dt>
            <dd>{cardLabel ?? "ยังไม่ได้ผูกบัตร"}</dd>
          </div>
          {showPeriodEnd ? (
            <div>
              <dt>{cancelScheduled ? "ใช้แพลนได้ถึง" : "รอบบิลถัดไป"}</dt>
              <dd>{periodEndLabel}</dd>
            </div>
          ) : null}
          <div>
            <dt>ใบเสร็จย้อนหลัง</dt>
            <dd>
              <form action={portalAction} className="inline-form">
                <PendingButton className="link-button" disabled={!billingEnabled || portalPending} busy={portalPending} busyLabel="กำลังเปิด…">
                  ดูรายการ
                </PendingButton>
              </form>
            </dd>
          </div>
        </dl>
        {/* Before a first subscription: where the card comes from. */}
        {!hasCustomer ? <p className="meter-note acct-pay__note">{keepThai("บัตรจะผูกกับบัญชีตอนชำระเงินครั้งแรก")}</p> : null}
        {hasCustomer ? (
          <form action={portalAction} className="inline-form">
            <PendingButton
              className="btn btn-secondary acct-pay__btn"
              disabled={!billingEnabled || portalPending}
              busy={portalPending}
              busyLabel={cardLabel ? "เปลี่ยนบัตร" : "เพิ่มบัตรเครดิต"}
            >
              {cardLabel ? "เปลี่ยนบัตร" : "เพิ่มบัตรเครดิต"}
            </PendingButton>
          </form>
        ) : (
          <button
            type="button"
            className="btn btn-secondary acct-pay__btn"
            disabled={!billingEnabled}
            onClick={() => setUpgradeOpen(true)}
          >
            เพิ่มบัตรเครดิต
          </button>
        )}
        <div aria-live="polite">
          <Message state={portalState} />
        </div>
      </div>

      <Dialog
        open={upgradeOpen}
        onClose={() => setUpgradeOpen(false)}
        title={hasLiveSubscription ? "เปลี่ยนแพลน" : "เลือกแพลน"}
        description={
          <>
            <p style={{ margin: 0 }}>
              {keepThai(
                hasLiveSubscription
                  ? "เลือกแพลนที่ต้องการ อัปเกรดแล้วโควตาใหม่มีผลทันที ส่วนการลดแพลนมีผลในรอบบิลถัดไป"
                  : "เลือกแพลนที่ต้องการ โควตาใหม่มีผลทันทีหลังชำระเงิน",
              )}
            </p>
            {/* Up here, not under the list: below it the note scrolled out of view. */}
            {betaNote ? <BetaNoteLine text={betaNote} /> : null}
          </>
        }
      >
        <form action={planAction}>
          <fieldset className="plan-options">
            <legend className="sr-only">แพลน</legend>
            {options.map((option) => (
              <label key={option.tier} className={option.current ? "radio plan-option plan-option--current" : "radio plan-option"}>
                <input
                  type="radio"
                  name="plan"
                  value={option.tier}
                  checked={selected === option.tier}
                  onChange={() => setSelected(option.tier)}
                  disabled={option.current || option.price === null}
                />
                <span className="dot" />
                <span className="plan-option__text">
                  <span className="plan-option__name">
                    <span className="trk tc" aria-hidden="true">
                      {option.reel}
                    </span>
                    <span className="plan-option__plan">{option.name}</span>
                    {option.price === null ? (
                      <span className="plan-option__price">ยังไม่เปิดขาย</span>
                    ) : (
                      <span className="plan-option__price">
                        {option.fullPrice ? <s className="price-strike">{option.fullPrice}</s> : null}
                        {`${option.price} บาท / เดือน`}
                      </span>
                    )}
                    {option.current ? <span className="tag tag-neutral plan-option__tag">แพลนปัจจุบัน</span> : null}
                    {/* "แนะนำ" suggests a move; on the plan already held it says nothing. */}
                    {option.recommended && !option.current ? <span className="tag tag-outline plan-option__tag">แนะนำ</span> : null}
                  </span>
                  {/* Each fact whole on its line; no "·" left at a line's end. */}
                  <span className="plan-option__specs">
                    {option.specs.map((spec) => (
                      <span key={spec} className="plan-option__spec">
                        {spec}
                      </span>
                    ))}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <Message state={planState} />
          {/* The consent sits in the sticky footer, beside the button it unlocks. */}
          <div className="dialog-actions">
            <label className="agree agree--flush dialog-actions__consent">
              <input
                type="checkbox"
                name="pay_agree"
                value="yes"
                className="agree__box"
                checked={payAgreed}
                onChange={(event) => setPayAgreed(event.target.checked)}
              />
              <span className="agree__text">
                {keepThai("ฉันเข้าใจว่าระบบจะเรียกเก็บเงินทุกเดือนโดยอัตโนมัติจนกว่าจะยกเลิก และยอมรับ ")}
                <Link href="/terms">เงื่อนไขการใช้งาน</Link> {keepThai("เรื่องค่าบริการและการคืนเงิน")}
              </span>
            </label>
            <button type="button" className="btn btn-secondary" onClick={() => setUpgradeOpen(false)}>
              ยกเลิก
            </button>
            <PendingButton className="btn btn-primary" disabled={!canSubmit || planPending} busy={planPending} busyLabel="กำลังไปหน้าชำระเงิน…">
              ไปหน้าชำระเงิน
            </PendingButton>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="ยกเลิกแพลน"
        maxWidth={460}
        description={
          <p style={{ margin: 0 }}>
            {/* The date in one piece with the words it closes: "ที่จ่ายไปแล้ว (ถึง 13 ต.ค. 2026)". */}
            {periodEndLabel ? (
              <>
                {keepThai(CANCEL_LEAD.slice(0, CANCEL_LEAD.indexOf("ที่จ่าย")))}
                <span className="kt">{`${CANCEL_LEAD.slice(CANCEL_LEAD.indexOf("ที่จ่าย"))} (ถึง ${periodEndLabel})`}</span>
              </>
            ) : (
              keepThai(CANCEL_LEAD)
            )}
            {keepThai(
              " หลังจากนั้นบัญชีจะกลับไปเป็นแพลนฟรี โปรเจกต์ที่เกินโควตาแพลนฟรีจะเปิดอ่านได้แต่แก้ต่อไม่ได้จนกว่าจะลบให้เหลือตามจำนวน",
            )}
          </p>
        }
      >
        <form action={cancelAction}>
          {cancelState?.error ? <Message state={cancelState} /> : null}
          <div className="dialog-actions dialog-actions--tight">
            <button type="button" className="btn btn-secondary" onClick={() => setCancelOpen(false)}>
              ใช้ต่อ
            </button>
            <PendingButton className="btn btn-ghost" disabled={cancelPending} busy={cancelPending} busyLabel="กำลังยกเลิก…">
              ยืนยันยกเลิก
            </PendingButton>
          </div>
        </form>
      </Dialog>
    </section>
  );
}
