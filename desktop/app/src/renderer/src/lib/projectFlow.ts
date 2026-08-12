/** Wizard step machine (dub_first + talking_head) — resumable from project.json. */

export type ProjectMode = 'dub_first' | 'talking_head' | 'highlight'

export type ProjectStep =
  /** Copying + (when the codec needs it) transcoding the source clips. Runs in
   * the BACKGROUND: the wizard hands off here so the user lands on the
   * progress screen immediately instead of watching a spinner on the button —
   * a phone HEVC export can take minutes to normalise. */
  | 'importing'
  | 'imported'
  | 'analyzing'
  | 'silent_rendering'
  | 'waiting_vo'
  | 'planning'
  | 'final_rendering'
  | 'extracting_audio'
  | 'transcribing'
  | 'rendering'
  | 'done'
  | 'error'

export const STEP_ORDER: ProjectStep[] = [
  'importing',
  'imported',
  'analyzing',
  'silent_rendering',
  'waiting_vo',
  'planning',
  'final_rendering',
  'done'
]

export const TH_STEP_ORDER: ProjectStep[] = [
  'importing',
  'imported',
  'extracting_audio',
  'transcribing',
  'rendering',
  'done'
]

// highlight mode: same AI cut-selection as dub_first, but no voiceover wait —
// renders straight from the silent cut to done (mirrors talking_head's shape).
export const HL_STEP_ORDER: ProjectStep[] = [
  'importing',
  'imported',
  'analyzing',
  'silent_rendering',
  'done'
]

export function stepOrderFor(mode: ProjectMode | undefined): ProjectStep[] {
  if (mode === 'talking_head') return TH_STEP_ORDER
  if (mode === 'highlight') return HL_STEP_ORDER
  return STEP_ORDER
}

export const STEP_LABELS: Record<ProjectStep, string> = {
  importing: 'กำลังนำเข้าคลิป',
  imported: 'นำเข้าคลิปแล้ว',
  analyzing: 'AI กำลังวิเคราะห์',
  silent_rendering: 'กำลังตัดวิดีโอ (เงียบ)',
  waiting_vo: 'คลิปพร้อม — ใส่เสียงพากย์ได้ถ้าต้องการ',
  planning: 'กำลังวางแผน timeline',
  final_rendering: 'กำลัง render วิดีโอสุดท้าย',
  extracting_audio: 'กำลังแยกเสียงจากคลิป',
  transcribing: 'ถอดเสียง + AI ตรวจวิดีโอ',
  rendering: 'กำลัง render วิดีโอ',
  done: 'เสร็จแล้ว',
  error: 'เกิดข้อผิดพลาด'
}

/** Compact labels for the progress step row, where the long-form
 * `STEP_LABELS` would wrap. Same keys, same source of truth — the sequence
 * still comes from `stepOrderFor(mode)`, never a hardcoded list. */
export const SHORT_STEP_LABELS: Record<ProjectStep, string> = {
  importing: 'นำเข้า',
  imported: 'นำเข้า',
  analyzing: 'วิเคราะห์ภาพ',
  silent_rendering: 'ตัดต่อ',
  waiting_vo: 'รอเสียงพากย์',
  planning: 'วางแผน',
  final_rendering: 'เรนเดอร์',
  extracting_audio: 'แยกเสียง',
  transcribing: 'วิเคราะห์เสียงพูด',
  rendering: 'เรนเดอร์',
  done: 'เสร็จแล้ว',
  error: 'ผิดพลาด'
}

/** The work stages shown in a progress row — the mode's real step order minus
 * `done`, which is the completion state rather than a stage of its own.
 * Lengths differ per mode (dub_first 6, talking_head 4, highlight 3), which is
 * exactly why progress UI must never assume a fixed count. */
export function progressStagesFor(mode: ProjectMode | undefined): ProjectStep[] {
  // 'importing' and 'imported' are one stage to the user (it is in flight, then
  // it is done) — showing both would put two "นำเข้า" pips in the row.
  return stepOrderFor(mode).filter((s) => s !== 'done' && s !== 'importing')
}

/** 0–100 for a project's current position through its mode's stages. */
/**
 * Minutes still to go, extrapolated from how long the run has taken to reach
 * `percent`, or null when there is nothing to extrapolate from.
 *
 * Deliberately a MEASUREMENT, not a guess: without a real start time there is
 * no honest estimate, so callers get null and show nothing rather than a
 * fabricated figure. The first few percent are ignored (the ratio is wildly
 * unstable there) and the result is clamped to whole minutes ≥ 1, because
 * "เหลืออีกประมาณ 0 นาที" reads as finished when it is not.
 */
export function etaMinutes(startedAtMs: number | null, percent: number): number | null {
  if (!startedAtMs || percent < 5 || percent >= 100) return null
  const elapsedMs = Date.now() - startedAtMs
  if (elapsedMs < 5_000) return null
  const remainingMs = (elapsedMs / percent) * (100 - percent)
  return Math.max(1, Math.round(remainingMs / 60_000))
}

export function progressPercent(step: ProjectStep, mode: ProjectMode | undefined): number {
  const stages = progressStagesFor(mode)
  if (step === 'done') return 100
  const idx = stages.indexOf(step === 'importing' ? 'imported' : step)
  if (idx === -1) return 0
  return Math.round((idx / stages.length) * 100)
}

/** Steps where a background process was interrupted — resume restarts them
 * from the nearest safe checkpoint instead of continuing blindly.
 * (silent_rendering re-runs itself: the edit script already lives on the server.) */
const RESUME_CHECKPOINT: Partial<Record<ProjectStep, ProjectStep>> = {
  analyzing: 'imported', // frames/LLM run must restart
  planning: 'waiting_vo',
  final_rendering: 'waiting_vo',
  // talking_head: audio/transcribe restart from import; render re-runs from
  // the stored timeline (fetched from the server on resume).
  extracting_audio: 'imported',
  transcribing: 'imported',
  rendering: 'rendering'
}

export function advance(step: ProjectStep, mode: ProjectMode = 'dub_first'): ProjectStep {
  const order = stepOrderFor(mode)
  const idx = order.indexOf(step)
  if (idx === -1 || idx === order.length - 1) return step
  return order[idx + 1]
}

export function isTerminal(step: ProjectStep): boolean {
  return step === 'done' || step === 'error'
}

export function isBusy(step: ProjectStep): boolean {
  return (
    step === 'importing' ||
    step === 'analyzing' ||
    step === 'silent_rendering' ||
    step === 'planning' ||
    step === 'final_rendering' ||
    step === 'extracting_audio' ||
    step === 'transcribing' ||
    step === 'rendering'
  )
}

/** Where the wizard should land when reopening a project. */
export function resumeStep(step: ProjectStep): ProjectStep {
  if (step === 'silent_rendering') {
    // Edit script already exists on the server; silent render can re-run.
    return 'silent_rendering'
  }
  return RESUME_CHECKPOINT[step] ?? step
}

export function stepIndex(step: ProjectStep, mode: ProjectMode = 'dub_first'): number {
  const idx = stepOrderFor(mode).indexOf(step)
  return idx === -1 ? 0 : idx
}
