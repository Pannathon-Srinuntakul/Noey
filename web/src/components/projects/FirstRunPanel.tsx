import { Layers, Mic, Scissors } from 'lucide-react'

/**
 * Empty state for a workspace with no projects (R2 screen 1) — it says what
 * the app produces before asking for a file.
 *
 * The mockup's before/after bar diagrams are deliberately not here: HANDOFF §6
 * lists them as mockup-only, and drawing fake waveforms of a clip that does
 * not exist would be inventing content.
 */
const MODES = [
  {
    icon: Mic,
    title: 'ตัดช่วงเงียบ',
    blurb:
      'คลิปพูดหน้ากล้องยาว ๆ ตัดช่วงเงียบออก คงเสียงเดิมไว้ ได้คำบรรยายจากการถอดเสียงให้ด้วย'
  },
  {
    icon: Scissors,
    title: 'ตัดฉากเด่น',
    blurb:
      'คลิปขายของสำหรับปักตะกร้า AI เลือกช็อตโชว์สินค้าเด่นจากหลายคลิป เขียนสคริปต์ขายให้ หรือจะเขียนเอง ไม่ใช้สคริปต์ก็ได้ ใส่เพลงประกอบได้'
  },
  {
    icon: Layers,
    title: 'ตัดไฮไลต์จากคลิปยาว',
    blurb:
      'ไลฟ์หรือพอดแคสต์ยาว ๆ AI ฟังคำพูดแล้วตัดช่วงเด่นออกมาเป็นคลิปสั้นหลายคลิป เสียงเดิมทั้งหมด'
  }
]

const TIPS = [
  'ถ่ายจากมือถือแนวตั้งได้เลย ไม่ต้องตัดต่อมาก่อน',
  'เสียงพูดชัดกว่าเสียงรอบข้าง ผลลัพธ์จะแม่นขึ้นมาก',
  'คลิปยาวได้ถึง 2 ชั่วโมง ยิ่งพูดชัดยิ่งตัดได้ตรง'
]

export function FirstRunPanel({
  actions
}: {
  /** The create button — rendered in the tips row, not the header. */
  actions?: React.ReactNode
} = {}): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:gap-5">
        {MODES.map(({ icon: Icon, title, blurb }) => (
          <div key={title} className="rounded-md border border-divider px-[18px] py-[18px]">
            <div className="flex items-center gap-2">
              <Icon size={18} className="text-accent" strokeWidth={1.7} />
              <p className="text-[17px] font-semibold text-ink">{title}</p>
            </div>
            <p className="mt-2 text-[15px] leading-[1.6] text-muted">{blurb}</p>
          </div>
        ))}
      </div>

      {/* Tips and the two entry actions share this divider-topped row (R2
          screen 1): on an empty workspace the thing to do next belongs beside
          the advice, not up in the welcome header. */}
      <div className="mt-auto flex items-end justify-between gap-6 border-t border-divider pt-5">
        <div className="min-w-0">
          <p className="mb-2 text-[15px] font-semibold text-ink">คลิปแบบไหนได้ผลดี</p>
          <div className="flex flex-col gap-[5px] text-sm text-muted">
            {TIPS.map((tip) => (
              <span key={tip}>{tip}</span>
            ))}
          </div>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-3">{actions}</div> : null}
      </div>
    </div>
  )
}
