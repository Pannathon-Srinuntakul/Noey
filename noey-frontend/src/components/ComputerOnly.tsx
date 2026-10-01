import { IconMonitor } from "./ds/icons";
import { keepThai } from "./ds/ThaiText";

/**
 * The editor works on a computer only (owner, 2026-10-01): not on phones or
 * tablets. Shown to visitors on a phone or a touch tablet where they would
 * start — under the home page's call to action, above the sign-up and log-in
 * forms, on /pricing, and after verifying an email or paying, whose next step
 * is the editor (components.css hides it elsewhere; the copy around it already
 * says "on a computer"). keepThai, not keepThaiProse: it renders inside client
 * components too.
 */
export function ComputerOnly({ className }: { className?: string }) {
  return (
    <p className={["computer-only", className].filter(Boolean).join(" ")}>
      <IconMonitor size={18} className="computer-only__icon" />
      <span>{keepThai("ห้องตัดต่อใช้ได้เฉพาะบนคอมพิวเตอร์ ผ่าน Chrome หรือ Edge ยังใช้บนมือถือหรือแท็บเล็ตไม่ได้")}</span>
    </p>
  );
}
