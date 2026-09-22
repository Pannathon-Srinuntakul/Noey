import { Loader2, Music2, RefreshCw, Trash2, Volume2, VolumeX } from 'lucide-react'
import { memo } from 'react'
import type { EditorMusic, MusicPatch } from '../../../lib/editorApi'
import { featureLockedLine } from '../../../lib/planLadder'
import { useUsageInfo } from '../../../lib/usageInfo'
import { MIN_LANE_PX, MUSIC_LANE_PX } from '../constants'
import { MusicBlock } from './MusicBlock'
import { TrackRow } from './TrackRow'

/**
 * เพลง — both modes. The R3 ตัดช่วงเงียบ variant carries this lane too; music
 * is attached to the project, not to whether AI wrote the script.
 *
 * It takes the committed track, not the live drag draft: a drag is drawn by
 * MusicBlock's own state, and the draft reaches the editor only for the audio
 * preview and the beat ticks.
 */
export const MusicLane = memo(function MusicLane({
  music,
  musicPeaks,
  musicDurationSec,
  musicBusy,
  editedDur,
  outputCutBoundaries,
  snapToBeatEnabled,
  pxPerSec,
  contentW,
  onLaneBackgroundPointerDown,
  onCommitMusic,
  onMusicDraft,
  onPickMusic,
  onRemoveMusic
}: {
  music: EditorMusic | null
  musicPeaks: number[] | null
  musicDurationSec: number
  musicBusy: boolean
  editedDur: number
  /** Scene boundaries on the output clock — what a dragged track snaps to. */
  outputCutBoundaries: number[]
  snapToBeatEnabled: boolean
  pxPerSec: number
  contentW: number
  onLaneBackgroundPointerDown: (e: React.PointerEvent) => void
  onCommitMusic: (patch: MusicPatch) => void
  onMusicDraft: (patch: MusicPatch | null) => void
  onPickMusic: () => void
  onRemoveMusic: () => void
}): React.JSX.Element {
  const { usage } = useUsageInfo()
  const musicLocked =
    usage?.features && !usage.features.music
      ? featureLockedLine('music', usage.features.music_min_plan)
      : null
  return (
    <TrackRow
      heightPx={MUSIC_LANE_PX}
      label={
        <>
          เพลง
          {music && (
            <span className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => onCommitMusic({ muted: !music.muted })}
                title={music.muted ? 'เปิดเสียงเพลง' : 'ปิดเสียงเพลง'}
                className="rounded p-0.5 text-muted transition-colors duration-state hover:text-ink"
              >
                {music.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
              </button>
              <button
                type="button"
                onClick={() => onPickMusic()}
                disabled={musicBusy}
                title="เปลี่ยนเพลง"
                className="rounded p-0.5 text-muted transition-colors duration-state hover:text-ink disabled:opacity-40"
              >
                <RefreshCw size={12} />
              </button>
              <button
                type="button"
                onClick={() => onRemoveMusic()}
                disabled={musicBusy}
                title="ลบเพลงประกอบ"
                className="rounded p-0.5 text-muted transition-colors duration-state hover:text-error disabled:opacity-40"
              >
                <Trash2 size={12} />
              </button>
            </span>
          )}
        </>
      }
      laneClassName="relative h-full"
      contentW={contentW}
      onLanePointerDown={onLaneBackgroundPointerDown}
    >
      {music ? (
        <MusicBlock
          music={music}
          peaks={musicPeaks}
          fullDurationSec={musicDurationSec}
          pxPerSec={pxPerSec}
          cutBoundaries={outputCutBoundaries}
          snapEnabled={snapToBeatEnabled}
          onChange={onCommitMusic}
          onDraftChange={onMusicDraft}
        />
      ) : musicLocked ? (
        // No background music on this plan (docs/token-billing-plan.md §8) —
        // a track already on a project stays (above); only adding is locked.
        <span
          className="flex h-full items-center justify-center rounded-md border border-dashed border-border-faint text-[13px] text-muted"
          style={{ width: Math.max(editedDur * pxPerSec, MIN_LANE_PX) }}
        >
          {musicLocked}
        </span>
      ) : (
        <button
          type="button"
          data-cut-block
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onPickMusic()}
          disabled={musicBusy}
          className="flex h-full items-center justify-center gap-2 rounded-md border border-dashed border-border text-[13px] text-muted transition-colors duration-state hover:border-border-strong hover:text-ink disabled:opacity-50"
          style={{ width: Math.max(editedDur * pxPerSec, MIN_LANE_PX) }}
        >
          {musicBusy ? <Loader2 size={13} className="animate-spin" /> : <Music2 size={13} />}
          เพิ่มเพลงประกอบ — ไฟล์เพลง หรือวิดีโอที่มีเพลงก็ได้
        </button>
      )}
    </TrackRow>
  )
})
