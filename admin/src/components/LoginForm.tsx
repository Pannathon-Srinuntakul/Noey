"use client";

import { useActionState, useState, useTransition } from "react";
import { authAction, resendAction, type LoginState } from "@/app/actions";

const label: React.CSSProperties = { display: "block", fontSize: 12.5, color: "var(--color-neutral-700)", marginBottom: 5 };
const box: React.CSSProperties = { border: "1px solid var(--color-divider)", borderRadius: 4, padding: "24px 24px 22px" };

/** Password → emailed 6-digit code. One server action drives both steps. */
export function LoginForm({ idle }: { idle: boolean }) {
  const [state, dispatch, busy] = useActionState<LoginState, FormData>(authAction, { step: "login" });
  const [otp, setOtp] = useState("");
  const [resent, setResent] = useState<{ for: LoginState; text: string; error: boolean } | null>(null);
  const [resending, start] = useTransition();

  const onOtp = state.step === "otp";
  // A resend notice belongs to the state it was shown on; a new answer clears it.
  const note = resent && resent.for === state ? resent : null;
  const error = note?.error ? note.text : state.error;
  const info = note && !note.error ? note.text : !state.error && !onOtp && idle ? "ออกจากระบบอัตโนมัติเพราะไม่มีการใช้งานนานเกิน 30 นาที" : null;

  return (
    <div className="page" style={{ paddingBottom: 0 }}>
      <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 20px" }}>
        <div style={{ width: "100%", maxWidth: 392 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 22 }}>
            <span style={{ fontSize: 22, fontWeight: 500, letterSpacing: "-0.01em" }}>Noey Studio</span>
            <span className="brand-kicker">แผงผู้ดูแลระบบ</span>
          </div>

          <form action={dispatch} style={box} noValidate>
            {!onOtp ? (
              <>
                <input type="hidden" name="intent" value="login" />
                <h1 style={{ margin: "0 0 20px", fontSize: 19, fontWeight: 500, letterSpacing: 0 }}>เข้าสู่ระบบผู้ดูแล</h1>
                <label htmlFor="email" style={label}>อีเมล</label>
                <input id="email" name="email" className="input" type="email" autoComplete="username" required defaultValue={state.email ?? ""} placeholder="you@noeystudio.com" style={{ fontFamily: "inherit", marginBottom: 14 }} />
                <label htmlFor="password" style={label}>รหัสผ่าน</label>
                <input id="password" name="password" className="input" type="password" autoComplete="current-password" required placeholder="••••••••" style={{ fontFamily: "inherit" }} />
                {info && <p style={{ margin: "12px 0 0", fontSize: 12.5, color: "var(--color-neutral-700)" }}>{info}</p>}
                {error && <p role="alert" className="err" style={{ margin: "12px 0 0", fontSize: 12.5 }}>{error}</p>}
                <button type="submit" className="btn btn-primary btn-block" disabled={busy} style={{ fontFamily: "inherit", fontSize: 14, marginTop: 18 }}>
                  {busy ? "กำลังตรวจสอบ…" : "เข้าสู่ระบบ"}
                </button>
                <div style={{ height: 1, background: "var(--color-divider)", margin: "20px 0 14px" }} />
                <p style={{ margin: 0, fontSize: 12.5, color: "var(--color-neutral-600)" }}>เครื่องนี้จะถูกจำไว้ 14 วัน ไม่ต้องยืนยันรหัสใหม่ทุกครั้ง</p>
              </>
            ) : (
              <>
                <h1 style={{ margin: "0 0 3px", fontSize: 19, fontWeight: 500, letterSpacing: 0 }}>ยืนยันตัวตน</h1>
                <p style={{ margin: "0 0 20px", fontSize: 13, color: "var(--color-neutral-600)", wordBreak: "break-all" }}>ส่งรหัส 6 หลักไปที่ {state.sentTo}</p>
                <input type="hidden" name="sentTo" value={state.sentTo ?? ""} />
                <label htmlFor="code" style={label}>รหัส 6 หลัก</label>
                <input
                  id="code" name="code" className="input" type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus
                  value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="000000"
                  style={{ fontFamily: "inherit", fontSize: 20, letterSpacing: "0.36em", textAlign: "center", minHeight: 48, fontVariantNumeric: "lining-nums tabular-nums" }}
                />
                {info && <p style={{ margin: "12px 0 0", fontSize: 12.5, color: "var(--color-neutral-700)" }}>{info}</p>}
                {error && <p role="alert" className="err" style={{ margin: "12px 0 0", fontSize: 12.5 }}>{error}</p>}
                <button type="submit" name="intent" value="verify" className="btn btn-primary btn-block" disabled={busy} style={{ fontFamily: "inherit", fontSize: 14, marginTop: 16 }}>
                  {busy ? "กำลังยืนยัน…" : "ยืนยันและเข้าใช้งาน"}
                </button>
                <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 16 }}>
                  <button type="submit" name="intent" value="back" formNoValidate className="btn btn-ghost" disabled={busy}
                    onClick={() => setOtp("")} style={{ fontFamily: "inherit", fontSize: 13 }}>
                    ย้อนกลับ
                  </button>
                  <span style={{ flex: 1 }} />
                  <button type="button" className="btn btn-ghost" disabled={resending || busy} style={{ fontFamily: "inherit", fontSize: 13 }}
                    onClick={() => start(async () => {
                      const r = await resendAction();
                      setResent({ for: state, error: !r.ok, text: r.ok ? `ส่งรหัสใหม่ไปที่ ${r.data.sentTo} แล้ว` : r.error });
                    })}>
                    ส่งอีเมลใหม่
                  </button>
                </div>
              </>
            )}
          </form>

          <p style={{ margin: "16px 0 0", fontSize: 12.5, color: "var(--color-neutral-600)", textAlign: "center" }}>ทุกการเข้าใช้งานถูกบันทึกไว้พร้อมเวลาและ IP</p>
        </div>
      </main>
    </div>
  );
}
