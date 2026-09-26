import { describe, expect, it } from 'vitest'
import {
  addMarker,
  loadMarkers,
  markersStorageKey,
  moveMarker,
  nextMarkerSec,
  removeMarker,
  renameMarker,
  saveMarkers,
  type Marker,
  type StorageLike
} from './markers'

function fakeStorage(
  seed: Record<string, string> = {}
): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed))
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v)
    }
  }
}

describe('addMarker', () => {
  it('gives every marker a fresh id and keeps the list in time order', () => {
    const a = addMarker([], 5)
    const b = addMarker(a.markers, 2)
    const c = addMarker(b.markers, 5)
    expect(new Set(c.markers.map((m) => m.id)).size).toBe(3)
    expect(c.markers.map((m) => m.sec)).toEqual([2, 5, 5])
    expect(c.marker.sec).toBe(5)
    expect(c.marker.label).toBeUndefined()
  })

  it('never puts a marker before 0, and keeps an explicit id and label', () => {
    const { marker } = addMarker([], -3, { id: 'm1', label: 'ฮุค', color: 'red' })
    expect(marker).toEqual({ id: 'm1', sec: 0, label: 'ฮุค', color: 'red' })
  })
})

describe('move / remove / rename', () => {
  const base: Marker[] = [
    { id: 'a', sec: 1 },
    { id: 'b', sec: 4, label: 'CTA' }
  ]

  it('re-sorts after a move', () => {
    expect(moveMarker(base, 'a', 6).map((m) => m.id)).toEqual(['b', 'a'])
  })

  it('removes by id and leaves the rest untouched', () => {
    expect(removeMarker(base, 'a')).toEqual([base[1]])
    expect(removeMarker(base, 'zzz')).toEqual(base)
  })

  it('trims a label and drops it when emptied', () => {
    expect(renameMarker(base, 'a', '  ฮุค ')[0].label).toBe('ฮุค')
    expect(renameMarker(base, 'b', '   ')[1].label).toBeUndefined()
  })
})

describe('nextMarkerSec', () => {
  const markers: Marker[] = [
    { id: 'a', sec: 1 },
    { id: 'b', sec: 4 },
    { id: 'c', sec: 9 }
  ]

  it('finds the next and previous marker', () => {
    expect(nextMarkerSec(markers, 2, 1)).toBe(4)
    expect(nextMarkerSec(markers, 2, -1)).toBe(1)
    expect(nextMarkerSec(markers, 0, -1)).toBeNull()
    expect(nextMarkerSec(markers, 9, 1)).toBeNull()
  })

  it('skips the marker the playhead is parked on (eps) in both directions', () => {
    expect(nextMarkerSec(markers, 4.01, 1)).toBe(9)
    expect(nextMarkerSec(markers, 3.99, -1)).toBe(1)
    // Outside eps it is a real neighbour again.
    expect(nextMarkerSec(markers, 4.05, -1)).toBe(4)
    expect(nextMarkerSec(markers, 3.95, 1)).toBe(4)
  })
})

describe('persistence', () => {
  it('round-trips through a Storage-like object, per project', () => {
    const storage = fakeStorage()
    const markers: Marker[] = [
      { id: 'a', sec: 1.5, label: 'ฮุค' },
      { id: 'b', sec: 4, color: 'blue' }
    ]
    saveMarkers(storage, 'proj1', markers)
    expect(storage.data.has(markersStorageKey('proj1'))).toBe(true)
    expect(loadMarkers(storage, 'proj1')).toEqual(markers)
    expect(loadMarkers(storage, 'proj2')).toEqual([])
  })

  it('returns [] on garbage and drops malformed entries', () => {
    const key = markersStorageKey('p')
    expect(loadMarkers(fakeStorage({ [key]: 'not json{' }), 'p')).toEqual([])
    expect(loadMarkers(fakeStorage({ [key]: '{"a":1}' }), 'p')).toEqual([])
    expect(
      loadMarkers(
        fakeStorage({
          [key]: JSON.stringify([
            { id: 'ok', sec: 2 },
            { id: 'neg', sec: -1 },
            { sec: 3 },
            { id: 'bad-color', sec: 1, color: 'pink' },
            'x'
          ])
        }),
        'p'
      )
    ).toEqual([{ id: 'ok', sec: 2 }])
  })

  it('swallows a storage that throws (private mode)', () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('quota')
      }
    }
    expect(loadMarkers(throwing, 'p')).toEqual([])
    expect(() => saveMarkers(throwing, 'p', [{ id: 'a', sec: 1 }])).not.toThrow()
    expect(loadMarkers(null, 'p')).toEqual([])
  })
})
