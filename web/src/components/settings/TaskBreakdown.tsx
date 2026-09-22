import type { UsageByTask, UsageTask } from '../../lib/api'

/** Names the user recognises for the four groups the server reports. They are
 * groups of AI calls, not pipeline stages — one dub call writes the script and
 * picks the scenes, so those share a row. Speech-to-text has no row of its
 * own: the server counts it into `cut`, since the speech modes cut from it.
 *
 * Module-private: exporting it alongside the components would break Fast
 * Refresh for this file, and nothing outside needs it. */
const TASK_LABEL: Record<UsageTask, string> = {
  cut: 'เลือกฉากและร่างสคริปต์',
  effects: 'สร้างเอฟเฟกต์ด้วย AI',
  style: 'เรียนรู้สไตล์จากคลิปอ้างอิง',
  other: 'แชทและงานอื่น'
}

/** Plain share bar. `ui/Progress` is the multi-step job indicator — a
 * different thing that happens to also draw a bar. */
export function Bar({ pct }: { pct: number }): React.JSX.Element {
  return (
    <div className="h-1 rounded-[2px] bg-[rgb(243_242_242_/_0.18)]">
      <div
        className="h-1 rounded-[2px] bg-accent transition-[width] duration-panel ease-out"
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
    </div>
  )
}

/** The by-task rows are drawn heavier than the quota `Bar` on purpose — R5
 * gives them 6px / radius 3 over a .14 track, against the quota's 4px /
 * radius 2 over .18, so the quota still reads as the headline. */
function TaskBar({ pct }: { pct: number }): React.JSX.Element {
  return (
    <div className="h-1.5 rounded-[3px] bg-border-faint">
      <div
        className="h-1.5 rounded-[3px] bg-accent transition-[width] duration-panel ease-out"
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
    </div>
  )
}

export function TaskBreakdown({ tasks }: { tasks: UsageByTask[] }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {[...tasks]
        .sort((a, b) => b.pct - a.pct)
        .map((t) => (
          <div key={t.task}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-ink-2">{TASK_LABEL[t.task]}</span>
              <span className="text-sm tabular-nums text-muted">{t.pct}%</span>
            </div>
            <div className="mt-1.5">
              <TaskBar pct={t.pct} />
            </div>
          </div>
        ))}
    </div>
  )
}
