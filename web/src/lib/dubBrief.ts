/** dub_first style picker + duration-chip helpers — ported 1:1 from the web
 * app's DUB_SCRIPT_STYLES/buildBrief() (frontend/src/pages/VideoPage.tsx). */

export const DUB_SCRIPT_STYLES = [
  { value: 'review', label: 'รีวิวสินค้า' },
  { value: 'funny', label: 'ตลก / สนุก' },
  { value: 'informative', label: 'ให้ข้อมูล' },
  { value: 'story', label: 'เล่าเรื่อง' }
] as const

export const DUB_SCRIPT_STYLE_LABELS: Record<string, string> = Object.fromEntries(
  DUB_SCRIPT_STYLES.map(({ value, label }) => [value, label])
)

/**
 * Length choices, in two sets because they are two different kinds of answer
 * (R14.5).
 *
 * `FIXED` is a number the user names — one rail, pick one. `AUTO` hands the
 * decision to the system instead, and each of those has a condition attached
 * ("ตามความยาวเพลง" needs a music file), so they sit outside the rail as
 * ordinary bordered buttons rather than pretending to be two more numbers.
 */
export const DUB_DURATION_FIXED = [
  { value: '15', label: '15 วิ' },
  { value: '30', label: '30 วิ' },
  { value: '60', label: '60 วิ' },
  { value: '90', label: '90 วิ' },
  { value: 'custom', label: 'กำหนดเอง' }
] as const

export const DUB_DURATION_AUTO = [
  { value: 'auto', label: 'ให้ AI เลือก' },
  { value: 'music', label: 'ตามความยาวเพลง' }
] as const

/** Combine style/duration/note into one text field — same shape as web's
 * buildBrief(), since the backend/LLM only expects a single free-text brief. */
export function buildDubBrief(
  scriptDuration: string,
  scriptCustomSec: string,
  note: string,
  styles: string[]
): string | undefined {
  const parts: string[] = []
  if (styles.length > 0) {
    parts.push(`สไตล์: ${styles.map((s) => DUB_SCRIPT_STYLE_LABELS[s] ?? s).join(', ')}`)
  }
  if (scriptDuration === 'auto') parts.push('ความยาว: ให้ AI ประเมิน')
  else if (scriptDuration === 'music') parts.push('ความยาวเป้าหมาย: ตามความยาวเพลงประกอบ')
  else if (scriptDuration === 'custom' && scriptCustomSec)
    parts.push(`ความยาวเป้าหมาย: ~${scriptCustomSec} วิ`)
  else if (scriptDuration && scriptDuration !== 'custom')
    parts.push(`ความยาวเป้าหมาย: ~${scriptDuration} วิ`)
  if (note.trim()) parts.push(note.trim())
  return parts.join(' · ') || undefined
}

/** Mirrors web's submit-time target_duration_sec derivation for dub_first.
 * `musicDurationSec` — the attached music's trimmed length (trimOutSec -
 * trimInSec), only used when scriptDuration === 'music'; clamped to the same
 * 15-600s bound the server enforces (`LocalProjectIn.target_duration_sec`). */
export function dubTargetDurationSec(
  scriptDuration: string,
  scriptCustomSec: string,
  musicDurationSec: number | null = null
): number | null {
  if (scriptDuration === 'music' && musicDurationSec) {
    return Math.round(Math.min(Math.max(musicDurationSec, 15), 600))
  }
  if (scriptDuration === 'custom' && scriptCustomSec) return parseInt(scriptCustomSec, 10)
  if (
    scriptDuration &&
    scriptDuration !== 'auto' &&
    scriptDuration !== 'custom' &&
    scriptDuration !== 'music'
  ) {
    return parseInt(scriptDuration, 10)
  }
  return null
}
