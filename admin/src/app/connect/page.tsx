import { redirect } from "next/navigation";
import { connection } from "next/server";
import { ConnectConsent } from "@/components/ConnectConsent";
import { validRequestId, type ConsentRequest } from "@/lib/blog";
import { adminApi } from "@/lib/server/api";
import { readCookie } from "@/lib/server/auth";

/**
 * OAuth consent for an AI connector (the blog MCP server, docs/blog-mcp.md).
 * The backend's /mcp/oauth/authorize parks the request and sends the browser
 * here; only a live admin session can approve it. src/proxy.ts sends a
 * signed-out visitor to /login?next=/connect?request=… first.
 */
export default async function ConnectPage({ searchParams }: { searchParams: Promise<{ request?: string }> }) {
  await connection(); // per-request CSP nonce + always-fresh data
  const { request } = await searchParams;
  const token = await readCookie("access");
  if (!token) redirect("/signout");
  if (!validRequestId(request)) return <ConnectConsent request={null} error="ลิงก์นี้ไม่ถูกต้อง — เริ่มเชื่อมต่อใหม่จากหน้าตั้งค่าตัวเชื่อมต่อ" />;
  const r = await adminApi<ConsentRequest>(`/admin/blog/oauth/requests/${request}`, { token });
  if (r.status === 401 || r.status === 403) redirect("/signout");
  if (!r.ok) return <ConnectConsent request={null} error={r.detail ?? "โหลดคำขอนี้ไม่ได้ในตอนนี้"} />;
  return <ConnectConsent request={r.data} error={null} />;
}
