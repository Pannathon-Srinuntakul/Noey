"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { LIVE_SUBSCRIPTION_STATUSES } from "@/lib/billing";
import { EDITOR_OPEN_PATH } from "@/lib/editor-handoff";
import { planDisplayName } from "@/lib/plans";
import { StatusCard } from "../ds/StatusCard";
import { ComputerOnly } from "../ComputerOnly";
import { keepThai } from "@/components/ds/ThaiText";

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

const TITLE = "ขอบคุณที่อัปเกรดแพลน";
const EYEBROW = "การชำระเงิน";

/**
 * Stripe redirects here before its webhook necessarily reached the backend,
 * so poll GET /billing/me briefly until the new plan shows up.
 *
 * Every state sits on the status card under the page's title: a running
 * render bar while waiting, "render complete" (full bar and a tick) once the
 * plan is confirmed.
 */
export function CheckoutStatus({ initial }: { initial: BillingSnapshot | null }) {
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
      <StatusCard
        tone="celebrate"
        eyebrow={EYEBROW}
        title={TITLE}
        role="status"
        readout="EXPORT · 100%"
        footer={<ComputerOnly />}
        actions={
          <>
            <a href={EDITOR_OPEN_PATH} className="btn btn-primary btn-lg status__editor">
              เปิดห้องตัดต่อ
            </a>
            <Link href="/account/billing" className="btn btn-secondary btn-lg">
              ดูแพลนและการชำระเงิน
            </Link>
          </>
        }
      >
        <h2>อัปเกรดเป็นแพลน {planDisplayName(view.plan)} แล้ว</h2>
        <p>{keepThai("โควตาใหม่พร้อมใช้ในห้องตัดต่อ ใบเสร็จจะส่งไปที่อีเมลของบัญชีนี้")}</p>
      </StatusCard>
    );
  }

  if (view.kind === "signed-out") {
    return (
      <StatusCard
        tone="info"
        eyebrow={EYEBROW}
        title={TITLE}
        actions={
          <Link href="/login?next=%2Faccount%2Fbilling" className="btn btn-primary btn-lg">
            เข้าสู่ระบบ
          </Link>
        }
      >
        <h2>เซสชันหมดอายุ</h2>
        <p>{keepThai("การชำระเงินไม่หายไปไหน เข้าสู่ระบบอีกครั้งเพื่อดูแพลนของคุณ")}</p>
      </StatusCard>
    );
  }

  if (view.kind === "slow") {
    return (
      <StatusCard
        tone="info"
        eyebrow={EYEBROW}
        title={TITLE}
        role="status"
        actions={
          <>
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
          </>
        }
      >
        <h2>ยังไม่เห็นแพลนใหม่ในบัญชี</h2>
        <p>{keepThai("ถ้าชำระเงินเสร็จแล้ว ระบบอาจใช้เวลาอีกสักครู่ในการยืนยัน ไม่ต้องจ่ายซ้ำ ลองเช็กอีกครั้ง หรือดูสถานะได้ที่หน้าแพลนและการชำระเงิน")}</p>
      </StatusCard>
    );
  }

  return (
    <StatusCard tone="pending" eyebrow={EYEBROW} title={TITLE} role="status" busy>
      <h2>กำลังยืนยันการชำระเงิน…</h2>
      <p>{keepThai("ใช้เวลาไม่กี่วินาที ไม่ต้องปิดหน้านี้และไม่ต้องกดจ่ายซ้ำ")}</p>
    </StatusCard>
  );
}
