/** Wizard step machine (dub_first + talking_head) — resumable from project.json. */

export type ProjectMode = 'dub_first' | 'talking_head'

export type ProjectStep =
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
  'imported',
  'analyzing',
  'silent_rendering',
  'waiting_vo',
  'planning',
  'final_rendering',
  'done'
]

export const TH_STEP_ORDER: ProjectStep[] = [
  'imported',
  'extracting_audio',
  'transcribing',
  'rendering',
  'done'
]

export function stepOrderFor(mode: ProjectMode | undefined): ProjectStep[] {
  return mode === 'talking_head' ? TH_STEP_ORDER : STEP_ORDER
}

export const STEP_LABELS: Record<ProjectStep, string> = {
  imported: 'นำเข้าคลิปแล้ว',
  analyzing: 'AI กำลังวิเคราะห์',
  silent_rendering: 'กำลังตัดวิดีโอ (เงียบ)',
  waiting_vo: 'รออัดเสียงพากย์',
  planning: 'กำลังวางแผน timeline',
  final_rendering: 'กำลัง render วิดีโอสุดท้าย',
  extracting_audio: 'กำลังแยกเสียงจากคลิป',
  transcribing: 'ถอดเสียง + AI ตรวจวิดีโอ',
  rendering: 'กำลัง render วิดีโอ',
  done: 'เสร็จแล้ว',
  error: 'เกิดข้อผิดพลาด'
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
