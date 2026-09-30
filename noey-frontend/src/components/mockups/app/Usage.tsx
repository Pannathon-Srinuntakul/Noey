import { cn } from "./ui";

/**
 * The quota card of the editor's settings page
 * (web/src/components/settings/UsageCard.tsx), with sample numbers: a Pro
 * plan part-way through its windows. Percent only, like the app.
 */

function MeterRow({ name, value, pct, line }: { name: string; value: string; pct: number; line: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-ink-2">{name}</span>
        <span className="text-sm font-semibold tabular-nums text-ink">{value}</span>
      </div>
      <div className="mt-2">
        <div className="h-1 rounded-[2px] bg-[rgb(243_242_242_/_0.18)]">
          <div className={cn("h-1 rounded-[2px] bg-ink")} style={{ width: `${pct}%` }} />
        </div>
      </div>
      <p className="mt-1.5 text-[13px] tabular-nums text-muted">{line}</p>
    </div>
  );
}

export function UsageCard() {
  return (
    <section className="rounded-md border border-accent p-5">
      <div className="flex items-baseline gap-3">
        <p className="text-item font-semibold text-ink">แผน Pro</p>
        <span className="flex-1" />
        <span className="text-[13px] tabular-nums text-muted">ทำพร้อมกันได้ 2 งาน</span>
        <span className="text-[13.5px] text-accent">เปลี่ยนแผน</span>
      </div>
      <div className="mt-4 flex flex-col gap-4">
        <MeterRow name="โควตารายสัปดาห์" value="ใช้ไป 21%" pct={21} line="รอบใหม่ พฤหัสบดี 09:40" />
        <MeterRow name="โควตารอบ 5 ชั่วโมง" value="ใช้ไป 38%" pct={38} line="รอบใหม่ใน 1 ชม. 48 นาที" />
        <MeterRow name="ที่เก็บไฟล์" value="6.2 / 50 GB" pct={12.4} line="ลบโปรเจกต์เก่าเพื่อคืนพื้นที่ได้" />
      </div>
      <p className="mt-4 border-t border-divider pt-3.5 text-[13px] leading-[1.6] text-muted">
        แก้ไทม์ไลน์ สลับช็อต และเรนเดอร์ซ้ำ ไม่กินโควตา
      </p>
    </section>
  );
}
