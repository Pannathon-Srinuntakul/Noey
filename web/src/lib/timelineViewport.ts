/**
 * The timeline's scroll position, published imperatively.
 *
 * Scrolling must not re-render the timeline. `currentTime` is the editor's
 * source of truth and the playhead is already painted imperatively (see the
 * header of `TimelineEditor.tsx`); the filmstrip lanes are the other consumer
 * of scroll, and they redraw a canvas rather than producing DOM. So the scroll
 * handler pushes `{scrollLeft, viewportWidth}` here and interested lanes are
 * called back directly — no `setState`, no reconciliation, one canvas draw per
 * lane that actually moved.
 *
 * One store per editor instance, created by the editor and handed down through
 * `TimelineViewportContext`, so nothing leaks between mounts.
 */

import { createContext } from 'react'

export interface TimelineViewport {
  scrollLeft: number
  viewportWidth: number
}

export interface TimelineViewportStore {
  get: () => TimelineViewport
  /** Publish a new position. A no-op when nothing actually moved. */
  set: (next: TimelineViewport) => void
  subscribe: (cb: (v: TimelineViewport) => void) => () => void
}

export function createTimelineViewportStore(): TimelineViewportStore {
  let value: TimelineViewport = { scrollLeft: 0, viewportWidth: 0 }
  const listeners = new Set<(v: TimelineViewport) => void>()

  return {
    get: () => value,
    set: (next) => {
      if (next.scrollLeft === value.scrollLeft && next.viewportWidth === value.viewportWidth) {
        return
      }
      value = next
      for (const cb of listeners) cb(value)
    },
    subscribe: (cb) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    }
  }
}

/**
 * Lives here rather than beside `FilmstripCanvas` so that component file only
 * exports components — a file that mixes a context with components breaks Fast
 * Refresh, and an editor that full-reloads on every save is exactly how the
 * R18b thumbnail cache bug hid itself.
 */
export const TimelineViewportContext = createContext<TimelineViewportStore | null>(null)
