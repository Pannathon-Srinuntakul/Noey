import { signOutAction } from "@/app/actions/auth";

/**
 * Server-rendered form: signing out works even before JavaScript loads.
 * Lives in the site header's signed-in variant (desktop and phone widths).
 */
export function SignOutButton({ className }: { className?: string }) {
  return (
    <form action={signOutAction} className={className}>
      <button type="submit" className="btn btn-ghost">
        ออกจากระบบ
      </button>
    </form>
  );
}
