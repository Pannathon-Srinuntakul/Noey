import { useRef, useState } from 'react'
import { fmtTimeTenths, timecodeCommitValue } from '../../../lib/timelineMath'

/**
 * Seconds shown as a timecode, edited as text.
 *
 * Keeps its own draft string while focused so typing "0:2" does not get
 * reformatted mid-keystroke; commits on blur/Enter and reverts on Escape or
 * an unparseable value.
 */
export function TimecodeInput({
  value,
  onCommit,
  onFocus,
  onSettled
}: {
  value: number
  /** Only for a real change — an untouched field commits nothing. */
  onCommit: (sec: number) => void
  onFocus: () => void
  /** Every time focus leaves, changed or not — where an edit that began on
   * focus ends. */
  onSettled?: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  // The text shown when focus arrived. The field shows tenths, so committing
  // it untouched would floor the real value (3.4667 → 3.4): tabbing through a
  // caption's times pulled its start onto the previous scene's last frames.
  const focusTextRef = useRef<string | null>(null)
  // Set by Escape just before it blurs: the blur runs inside that same
  // handler, while `draft` still holds the typed text, so clearing the state
  // alone let the blur commit what Escape meant to throw away.
  const cancelRef = useRef(false)

  const commit = (): void => {
    const cancelled = cancelRef.current
    cancelRef.current = false
    if (cancelled) {
      setDraft(null)
      return
    }
    if (draft === null) return
    const parsed = timecodeCommitValue(draft, focusTextRef.current)
    if (parsed !== null) onCommit(parsed)
    setDraft(null)
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft ?? fmtTimeTenths(value)}
      onFocus={() => {
        onFocus()
        focusTextRef.current = fmtTimeTenths(value)
        setDraft(focusTextRef.current)
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        commit()
        onSettled?.()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          cancelRef.current = true
          e.currentTarget.blur()
        }
      }}
      className="w-24 rounded-md border border-border bg-transparent px-2 py-1.5 text-sm tabular-nums text-ink"
    />
  )
}
