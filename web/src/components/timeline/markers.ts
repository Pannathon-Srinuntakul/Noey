/**
 * Timeline markers (Premiere M / FCP M / Resolve M — ours is Shift+M since M
 * adds an angle): a named point on the OUTPUT clock the user can jump to and
 * that every drag snaps to. Pure model + persistence; the layer that draws
 * them is MarkerLayer.tsx.
 *
 * Markers are NOT part of the undo history — they are notes about the cut,
 * not the cut — so they live in localStorage per project, not in the draft.
 */

export type MarkerColor = 'gold' | 'red' | 'blue' | 'green'

export interface Marker {
  id: string
  sec: number
  label?: string
  color?: MarkerColor
}

/** What the persistence helpers need of `localStorage` — injectable so the
 * model is testable in node and so a throwing storage (private mode) can be
 * swallowed at the boundary. */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Rounded so a marker put on a frame compares equal to the frame. */
function r6(v: number): number {
  return Math.round(v * 1e6) / 1e6
}

function byTime(a: Marker, b: Marker): number {
  return a.sec - b.sec || a.id.localeCompare(b.id)
}

let counter = 0

/** A fresh id: unique within the session, and unlike any stored id because
 * the clock part differs between sessions. */
function nextMarkerId(existing: readonly Marker[]): string {
  const taken = new Set(existing.map((m) => m.id))
  for (;;) {
    counter += 1
    const id = `mk_${Date.now().toString(36)}_${counter}`
    if (!taken.has(id)) return id
  }
}

/** Add a marker at `sec`; the list stays sorted by time. */
export function addMarker(
  markers: readonly Marker[],
  sec: number,
  extra?: { label?: string; color?: MarkerColor; id?: string }
): { markers: Marker[]; marker: Marker } {
  const marker: Marker = { id: extra?.id ?? nextMarkerId(markers), sec: r6(Math.max(0, sec)) }
  if (extra?.label) marker.label = extra.label
  if (extra?.color) marker.color = extra.color
  return { markers: [...markers, marker].sort(byTime), marker }
}

export function moveMarker(markers: readonly Marker[], id: string, sec: number): Marker[] {
  const next = markers.map((m) => (m.id === id ? { ...m, sec: r6(Math.max(0, sec)) } : m))
  return next.sort(byTime)
}

export function removeMarker(markers: readonly Marker[], id: string): Marker[] {
  return markers.filter((m) => m.id !== id)
}

export function renameMarker(markers: readonly Marker[], id: string, label: string): Marker[] {
  const trimmed = label.trim()
  return markers.map((m) => {
    if (m.id !== id) return m
    const next: Marker = { ...m }
    if (trimmed) next.label = trimmed
    else delete next.label
    return next
  })
}

/**
 * The next marker after `t` (dir 1) or before it (dir -1), ignoring markers
 * within `eps` of `t` — the one the playhead is parked on must not answer
 * "next" with itself. Null when there is none in that direction.
 */
export function nextMarkerSec(
  markers: readonly Marker[],
  t: number,
  dir: -1 | 1,
  eps = 0.02
): number | null {
  let best: number | null = null
  for (const m of markers) {
    const d = m.sec - t
    if (dir > 0 ? d <= eps : d >= -eps) continue
    if (best === null || (dir > 0 ? m.sec < best : m.sec > best)) best = m.sec
  }
  return best
}

export function markersStorageKey(uid: string): string {
  return `noey.timeline.markers.${uid}`
}

function isMarker(v: unknown): v is Marker {
  if (!v || typeof v !== 'object') return false
  const m = v as Record<string, unknown>
  if (typeof m.id !== 'string' || !m.id) return false
  if (typeof m.sec !== 'number' || !Number.isFinite(m.sec) || m.sec < 0) return false
  if (m.label !== undefined && typeof m.label !== 'string') return false
  if (m.color !== undefined && !['gold', 'red', 'blue', 'green'].includes(String(m.color))) {
    return false
  }
  return true
}

/** Stored markers for a project, sorted; [] for nothing, garbage, or a
 * storage that throws (private mode, blocked site data). */
export function loadMarkers(storage: StorageLike | null | undefined, uid: string): Marker[] {
  try {
    const raw = storage?.getItem(markersStorageKey(uid))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: Marker[] = []
    for (const item of parsed) {
      if (!isMarker(item)) continue
      const m: Marker = { id: item.id, sec: r6(item.sec) }
      if (item.label) m.label = item.label
      if (item.color) m.color = item.color
      out.push(m)
    }
    return out.sort(byTime)
  } catch {
    return []
  }
}

/** Persist; a storage that throws is ignored — markers are a convenience. */
export function saveMarkers(
  storage: StorageLike | null | undefined,
  uid: string,
  markers: readonly Marker[]
): void {
  try {
    storage?.setItem(markersStorageKey(uid), JSON.stringify(markers))
  } catch {
    // private mode / quota — the session keeps its markers in memory
  }
}
