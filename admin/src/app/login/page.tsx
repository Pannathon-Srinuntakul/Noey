import { connection } from "next/server";
import { LoginForm } from "@/components/LoginForm";
import { safeNext } from "@/lib/session";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ idle?: string; next?: string }> }) {
  await connection(); // per-request CSP nonce
  const { idle, next } = await searchParams;
  const target = safeNext(next);
  return <LoginForm idle={idle === "1"} next={target === "/" ? undefined : target} />;
}
