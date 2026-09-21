"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { LIVE_SUBSCRIPTION_STATUSES } from "@/lib/billing";
import { planDisplayName } from "@/lib/plans";

type BillingSnapshot = { plan: string; status: string | null };

type View =
  | { kind: "waiting" }
  | { kind: "confirmed"; plan: string }
  | { kind: "slow" }
  | { kind: "signed-out" };

const LIVE = new Set<string>(LIVE_SUBSCRIPTION_STATUSES);
const POLL_EVERY_MS = 2_000;
const GIVE_UP_AFTER_MS = 30_000;

function isPaidAndLive(snapshot: BillingSnapshot | null): snapshot is BillingSnapshot {
  return !!snapshot && snapshot.plan !== "free" && !!snapshot.status && LIVE.has(snapshot.status);
}

/**
 * Stripe redirects here before its webhook necessarily reached the backend,
 * so poll GET /billing/me briefly until the new plan shows up.
 */
export function CheckoutStatus({ initial, appUrl }: { initial: BillingSnapshot | null; appUrl: string }) {
  const [view, setView] = useState<View>(isPaidAndLive(initial) ? { kind: "confirmed", plan: initial.plan } : { kind: "waiting" });
  const [attempt, setAttempt] = useState(0);
  const startedAt = useRef<number>(0);

  useEffect(() => {
    if (view.kind !== "waiting") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    if (!startedAt.current) startedAt.current = Date.now();

    const poll = async () => {
      try {
        const response = await fetch("/api/billing/me", { cache: "no-store", headers: { Accept: "application/json" } });
        if (cancelled) return;
        if (response.status === 401) {
          setView({ kind: "signed-out" });
          return;
        }
        if (response.ok) {
          const snapshot = (await response.json()) as BillingSnapshot;
          if (isPaidAndLive(snapshot)) {
            setView({ kind: "confirmed", plan: snapshot.plan });
            return;
          }
        }
      } catch {
        // network blip: keep polling until the time limit
      }
      if (Date.now() - startedAt.current >= GIVE_UP_AFTER_MS) {
        setView({ kind: "slow" });
        return;
      }
      timer = setTimeout(poll, POLL_EVERY_MS);
    };
    timer = setTimeout(poll, attempt === 0 ? 800 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [view.kind, attempt]);

  if (view.kind === "confirmed") {
    return (
      <div className="card status-card" role="status">
        <div className="card-kicker">การชำระเงิน</div>
        <h2>อัปเกรดเป็นแพลน {planDisplayName(view.plan)} แล้ว</h2>
        <p>โควตาใหม่พร้อมใช้ในแอปตัดต่อ ใบเสร็จจะส่งไปที่อีเมลของบัญชีนี้</p>
        <div className="button-row">
          <a href={appUrl} className="btn btn-primary btn-lg">
            ไปที่แอปตัดต่อ
          </a>
          <Link href="/account/billing" className="btn btn-secondary btn-lg">
            ดูแพลนและการชำระเงิน
          </Link>
        </div>
      </div>
    );
  }

  if (view.kind === "signed-out") {
    return (
      <div className="card status-card">
        <h2>เซสชันหมดอายุ</h2>
        <p>การชำระเงินไม่หายไปไหน เข้าสู่ระบบอีกครั้งเพื่อดูแพลนของคุณ</p>
        <Link href="/login?next=%2Faccount%2Fbilling" className="btn btn-primary btn-lg">
          เข้าสู่ระบบ
        </Link>
      </div>
    );
  }

  if (view.kind === "slow") {
    return (
      <div className="card status-card" role="status">
        <div className="card-kicker">การชำระเงิน</div>
        <h2>ยังไม่เห็นแพลนใหม่ในบัญชี</h2>
        <p>ถ้าชำระเงินเสร็จแล้ว ระบบอาจใช้เวลาอีกสักครู่ในการยืนยัน ไม่ต้องจ่ายซ้ำ ลองเช็กอีกครั้ง หรือดูสถานะได้ที่หน้าแพลนและการชำระเงิน</p>
        <div className="button-row">
          <button
            type="button"
            className="btn btn-primary btn-lg"
            onClick={() => {
              startedAt.current = Date.now();
              setAttempt((n) => n + 1);
              setView({ kind: "waiting" });
            }}
          >
            เช็กสถานะอีกครั้ง
          </button>
          <Link href="/account/billing" className="btn btn-secondary btn-lg">
            ไปหน้าแพลนและการชำระเงิน
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="card status-card" role="status" aria-busy="true">
      <div className="card-kicker">การชำระเงิน</div>
      <h2>กำลังยืนยันการชำระเงิน…</h2>
      <p>ใช้เวลาไม่กี่วินาที ไม่ต้องปิดหน้านี้และไม่ต้องกดจ่ายซ้ำ</p>
    </div>
  );
}
