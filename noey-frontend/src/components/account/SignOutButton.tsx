import { signOutAction } from "@/app/actions/auth";
import { IconSignOut } from "../ds/icons";

/**
 * Server-rendered form: signing out works even before JavaScript loads.
 * Lives in the site header's signed-in variant (desktop and phone widths).
 */
export function SignOutButton({ className, icon = false }: { className?: string; icon?: boolean }) {
  return (
    <form action={signOutAction} className={className}>
      <button type="submit" className="btn btn-ghost">
        {icon ? <IconSignOut size={16} /> : null}
        ออกจากระบบ
      </button>
    </form>
  );
}
