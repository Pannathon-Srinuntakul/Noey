import { signOutAction } from "@/app/actions/auth";

/** Server-rendered form: signing out works even before JavaScript loads. */
export function SignOutButton() {
  return (
    <form action={signOutAction}>
      <button type="submit" className="btn btn-ghost" style={{ fontSize: 14 }}>
        ออกจากระบบ
      </button>
    </form>
  );
}
