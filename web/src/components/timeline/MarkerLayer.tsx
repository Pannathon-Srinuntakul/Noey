import { memo, useEffect, useRef, useState } from 'react'
import { bindPointerDrag, type DragScroller } from '../../lib/pointerDrag'
import { fmtTimeTenths } from '../../lib/timelineMath'
import { quantizeToFrame, snapScrub, type SnapContext } from '../../lib/timelineSnap'
import { HEADER_COL_PX, RULER_PX } from './constants'
import type { Marker, MarkerColor } from './markers'

const COLOR_CLS: Record<MarkerColor, string> = {
  gold: 'bg-accent',
  red: 'bg-error',
  blue: 'bg-cap-blue',
  green: 'bg-ok'
}

/** Below this the press was a click, not a drag. */
const CLICK_SLOP_PX = 3

/**
 * The markers as small flags in the ruler row. Mounted in the timeline's
 * scroll content (the `relative` div the playhead lives in), so a flag's x is
 * leadPx + HEADER_COL_PX + sec × pxPerSec, the same arithmetic as the guide
 * lines. z-[37]: over the guides, under the sticky label column (z-40) so a
 * flag scrolls under the ruler's corner.
 *
 * click = seek · drag = move (snaps to every output target but its own) ·
 * double-click = rename inline · right-click = remove.
 */
export const MarkerLayer = memo(function MarkerLayer({
  markers,
  pxPerSec,
  leadPx,
  onPick,
  onMove,
  onRename,
  onRemove,
  dragScroller,
  getSnapContext
}: {
  markers: readonly Marker[]
  pxPerSec: number
  leadPx: number
  onPick: (id: string) => void
  onMove: (id: string, sec: number) => void
  onRename: (id: string, label: string) => void
  onRemove: (id: string) => void
  dragScroller?: DragScroller
  getSnapContext: () => SnapContext
}): React.JSX.Element {
  // The flag being dragged and where it is this frame — local, so a move
  // re-renders this small layer and nothing else until release.
  const [draft, setDraft] = useState<{ id: string; sec: number } | null>(null)
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const cancelDragRef = useRef<(() => void) | null>(null)
  // A press that moved must not also count as the click that follows it.
  const movedRef = useRef(false)
  // Escape blurs the input, and the blur runs while `editing` still holds the
  // typed text — the same trap TimecodeInput documents.
  const cancelRenameRef = useRef(false)

  useEffect(() => () => cancelDragRef.current?.(), [])

  const startDrag = (e: React.PointerEvent, m: Marker): void => {
    if (e.button !== 0 || editing) return
    const ctx = getSnapContext()
    const startSec = m.sec
    movedRef.current = false
    let last = startSec
    cancelDragRef.current = bindPointerDrag({
      e,
      pxPerSec,
      scroller: dragScroller,
      onFrame: (f) => {
        if (Math.abs(f.deltaPx) >= CLICK_SLOP_PX) movedRef.current = true
        const candidate = quantizeToFrame(startSec + f.deltaSec)
        let sec = candidate
        if (ctx.isActive() && !f.altKey) {
          const targets = ctx.outputTargets().filter((t) => t.ownerId !== m.id)
          const r = snapScrub(candidate, targets, ctx.tolSec())
          sec = r.sec
          ctx.report(r.hit, 'output')
        } else {
          ctx.report(null, 'output')
        }
        last = sec
        setDraft({ id: m.id, sec })
      },
      onEnd: ({ cancelled }) => {
        cancelDragRef.current = null
        ctx.report(null, 'output')
        setDraft(null)
        if (!cancelled && movedRef.current && last !== startSec) onMove(m.id, last)
      }
    })
  }

  const commitRename = (): void => {
    const cancelled = cancelRenameRef.current
    cancelRenameRef.current = false
    if (!editing) return
    if (!cancelled) onRename(editing.id, editing.text)
    setEditing(null)
  }

  return (
    <div
      className="pointer-events-none absolute top-0 left-0 z-[37] w-0"
      style={{ height: RULER_PX }}
      data-marker-layer
    >
      {markers.map((m) => {
        const sec = draft?.id === m.id ? draft.sec : m.sec
        const x = leadPx + HEADER_COL_PX + sec * pxPerSec
        const title = m.label ?? fmtTimeTenths(m.sec)
        const isEditing = editing?.id === m.id
        return (
          <div
            key={m.id}
            className="absolute top-0 -translate-x-1/2"
            style={{ left: x, height: RULER_PX }}
          >
            <button
              type="button"
              data-marker-id={m.id}
              aria-label={`หมุด ${title}`}
              title={`${title} · คลิก = ไป · ลาก = ย้าย · ดับเบิลคลิก = ตั้งชื่อ · คลิกขวา = ลบ`}
              onPointerDown={(e) => startDrag(e, m)}
              onClick={() => {
                if (movedRef.current) {
                  movedRef.current = false
                  return
                }
                onPick(m.id)
              }}
              onDoubleClick={(e) => {
                e.preventDefault()
                setEditing({ id: m.id, text: m.label ?? '' })
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                onRemove(m.id)
              }}
              className={`pointer-events-auto flex h-full w-4 cursor-ew-resize touch-none items-end justify-center ${
                draft?.id === m.id ? 'opacity-80' : ''
              }`}
            >
              {/* The flag: a small pennant with a stem down to the ruler edge. */}
              <span className="relative block h-3 w-px bg-ink-3">
                <span
                  className={`absolute top-0 left-0 h-2 w-2.5 rounded-r-[3px] ${COLOR_CLS[m.color ?? 'gold']}`}
                />
              </span>
            </button>
            {m.label && !isEditing ? (
              <span className="pointer-events-none absolute top-0 left-3 max-w-[120px] truncate text-[13px] leading-none text-ink-3">
                {m.label}
              </span>
            ) : null}
            {isEditing ? (
              <input
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                value={editing.text}
                aria-label="ชื่อหมุด"
                placeholder={fmtTimeTenths(m.sec)}
                onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') e.currentTarget.blur()
                  if (e.key === 'Escape') {
                    cancelRenameRef.current = true
                    e.currentTarget.blur()
                  }
                }}
                onPointerDown={(e) => e.stopPropagation()}
                className="pointer-events-auto absolute top-0 left-3 z-10 w-28 rounded-[3px] border border-border bg-surface px-1 text-[13px] leading-[18px] text-ink"
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
})
