/**
 * The bookkeeping behind เลิกทำ / ทำซ้ำ, kept out of the component so the
 * semantics can be tested without mounting an editor.
 *
 * One shape covers both directions: undo moves a snapshot from the undo stack
 * to the redo stack, redo does the same in reverse. Anything that is not a
 * step — a genuine edit — clears the redo stack, because this editor does not
 * model branching history.
 */

/** Snapshots are kept for one editing session, not forever. */
export const HISTORY_LIMIT = 20

export interface HistoryStep<T> {
  /** The stack that was popped from. */
  from: T[]
  /** The stack that `current` was pushed onto. */
  to: T[]
  /** The snapshot to apply, or null when there was nothing to pop. */
  target: T | null
}

/**
 * Pop the newest snapshot off `from` and push `current` onto `to`.
 *
 * Returns the untouched stacks and a null target when `from` is empty, so a
 * caller can apply the result unconditionally.
 */
export function stepHistory<T>(from: T[], to: T[], current: T): HistoryStep<T> {
  if (from.length === 0) return { from, to, target: null }
  return {
    from: from.slice(0, -1),
    to: [...to.slice(-(HISTORY_LIMIT - 1)), current],
    target: from[from.length - 1]
  }
}

/** Record an edit: `current` becomes undoable and any redo branch is dropped. */
export function pushHistory<T>(undo: T[], current: T): T[] {
  return [...undo.slice(-(HISTORY_LIMIT - 1)), current]
}
