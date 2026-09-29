"use client";

import { useActionState, useState } from "react";
import { deleteAccountAction, type DeleteAccountState } from "@/app/actions/account";
import { formatBahtFromSatang } from "@/lib/google-auth";
import { GoogleButton } from "../auth/GoogleButton";
import { Dialog } from "../ui/Dialog";

/** What goes and what stays — kept in step with backend packages/auth/account_deletion.py. */
function WhatHappens() {
  return (
    <div className="delete-summary">
      <h3>สิ่งที่จะถูกลบทันทีและกู้คืนไม่ได้</h3>
      <ul className="ruled-list">
        <li>โปรเจกต์ทั้งหมดบนเซิร์ฟเวอร์ ทั้งไฟล์วิดีโอที่อัปโหลด ไฟล์ที่ตัดเสร็จแล้ว สคริปต์ และสไตล์ที่บันทึกไว้</li>
        <li>ชื่อ อีเมล รหัสผ่าน และการเชื่อมต่อบัญชี Google (ถ้ามี) — อีเมลนี้จะใช้สมัครใหม่ได้</li>
        <li>แพลนรายเดือนที่ยังใช้อยู่จะถูกยกเลิกทันที ไม่มีการคืนเงินตามสัดส่วนของรอบบิลที่เหลือ</li>
        <li>ยอดเงินคงเหลือในกระเป๋า (ถ้ามี) จะหายไปทั้งหมด</li>
      </ul>
      <h3>สิ่งที่เก็บไว้ตามกฎหมายบัญชีและภาษี</h3>
      <ul className="ruled-list">
        <li>
          ประวัติการชำระเงิน ใบแจ้งหนี้ และตัวเลขการใช้งานที่ใช้คิดค่าบริการ เก็บไว้ 5 ปีตามประมวลรัษฎากรและ พ.ร.บ.การบัญชี
          โดยไม่ผูกกับชื่อหรืออีเมลของคุณอีกต่อไป
        </li>
        <li>บันทึกความปลอดภัยของระบบ และสำเนาสำรองข้อมูลที่จะหมดอายุไปเองตามรอบ</li>
      </ul>
      <p className="fine">
        ไฟล์ที่อยู่ในเครื่องของคุณเอง (ในเบราว์เซอร์ของห้องตัดต่อ หรือในแอปบนคอมพิวเตอร์) ระบบลบให้ไม่ได้ ลบเองได้จากเครื่องนั้น
      </p>
    </div>
  );
}

function Understand({ checked, onChange, error }: { checked: boolean; onChange: (value: boolean) => void; error?: string }) {
  return (
    <>
      <label className="agree" style={{ marginTop: 16 }}>
        <input
          type="checkbox"
          name="understand"
          value="yes"
          className="agree__box"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          aria-describedby={error ? "d-understand-error" : undefined}
        />
        <span className="agree__text">ฉันเข้าใจว่าบัญชีและโปรเจกต์จะถูกลบถาวร และกู้คืนไม่ได้</span>
      </label>
      {error ? (
        <p className="field-error" id="d-understand-error">
          {error}
        </p>
      ) : null}
    </>
  );
}

/**
 * Profile page "ลบบัญชี": an in-app dialog (never window.confirm) that says
 * plainly what is deleted and what is kept, then asks for re-authentication:
 *   - accounts with a password type it here;
 *   - a Google-only account first confirms with Google (the page comes back
 *     with `googleVerified`, the proof held in an HttpOnly cookie), then
 *     presses the final button.
 * A prepaid balance gets a second, explicit confirmation (backend 409).
 */
export function DeleteAccount({
  hasPassword,
  googleLinked,
  googleVerified,
  openOnLoad,
  notice,
}: {
  hasPassword: boolean;
  googleLinked: boolean;
  /** A fresh Google re-auth proof is waiting (Google-only accounts). */
  googleVerified: boolean;
  openOnLoad: boolean;
  /** Why the Google re-auth that just came back failed. */
  notice?: { text: string; ok: boolean } | null;
}) {
  const [open, setOpen] = useState(openOnLoad);
  const [understood, setUnderstood] = useState(false);
  const [forfeit, setForfeit] = useState(false);
  // Controlled: React resets uncontrolled fields after each action submit,
  // and the wallet confirmation is a second submit of the same password.
  const [password, setPassword] = useState("");
  const [state, action, pending] = useActionState<DeleteAccountState | undefined, FormData>(deleteAccountAction, undefined);

  const usePassword = hasPassword;
  const needGoogleStep = !usePassword && (!googleVerified || !!state?.reauthAgain);
  const walletSatang = state?.walletBalanceSatang;
  const errors = state?.fieldErrors ?? {};

  return (
    <>
      <button type="button" className="btn btn-danger" style={{ fontSize: 14 }} onClick={() => setOpen(true)}>
        ลบบัญชี…
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="ลบบัญชีถาวร"
        maxWidth={560}
        description={<p style={{ margin: 0 }}>อ่านให้ครบก่อนยืนยัน การลบบัญชีย้อนกลับไม่ได้</p>}
      >
        <WhatHappens />

        {needGoogleStep ? (
          <form method="post" action="/api/auth/google/start" style={{ marginTop: 8 }}>
            <input type="hidden" name="intent" value="reauth" />
            <Understand checked={understood} onChange={setUnderstood} />
            {state?.error || notice ? (
              <p className="form-error" role="alert">
                {state?.error ?? notice?.text}
              </p>
            ) : null}
            <p className="field-hint">
              บัญชีนี้ไม่มีรหัสผ่าน จึงต้องยืนยันตัวตนกับ Google ก่อน แล้วระบบจะพากลับมาที่หน้านี้เพื่อกดยืนยันการลบอีกครั้ง
            </p>
            <div className="dialog-actions" style={{ marginTop: 18 }}>
              <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
                ยกเลิก
              </button>
              <GoogleButton label="ยืนยันตัวตนด้วย Google" disabled={!understood || !googleLinked} />
            </div>
          </form>
        ) : (
          <form action={action} style={{ marginTop: 8 }}>
            <input type="hidden" name="method" value={usePassword ? "password" : "google"} />
            {walletSatang !== undefined ? <input type="hidden" name="forfeit_wallet_balance" value={forfeit ? "yes" : ""} /> : null}
            <Understand checked={understood} onChange={setUnderstood} error={errors.understand} />
            {usePassword ? (
              <div className="field" style={{ marginTop: 12 }}>
                {/* Lets password managers fill the right account's password. */}
                <input type="text" name="username" autoComplete="username" hidden readOnly />
                <label htmlFor="d-pass">รหัสผ่านปัจจุบัน</label>
                <input
                  id="d-pass"
                  name="password"
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  aria-invalid={errors.password ? true : undefined}
                  aria-describedby={errors.password ? "d-pass-error" : undefined}
                />
                {errors.password ? (
                  <p className="field-error" id="d-pass-error">
                    {errors.password}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="form-success" role="status">
                ยืนยันตัวตนกับ Google แล้ว กดลบบัญชีภายใน 5 นาที
              </p>
            )}
            {walletSatang !== undefined ? (
              <div className="notice notice--warn" role="alert" style={{ marginTop: 14 }}>
                <p>
                  ยังมียอดเงินคงเหลือในกระเป๋า <strong>{formatBahtFromSatang(walletSatang)} บาท</strong> ซึ่งจะหายไปเมื่อลบบัญชี และขอคืนไม่ได้
                </p>
                <label className="agree" style={{ marginTop: 8 }}>
                  <input type="checkbox" className="agree__box" checked={forfeit} onChange={(event) => setForfeit(event.target.checked)} />
                  <span className="agree__text">ยอมสละยอดเงินคงเหลือนี้ และลบบัญชี</span>
                </label>
              </div>
            ) : state?.error ? (
              <p className="form-error" role="alert">
                {state.error}
              </p>
            ) : null}
            <div className="dialog-actions" style={{ marginTop: 18 }}>
              <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
                ยกเลิก
              </button>
              <button
                type="submit"
                className="btn btn-danger"
                disabled={pending || !understood || (walletSatang !== undefined && !forfeit)}
                aria-busy={pending || undefined}
              >
                {pending ? "กำลังลบบัญชี…" : "ลบบัญชีถาวร"}
              </button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}
