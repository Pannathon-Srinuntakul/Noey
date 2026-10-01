import { StatusSkeleton } from "@/components/shell/StatusSkeleton";

/** While the backend checks the link. */
export default function Loading() {
  return <StatusSkeleton task="ยืนยันอีเมล" />;
}
