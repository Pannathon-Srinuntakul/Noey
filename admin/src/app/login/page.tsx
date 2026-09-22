import { connection } from "next/server";
import { LoginForm } from "@/components/LoginForm";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ idle?: string }> }) {
  await connection(); // per-request CSP nonce
  const { idle } = await searchParams;
  return <LoginForm idle={idle === "1"} />;
}
