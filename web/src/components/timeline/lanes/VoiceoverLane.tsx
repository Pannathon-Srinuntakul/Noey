import { memo } from 'react'
import type { VoiceoverLineBlock } from '../../../lib/timelineMath'
import { VO_LANE_PX } from '../constants'
import { TrackRow } from './TrackRow'

/**
 * บทพากย์ (dub) — one block per voiceover line on the edited clock. The
 * selected scene's line is the accent; the line the playhead is inside is the
 * gold "speaking" one, so the clip can be read along while it plays without
 * every scene change stealing the selection.
 */
export const VoiceoverLane = memo(function VoiceoverLane({
  voBlocks,
  playingLineId,
  selectedLineId,
  pxPerSec,
  contentW,
  onLaneBackgroundPointerDown,
  onPickLine
}: {
  voBlocks: VoiceoverLineBlock[]
  /** The line under the playhead. */
  playingLineId: number | null
  /** The selected scene's line. */
  selectedLineId: number | null
  pxPerSec: number
  contentW: number
  onLaneBackgroundPointerDown: (e: React.PointerEvent) => void
  /** A line was clicked: select its first scene and play from where the line
   * starts. Clicking a line means "show me this one", so it seeks — unlike a
   * click on a scene block, which only selects. */
  onPickLine: (firstCutId: string, outStartSec: number) => void
}): React.JSX.Element {
  return (
    <TrackRow
      heightPx={VO_LANE_PX}
      label="บทพากย์"
      laneClassName="relative h-full rounded-md bg-surface"
      contentW={contentW}
      onLanePointerDown={onLaneBackgroundPointerDown}
    >
      {voBlocks.map((b) => {
        const isActive = selectedLineId !== null && selectedLineId === b.lineId
        const isSpeaking = b.lineId === playingLineId
        return (
          <button
            key={b.lineId}
            type="button"
            data-cut-block
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onPickLine(b.firstCutId, b.outStart)}
            title={b.script || `ประโยค ${b.lineId}`}
            className={`absolute inset-y-0.5 overflow-hidden rounded border px-2 text-left text-[13px] transition-colors duration-state ${
              isActive
                ? 'border-accent bg-accent-nav text-accent'
                : isSpeaking
                  ? 'border-[rgb(217_164_65_/_0.45)] bg-[rgb(217_164_65_/_0.08)] text-ink'
                  : 'border-border bg-ground text-muted hover:text-ink'
            }`}
            style={{
              left: b.outStart * pxPerSec,
              width: Math.max(b.durationSec * pxPerSec - 2, 20)
            }}
          >
            <span className="truncate">
              {b.lineId}
              {b.script ? ` · ${b.script}` : ''}
            </span>
          </button>
        )
      })}
      {voBlocks.length === 0 && (
        <p className="flex h-full items-center px-3 text-[13px] text-muted">
          ยังไม่มีบทพากย์ช่วงนี้
        </p>
      )}
    </TrackRow>
  )
})
