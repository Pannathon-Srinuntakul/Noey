import type { Metadata } from "next";
import Link from "next/link";
import { ResendVerificationButton } from "@/components/account/VerifyEmail";
import { MSG } from "@/lib/messages";
import { tokenPageMetadata } from "@/lib/seo";
import { apiRequest } from "@/lib/server/api";
import { getMe, readSessionTokens } from "@/lib/server/session";
import { APP_URL } from "@/lib/site";

// Opened from the verification email: rendered per request and never cached,
// noindex, disallowed in robots.txt, Referrer-Policy: no-referrer. The token
// is sent to the backend once, server-side, and never logged.
export const dynamic = "force-dynamic";
export const metadata: Metadata = tokenPageMetadata("ยืนยันอีเมล");

type View =
  | { kind: "verified"; email: string }
  | { kind: "changed"; email: string }
  | { kind: "already" }
  | { kind: "expired" }
  | { kind: "taken" }
  | { kind: "rate-limited" }
  | { kind: "error" }
  | { kind: "missing" };

async function verify(token: string): Promise<View> {
  const result = await apiRequest<{ email?: unknown; purpose?: unknown }>("/auth/verify-email", { method: "POST", body: { token } });
  if (result.ok) {
    const email = typeof result.data?.email === "string" ? result.data.email.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 254) : "";
    return result.data?.purpose === "change_email" ? { kind: "changed", email } : { kind: "verified", email };
  }
  if (result.status === 400) return { kind: "expired" };
  if (result.status === 409) return { kind: "taken" };
  if (result.status === 429) return { kind: "rate-limited" };
  return { kind: "error" };
}

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { token } = await searchParams;
  const tokens = await readSessionTokens();
  const signedIn = !!(tokens.access || tokens.refresh);

  let view: View = typeof token === "string" && token.length > 0 && token.length <= 2048 ? await verify(token) : { kind: "missing" };

  // Mail and chat link-preview scanners can open the link before the person
  // does, using up the token. If this visitor is signed in and already
  // verified, say so instead of "expired".
  if (view.kind === "expired" && signedIn) {
    const me = await getMe();
    if (me.kind === "ok" && me.result.ok && me.result.data.email_verified === true) view = { kind: "already" };
  }

  const accountLink = signedIn ? (
    <Link href="/account" className="btn btn-secondary btn-lg">
      บัญชีของฉัน
    </Link>
  ) : (
    <Link href="/login?next=%2Faccount" className="btn btn-secondary btn-lg">
      เข้าสู่ระบบ
    </Link>
  );

  let title: string;
  let body: React.ReactNode;
  let actions: React.ReactNode = accountLink;
  switch (view.kind) {
    case "verified":
      title = "ยืนยันอีเมลเรียบร้อย";
      body = <>อีเมล {view.email ? <strong>{view.email}</strong> : null} ยืนยันแล้ว เริ่มใช้งาน AI ในแอปตัดต่อได้เลย</>;
      actions = (
        <>
          <a href={APP_URL} className="btn btn-primary btn-lg">
            ไปที่แอปตัดต่อ
          </a>
          {accountLink}
        </>
      );
      break;
    case "changed":
      title = "เปลี่ยนอีเมลเรียบร้อย";
      body = <>ตั้งแต่นี้ใช้ {view.email ? <strong>{view.email}</strong> : "อีเมลใหม่"} เข้าสู่ระบบ Noey Studio</>;
      break;
    case "already":
      title = "อีเมลนี้ยืนยันแล้ว";
      body = "ลิงก์นี้ถูกใช้ไปแล้ว แต่บัญชีของคุณยืนยันอีเมลเรียบร้อย ใช้งานต่อได้เลย";
      break;
    case "expired":
      title = MSG.linkExpired;
      body = signedIn
        ? "ขอลิงก์ยืนยันใหม่ได้จากปุ่มด้านล่าง ลิงก์ใหม่จะส่งไปที่อีเมลของบัญชีนี้"
        : "เข้าสู่ระบบ แล้วขอลิงก์ยืนยันใหม่ได้จากหน้าบัญชีของคุณ";
      actions = signedIn ? <ResendVerificationButton variant="primary" /> : accountLink;
      break;
    case "taken":
      title = "อีเมลนี้ถูกใช้กับบัญชีอื่นแล้ว";
      body = "ระหว่างรอยืนยัน มีบัญชีอื่นใช้อีเมลนี้ไปแล้ว ลองเปลี่ยนเป็นอีเมลอื่นได้ที่หน้าข้อมูลส่วนตัว";
      actions = signedIn ? (
        <Link href="/account/profile" className="btn btn-primary btn-lg">
          ไปที่ข้อมูลส่วนตัว
        </Link>
      ) : (
        accountLink
      );
      break;
    case "rate-limited":
      title = "ยังยืนยันไม่ได้ในตอนนี้";
      body = `${MSG.rateLimited} แล้วเปิดลิงก์จากอีเมลอีกครั้ง`;
      break;
    case "missing":
      title = "ลิงก์ไม่ครบ";
      body = "ลองเปิดลิงก์จากอีเมลอีกครั้ง หรือคัดลอกลิงก์ทั้งหมดมาวางในเบราว์เซอร์";
      break;
    default:
      title = "ยืนยันอีเมลไม่สำเร็จ";
      body = `${MSG.generic} แล้วเปิดลิงก์จากอีเมลอีกครั้ง`;
  }

  const success = view.kind === "verified" || view.kind === "changed" || view.kind === "already";
  return (
    <main id="main" className="container page">
      <p className="eyebrow">ยืนยันอีเมล</p>
      <h1 className="page-title">{title}</h1>
      <div className="card status-card" role={success ? "status" : "alert"}>
        <p>{body}</p>
        <div className="button-row">{actions}</div>
      </div>
    </main>
  );
}
