/** dub_first style picker + duration-chip helpers — ported 1:1 from the web
 * app's DUB_SCRIPT_STYLES/buildBrief() (frontend/src/pages/VideoPage.tsx). */

export const DUB_SCRIPT_STYLES = [
  { value: 'review', label: 'รีวิวสินค้า', emoji: '📦' },
  { value: 'funny', label: 'ตลก / สนุก', emoji: '😄' },
  { value: 'informative', label: 'ให้ข้อมูล', emoji: '📊' },
  { value: 'story', label: 'เล่าเรื่อง', emoji: '🎭' }
] as const

export const DUB_SCRIPT_STYLE_LABELS: Record<string, string> = Object.fromEntries(
  DUB_SCRIPT_STYLES.map(({ value, label }) => [value, label])
)

export const DUB_DURATION_CHIPS = [
  { value: '15', label: '15 วิ' },
  { value: '30', label: '30 วิ' },
  { value: '60', label: '60 วิ' },
  { value: '90', label: '90 วิ' },
  { value: 'auto', label: 'AI เลือก' },
  { value: 'custom', label: 'กำหนดเอง' }
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
  else if (scriptDuration === 'custom' && scriptCustomSec)
    parts.push(`ความยาวเป้าหมาย: ~${scriptCustomSec} วิ`)
  else if (scriptDuration && scriptDuration !== 'custom')
    parts.push(`ความยาวเป้าหมาย: ~${scriptDuration} วิ`)
  if (note.trim()) parts.push(note.trim())
  return parts.join(' · ') || undefined
}

/** Mirrors web's submit-time target_duration_sec derivation for dub_first. */
export function dubTargetDurationSec(
  scriptDuration: string,
  scriptCustomSec: string
): number | null {
  if (scriptDuration === 'custom' && scriptCustomSec) return parseInt(scriptCustomSec, 10)
  if (scriptDuration && scriptDuration !== 'auto' && scriptDuration !== 'custom') {
    return parseInt(scriptDuration, 10)
  }
  return null
}
