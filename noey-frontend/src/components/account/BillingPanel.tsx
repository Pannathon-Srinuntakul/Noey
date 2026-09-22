"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import {
  cancelPlanAction,
  choosePlanAction,
  openPortalAction,
  resumePlanAction,
} from "@/app/actions/billing";
import type { ActionState } from "@/lib/messages";
import type { PaidTier } from "@/lib/plans";
import { Dialog } from "../ui/Dialog";

export interface UpgradeOption {
  tier: PaidTier;
  name: string;
  /** Formatted price, or null when the backend does not list this tier. */
  price: string | null;
  summary: string;
  current: boolean;
  /** Shows the "แนะนำ" tag (Pro). */
  recommended: boolean;
}

export interface BillingPanelProps {
  planName: string;
  planFeatures: readonly string[];
  statusLine: string | null;
  statusWarn: boolean;
  options: UpgradeOption[];
  initialPlan: PaidTier;
  openUpgradeInitially: boolean;
  hasLiveSubscription: boolean;
  cancelScheduled: boolean;
  billingEnabled: boolean;
  periodEndLabel: string | null;
  cardLabel: string | null;
}

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
 * The design's "แพลนและการชำระเงิน" tab: current-plan card with the upgrade
 * and cancel dialogs, and the payment card whose buttons open the Stripe
 * Customer Portal. When billing is not configured every pay button is
 * disabled (the page shows a notice above).
 */
export function BillingPanel(props: BillingPanelProps) {
  const {
    planName,
    planFeatures,
    statusLine,
    statusWarn,
    options,
    initialPlan,
    openUpgradeInitially,
    hasLiveSubscription,
    cancelScheduled,
    billingEnabled,
    periodEndLabel,
    cardLabel,
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
  const canSubmit = billingEnabled && !!selectedOption && !selectedOption.current && selectedOption.price !== null && payAgreed;
  // Before a first subscription there is no Stripe customer: the card is
  // added during Checkout, so "add card" starts the upgrade flow instead.
  const hasCustomer = hasLiveSubscription || !!cardLabel;

  return (
    <section className="account-grid" aria-label="แพลนและการชำระเงิน">
      <div className="card account-card">
        <div className="card-kicker">แพลนปัจจุบัน</div>
        <div className="plan-name">{planName}</div>
        {statusLine ? (
          <p className="plan-status" style={statusWarn ? { color: "var(--color-danger)" } : undefined}>
            {statusLine}
          </p>
        ) : null}
        {planFeatures.length > 0 ? (
          <ul className="price-card__features" style={{ marginBottom: 20 }}>
            {planFeatures.map((feature) => (
              <li key={feature}>{feature}</li>
            ))}
          </ul>
        ) : null}
        <div className="button-row">
          <button type="button" className="btn btn-primary" style={{ fontSize: 14 }} onClick={() => setUpgradeOpen(true)} disabled={!billingEnabled}>
            {hasLiveSubscription ? "เปลี่ยนแพลน" : "เลือกแพลน"}
          </button>
          {hasLiveSubscription && !cancelScheduled ? (
            <button type="button" className="btn btn-ghost" style={{ fontSize: 14 }} onClick={() => setCancelOpen(true)} disabled={!billingEnabled}>
              ยกเลิกแพลน
            </button>
          ) : null}
          {hasLiveSubscription && cancelScheduled ? (
            <form action={resumeAction}>
              <button type="submit" className="btn btn-ghost" style={{ fontSize: 14 }} disabled={!billingEnabled || resumePending}>
                {resumePending ? "กำลังดำเนินการ…" : "ใช้แพลนนี้ต่อ"}
              </button>
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

      <div className="card account-card">
        <div className="card-kicker">การชำระเงิน</div>
        <dl className="kv" style={{ marginTop: 12 }}>
          <div>
            <dt>วิธีชำระเงิน</dt>
            <dd>{cardLabel ?? "ยังไม่ได้ผูกบัตร"}</dd>
          </div>
          <div>
            <dt>{cancelScheduled ? "ใช้แพลนได้ถึง" : "รอบบิลถัดไป"}</dt>
            <dd>{periodEndLabel ?? "—"}</dd>
          </div>
          <div>
            <dt>ใบเสร็จย้อนหลัง</dt>
            <dd>
              <form action={portalAction} style={{ margin: 0 }}>
                <button type="submit" className="link-button" disabled={!billingEnabled || portalPending}>
                  {portalPending ? "กำลังเปิด…" : "ดูรายการ"}
                </button>
              </form>
            </dd>
          </div>
        </dl>
        {hasCustomer ? (
          <form action={portalAction} style={{ margin: 0 }}>
            <button type="submit" className="btn btn-secondary btn-block" style={{ fontSize: 14, marginTop: 20 }} disabled={!billingEnabled || portalPending}>
              {cardLabel ? "เปลี่ยนบัตร" : "เพิ่มบัตรเครดิต"}
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="btn btn-secondary btn-block"
            style={{ fontSize: 14, marginTop: 20 }}
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
          <p style={{ margin: 0 }}>
            {hasLiveSubscription
              ? "เลือกแพลนที่ต้องการ อัปเกรดแล้วโควตาใหม่มีผลทันที ส่วนการลดแพลนมีผลในรอบบิลถัดไป"
              : "เลือกแพลนที่ต้องการ โควตาใหม่มีผลทันทีหลังชำระเงิน"}
          </p>
        }
      >
        <form action={planAction}>
          <fieldset className="plan-options" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="sr-only">แพลน</legend>
            {options.map((option) => (
              <label key={option.tier} className="radio plan-option">
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
                    {option.name} · {option.price === null ? "ยังไม่เปิดขาย" : `${option.price} บาท/เดือน`}
                    {option.current ? " · แพลนปัจจุบัน" : ""}
                    {option.recommended ? <span className="tag tag-outline plan-option__tag">แนะนำ</span> : null}
                  </span>
                  <span className="plan-option__meta">{option.summary}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="agree agree--flush">
            <input
              type="checkbox"
              name="pay_agree"
              value="yes"
              className="agree__box"
              checked={payAgreed}
              onChange={(event) => setPayAgreed(event.target.checked)}
            />
            <span className="agree__text">
              ฉันเข้าใจว่าระบบจะเรียกเก็บเงินทุกเดือนโดยอัตโนมัติจนกว่าจะยกเลิก และยอมรับ <Link href="/terms">เงื่อนไขการใช้งาน</Link>{" "}
              เรื่องค่าบริการและการคืนเงิน
            </span>
          </label>
          <Message state={planState} />
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setUpgradeOpen(false)}>
              ยกเลิก
            </button>
            <button type="submit" className="btn btn-primary" disabled={!canSubmit || planPending} aria-busy={planPending || undefined}>
              {planPending ? "กำลังไปหน้าชำระเงิน…" : "ไปหน้าชำระเงิน"}
            </button>
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
            ยังใช้งานได้จนจบรอบบิลที่จ่ายไปแล้ว{periodEndLabel ? ` (ถึง ${periodEndLabel})` : ""} หลังจากนั้นบัญชีจะกลับไปเป็นแพลนฟรี
            โปรเจกต์ที่เกินโควตาแพลนฟรีจะเปิดอ่านได้แต่แก้ต่อไม่ได้จนกว่าจะลบให้เหลือตามจำนวน
          </p>
        }
      >
        <form action={cancelAction}>
          {cancelState?.error ? <Message state={cancelState} /> : null}
          <div className="dialog-actions" style={{ marginTop: 4 }}>
            <button type="button" className="btn btn-secondary" onClick={() => setCancelOpen(false)}>
              ใช้ต่อ
            </button>
            <button type="submit" className="btn btn-ghost" disabled={cancelPending} aria-busy={cancelPending || undefined}>
              {cancelPending ? "กำลังยกเลิก…" : "ยืนยันยกเลิก"}
            </button>
          </div>
        </form>
      </Dialog>
    </section>
  );
}
