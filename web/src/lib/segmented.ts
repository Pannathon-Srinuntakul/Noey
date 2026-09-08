/** Keyboard math for `ui/Segmented` (R14.3).
 *
 * A radiogroup moves its value with the arrow keys, not with Tab — Tab leaves
 * the group. Kept here as a pure function so the wrap-around and the
 * nothing-selected case can be tested without mounting anything.
 */

/**
 * The index the arrow/Home/End key should move to, or `null` when the key is
 * not one this control handles (so the caller leaves the event alone).
 *
 * `current` may be -1: the wizard clears `duration` when the music a
 * "ตามความยาวเพลง" pick depended on is removed, which leaves the rail with no
 * selected option at all. From there the group behaves as if focus sat just
 * before the first option — Right lands on the first, Left on the last.
 */
export function nextSegmentedIndex(key: string, current: number, count: number): number | null {
  if (count === 0) return null
  const has = current >= 0 && current < count
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return has ? (current + 1) % count : 0
    case 'ArrowLeft':
    case 'ArrowUp':
      return has ? (current - 1 + count) % count : count - 1
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}
