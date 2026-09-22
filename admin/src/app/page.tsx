import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Dashboard } from "@/components/Dashboard";
import { adminApi } from "@/lib/server/api";
import { readCookie } from "@/lib/server/auth";
import { IDLE_LOGOUT_MS } from "@/lib/server/config";
import type { DashboardData } from "@/lib/types";

export default async function Home() {
  await connection(); // per-request CSP nonce + always-fresh data
  const token = await readCookie("access");
  if (!token) redirect("/signout");
  const [me, dash] = await Promise.all([
    adminApi<{ email: string }>("/admin/auth/me", { token }),
    adminApi<DashboardData>("/admin/dashboard", { token }),
  ]);
  if (me.status === 401 || dash.status === 401 || me.status === 403) redirect("/signout");
  if (!me.ok || !dash.ok) {
    return (
      <main className="page" style={{ display: "grid", placeItems: "center" }}>
        <div style={{ maxWidth: 420, padding: 24 }}>
          <p style={{ fontSize: 19, fontWeight: 500, margin: "0 0 6px" }}>โหลดข้อมูลไม่ได้</p>
          <p className="small">เชื่อมต่อระบบหลังบ้านไม่ได้ในตอนนี้ ลองรีเฟรชอีกครั้งในอีกสักครู่</p>
        </div>
      </main>
    );
  }
  return <Dashboard initial={dash.data} adminEmail={me.data.email} idleMs={IDLE_LOGOUT_MS} />;
}
