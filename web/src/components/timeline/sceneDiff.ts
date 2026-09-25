import type { WorkingCut } from './types'

/**
 * Which scene an edit landed on — the block to reveal, flash and select once
 * it has been applied.
 *
 * An undo, a redo and an AI re-edit all replace the whole cut list at once, so
 * nothing in the call itself says what moved; the two lists do. They are
 * compared in the order a user looks for the change: a scene that appeared,
 * one whose footage or window changed, the scene that took a deleted one's
 * place, and finally the first position the order differs at.
 *
 * null means the two lists describe the same cut — there is nothing to point
 * at, and the caller should say nothing rather than flash an innocent block.
 */
export function changedCutId(before: WorkingCut[], after: WorkingCut[]): string | null {
  const beforeById = new Map(before.map((c) => [c.id, c]))

  const added = after.find((c) => !beforeById.has(c.id))
  if (added) return added.id

  const retimed = after.find((c) => {
    const was = beforeById.get(c.id)
    return !!was && (was.in !== c.in || was.out !== c.out || was.source !== c.source)
  })
  if (retimed) return retimed.id

  const afterIds = new Set(after.map((c) => c.id))
  const removedIdx = before.findIndex((c) => !afterIds.has(c.id))
  if (removedIdx >= 0) {
    // The scene that slid up into the gap, or the last one left when the
    // deleted scene was at the end.
    return after[Math.min(removedIdx, after.length - 1)]?.id ?? null
  }

  const moved = after.find((c, i) => before[i]?.id !== c.id)
  return moved?.id ?? null
}
