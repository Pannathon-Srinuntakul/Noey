/**
 * The editor's selection model — several scenes at once, the way every NLE
 * selects: click picks one, ⌘/Ctrl+click toggles one, Shift+click takes the
 * range from the anchor, Shift+drag on the lane background adds what the
 * marquee crossed.
 *
 * Pure and tested; the editor keeps one SelectionState and every existing
 * single-selection reader keeps working through `primary` (the inspector,
 * ปรับช็อต, Esc). Play order is handed in as `order` (cut ids in sequence)
 * because a range on a timeline runs along the sequence, not the array the
 * ids happen to sit in.
 */
import { idsBetween } from '../../lib/timelineMath'

export interface SelectionState {
  /** Every selected id, in the order they were picked. */
  ids: string[]
  /** Where a Shift+click range starts: the last plain or toggle click. */
  anchor: string | null
  /** The scene the inspector shows and single-scene actions act on. */
  primary: string | null
}

export interface SelectMods {
  shift: boolean
  toggle: boolean
}

export const EMPTY_SELECTION: SelectionState = { ids: [], anchor: null, primary: null }

export function clearSelection(): SelectionState {
  return EMPTY_SELECTION
}

/** Exactly one scene — what a plain click or `setSelectedId(id)` means. */
export function selectOnly(id: string): SelectionState {
  return { ids: [id], anchor: id, primary: id }
}

/** The ids between `a` and `b` in `order`, inclusive, either way round — the
 * edit-math helper, re-exported so the selection model reads as one module. */
export { idsBetween }

/** `ids` in play order — what copy, batch move and the delete count read. */
export function idsInOrder(ids: readonly string[], order: readonly string[]): string[] {
  const set = new Set(ids)
  return order.filter((id) => set.has(id))
}

/**
 * A click on scene `id`.
 *
 * Plain: that scene alone. Toggle (⌘/Ctrl): add it, or remove it — the
 * primary becomes the clicked scene, or the last one still selected. Shift:
 * the range from the anchor to it. The range replaces the PREVIOUS shift
 * range (anchor → old primary) but keeps anything picked by toggle outside
 * it, so Shift+click can shrink a range as well as grow it and a ⌘-picked
 * scene elsewhere survives (the Finder rule, which Premiere and Resolve
 * follow too). The anchor stays where the last plain/toggle click put it.
 */
export function selectClick(
  state: SelectionState,
  id: string,
  mods: SelectMods,
  order: readonly string[]
): SelectionState {
  if (mods.shift) {
    const anchor = state.anchor ?? state.primary ?? id
    const prevRange = new Set(
      state.primary && state.anchor ? idsBetween(order, state.anchor, state.primary) : []
    )
    const kept = state.ids.filter((x) => !prevRange.has(x))
    const range = idsBetween(order, anchor, id)
    const ids = [...kept, ...range.filter((x) => !kept.includes(x))]
    return { ids: ids.length ? ids : [id], anchor, primary: id }
  }
  if (mods.toggle) {
    if (state.ids.includes(id)) {
      const ids = state.ids.filter((x) => x !== id)
      const primary = ids.length ? ids[ids.length - 1] : null
      const anchor = state.anchor === id ? primary : state.anchor
      return { ids, anchor, primary }
    }
    return { ids: [...state.ids, id], anchor: id, primary: id }
  }
  return selectOnly(id)
}

/** The scenes a marquee crossed. Additive (Shift held) keeps what was
 * selected; otherwise the hits are the selection. */
export function selectMarquee(
  state: SelectionState,
  hits: readonly string[],
  additive: boolean
): SelectionState {
  if (!additive) {
    if (hits.length === 0) return clearSelection()
    return { ids: [...hits], anchor: hits[0], primary: hits[hits.length - 1] }
  }
  if (hits.length === 0) return state
  const ids = [...state.ids, ...hits.filter((h) => !state.ids.includes(h))]
  return {
    ids,
    anchor: state.anchor ?? hits[0],
    primary: hits[hits.length - 1]
  }
}

export function selectAll(order: readonly string[]): SelectionState {
  if (order.length === 0) return clearSelection()
  return { ids: [...order], anchor: order[0], primary: order[0] }
}

/** เลือกตั้งแต่นี้ถึงท้าย — `fromId` and every scene after it. */
export function selectForward(order: readonly string[], fromId: string): SelectionState {
  const idx = order.indexOf(fromId)
  if (idx < 0) return selectOnly(fromId)
  return { ids: order.slice(idx), anchor: fromId, primary: fromId }
}

/**
 * The selection after some scenes ceased to exist (a delete, an undo, an AI
 * re-edit). Returns the SAME object when nothing was lost, so a state setter
 * given it re-renders nothing.
 */
export function pruneSelection(
  state: SelectionState,
  existingIds: ReadonlySet<string> | readonly string[]
): SelectionState {
  const exists = existingIds instanceof Set ? existingIds : new Set(existingIds)
  const ids = state.ids.filter((id) => exists.has(id))
  const primaryOk = state.primary !== null && exists.has(state.primary)
  const anchorOk = state.anchor !== null && exists.has(state.anchor)
  if (
    ids.length === state.ids.length &&
    primaryOk === (state.primary !== null) &&
    anchorOk === (state.anchor !== null)
  ) {
    return state
  }
  const primary = primaryOk ? state.primary : ids.length ? ids[ids.length - 1] : null
  const anchor = anchorOk ? state.anchor : primary
  return { ids, anchor, primary }
}

export function primaryOf(state: SelectionState): string | null {
  return state.primary
}

/**
 * Whether a key press starts a NEW undo step or joins the burst before it.
 * Alt+← held down fires dozens of nudges; one undo step per burst is what
 * every editor records (the caption style slider uses the same rule).
 */
export function keyBurstIsNewStep(lastAt: number, now: number, burstMs: number): boolean {
  return lastAt <= 0 || now - lastAt > burstMs
}
