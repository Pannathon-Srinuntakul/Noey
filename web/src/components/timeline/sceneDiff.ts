import type { WorkingCut } from './types'

/**
 * Every scene an edit landed on — the blocks to reveal and flash once it has
 * been applied. An undo, a redo, a batch delete, a multi-move and an AI
 * re-edit all replace the whole cut list at once, so nothing in the call
 * itself says what moved; the two lists do.
 *
 * In the order a user looks for the change: scenes that appeared, scenes
 * whose window or footage changed, the scene that took a deleted one's place,
 * then scenes whose position among the scenes both lists share changed
 * (an insertion or a deletion shifts every later scene's index without
 * moving it, so a plain index compare would flash the whole tail).
 *
 * Empty means the two lists describe the same cut — nothing to point at.
 */
export function changedCutIds(before: WorkingCut[], after: WorkingCut[]): string[] {
  const beforeById = new Map(before.map((c) => [c.id, c]))
  const afterIds = new Set(after.map((c) => c.id))
  const out: string[] = []
  const seen = new Set<string>()
  const push = (id: string | undefined): void => {
    if (id === undefined || seen.has(id)) return
    seen.add(id)
    out.push(id)
  }

  for (const c of after) if (!beforeById.has(c.id)) push(c.id)

  for (const c of after) {
    const was = beforeById.get(c.id)
    if (was && (was.in !== c.in || was.out !== c.out || was.source !== c.source)) push(c.id)
  }

  const removedIdx = before.findIndex((c) => !afterIds.has(c.id))
  if (removedIdx >= 0) {
    // The scene that slid up into the gap, or the last one left when the
    // deleted scene was at the end.
    push(after[Math.min(removedIdx, after.length - 1)]?.id)
  }

  const commonBefore = before.filter((c) => afterIds.has(c.id)).map((c) => c.id)
  const commonAfter = after.filter((c) => beforeById.has(c.id)).map((c) => c.id)
  commonAfter.forEach((id, i) => {
    if (commonBefore[i] !== id) push(id)
  })

  return out
}

/**
 * The ONE scene an edit landed on — the first of changedCutIds, which is
 * what the single-block flash and the undo toast point at. null when the two
 * lists describe the same cut, so the caller says nothing rather than flash
 * an innocent block.
 */
export function changedCutId(before: WorkingCut[], after: WorkingCut[]): string | null {
  return changedCutIds(before, after)[0] ?? null
}
