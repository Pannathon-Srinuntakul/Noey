"use client";

import { useEffect, useState } from "react";
import { getVendorQuotaAction } from "@/app/actions";
import type { VendorQuota } from "@/lib/types";
import { LOSS, OK } from "./ui";

/**
 * Today's AI requests against the provider's daily request cap.
 *
 * This cap, not the per-minute one, is what actually stops the product: it
 * does not clear until the provider's own midnight, so the only useful moment
 * to see it is before it is spent. Read-only — the number comes from the
 * shared counter every API and worker process writes to.
 */
export function VendorQuotaCard() {
  const [q, setQ] = useState<VendorQuota | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void getVendorQuotaAction().then((r) => {
        if (!alive) return;
        if (r.ok) setQ(r.data);
        else setFailed(true);
      });
    };
    load();
    // A run in progress moves this every few seconds; a minute is enough to
    // watch it climb without polling for its own sake.
    const timer = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  if (failed) {
    return (
      <section className="card" aria-labelledby="vq-title">
        <p id="vq-title" className="card-title">โควตา AI รายวัน</p>
        <p className="small">อ่านค่าไม่ได้</p>
      </section>
    );
  }

  if (!q) {
    return (
      <section className="card" aria-labelledby="vq-title">
        <p id="vq-title" className="card-title">โควตา AI รายวัน</p>
        <p className="small">กำลังโหลด…</p>
      </section>
    );
  }

  return (
    <section className="card" aria-labelledby="vq-title">
      <p id="vq-title" className="card-title">โควตา AI รายวัน</p>
      <p className="small" style={{ marginBottom: 12 }}>
        วันของผู้ให้บริการ {q.day} ({q.timezone}) — โควตานี้จะรีเซ็ตตามเวลาของเขา ไม่ใช่เที่ยงคืนบ้านเรา
      </p>

      {!q.redis_reachable && (
        <p className="small" style={{ color: LOSS, marginBottom: 12 }}>
          ตัวนับใช้งานไม่ได้ ตัวเลขข้างล่างจึงยังไม่ใช่ของจริง
        </p>
      )}

      <div style={{ display: "grid", gap: 14 }}>
        {q.families.map((f) => {
          const percent = f.percent ?? 0;
          const color = f.alerting ? LOSS : OK;
          return (
            <div key={f.family}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
                <span style={{ fontWeight: 600 }}>{f.family}</span>
                <span style={{ flex: 1 }} />
                <span className="num">
                  {f.used.toLocaleString("th-TH")} / {f.limit > 0 ? f.limit.toLocaleString("th-TH") : "ไม่จำกัด"}
                </span>
                {f.limit > 0 && <span className="small" style={{ color }}>{percent.toFixed(1)}%</span>}
              </div>
              {f.limit > 0 && (
                <div className="rule" aria-hidden>
                  <span
                    className="rule-fill"
                    style={{ width: `${Math.min(100, percent)}%`, background: color }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="small" style={{ marginTop: 12 }}>
        ระบบจะเตือนในบันทึกเมื่อถึง {Math.round(q.alert_ratio * 100)}% และหยุดเรียกเมื่อเต็ม
      </p>
    </section>
  );
}
