"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { decideConnectAction } from "@/app/actions";
import { thaiDate, type ConsentRequest } from "@/lib/blog";
import { LOSS } from "./ui";

const box: React.CSSProperties = { border: "1px solid var(--color-divider)", borderRadius: 4, padding: "24px 24px 22px" };

/**
 * The consent screen. Names the client and — as the MCP authorization spec
 * requires — the HOST the browser will be sent back to, with a warning when
 * that is a loopback address (any local program can listen there).
 */
export function ConnectConsent({ request, error }: { request: ConsentRequest | null; error: string | null }) {
  const [busy, start] = useTransition();
  const [fail, setFail] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const decide = (approve: boolean) =>
    start(async () => {
      if (!request) return;
      const r = await decideConnectAction(request.request_id, approve);
      if (!r.ok) {
        if (r.signedOut) {
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination
          window.location.assign("/signout");
          return;
        }
        setFail(r.error);
        return;
      }
      setSent(true);
      // Back to the connector's own callback (an allow-listed URL the backend chose).
      window.location.assign(r.data.redirect_to);
    });

  return (
    <div className="page" style={{ paddingBottom: 0 }}>
      <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 20px" }}>
        <div style={{ width: "100%", maxWidth: 460 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 22 }}>
            <span style={{ fontSize: 22, fontWeight: 500, letterSpacing: "-0.01em" }}>Noey Studio</span>
            <span className="brand-kicker">แผงผู้ดูแลระบบ</span>
          </div>
          <div style={box}>
            {!request ? (
              <>
                <h1 style={{ margin: "0 0 10px", fontSize: 19, fontWeight: 500 }}>เชื่อมต่อไม่ได้</h1>
                <p role="alert" className="err" style={{ margin: 0, fontSize: 13.5 }}>{error}</p>
                <p style={{ margin: "18px 0 0" }}><Link href="/">กลับไปแผงผู้ดูแล</Link></p>
              </>
            ) : (
              <>
                <h1 style={{ margin: "0 0 4px", fontSize: 19, fontWeight: 500 }}>อนุญาตตัวเชื่อมต่อ AI</h1>
                <p style={{ margin: "0 0 18px", fontSize: 13, color: "var(--color-neutral-600)" }}>คำขอหมดอายุ {thaiDate(request.expires_at)}</p>
                <dl style={{ margin: 0, fontSize: 13.5, display: "grid", gridTemplateColumns: "auto 1fr", gap: "8px 14px" }}>
                  <dt style={{ color: "var(--color-neutral-600)" }}>ชื่อ</dt>
                  <dd style={{ margin: 0, wordBreak: "break-word" }}>{request.client_name}</dd>
                  <dt style={{ color: "var(--color-neutral-600)" }}>ส่งกลับไปที่</dt>
                  <dd style={{ margin: 0, fontWeight: 500, wordBreak: "break-all" }}>{request.redirect_host}</dd>
                  <dt style={{ color: "var(--color-neutral-600)" }}>สิทธิ์</dt>
                  <dd style={{ margin: 0 }}>เขียน แก้ เผยแพร่ และถอนบทความในบล็อก อัปโหลดรูปประกอบ (ลบบทความไม่ได้)</dd>
                </dl>
                {request.loopback && (
                  <p role="alert" style={{ margin: "16px 0 0", fontSize: 13, color: LOSS }}>
                    ปลายทางเป็นเครื่องนี้เอง (localhost) — อนุญาตเฉพาะเมื่อคุณเพิ่งเริ่มเชื่อมต่อจากโปรแกรมบนเครื่องนี้ด้วยตัวเอง
                  </p>
                )}
                <p className="small" style={{ margin: "16px 0 0" }}>
                  อนุญาตเฉพาะเมื่อคุณเพิ่งกดเชื่อมต่อจากหน้าตั้งค่าตัวเชื่อมต่อเอง ยกเลิกได้ทุกเมื่อที่แท็บ “บทความ”
                </p>
                {fail && <p role="alert" className="err" style={{ margin: "12px 0 0", fontSize: 13 }}>{fail}</p>}
                <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
                  <button type="button" className="btn btn-secondary" disabled={busy || sent} onClick={() => decide(false)} style={{ fontFamily: "inherit", fontSize: 14, flex: 1 }}>
                    ปฏิเสธ
                  </button>
                  <button type="button" className="btn btn-primary" disabled={busy || sent} onClick={() => decide(true)} style={{ fontFamily: "inherit", fontSize: 14, flex: 1 }}>
                    {busy || sent ? "กำลังส่งกลับ…" : "อนุญาต"}
                  </button>
                </div>
              </>
            )}
          </div>
          <p style={{ margin: "16px 0 0", fontSize: 12.5, color: "var(--color-neutral-600)", textAlign: "center" }}>ทุกการอนุญาตถูกบันทึกไว้พร้อมเวลา</p>
        </div>
      </main>
    </div>
  );
}
