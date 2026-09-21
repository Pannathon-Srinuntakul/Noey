import { memo } from 'react'
import { HEADER_COL_PX, RULER_PX } from './constants'

/**
 * The music's beats as faint lines down the lanes (edited view). Behind the
 * lanes (-z-10): a guide for the eye — painted over a block's own artwork or
 * label, they make both harder to read (HANDOFF §3).
 */
export const BeatTicks = memo(function BeatTicks({
  beats,
  trimInSec,
  offsetSec,
  editedDur,
  pxPerSec
}: {
  /** Beat times in the music file. */
  beats: number[]
  trimInSec: number
  offsetSec: number
  editedDur: number
  pxPerSec: number
}): React.JSX.Element {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 -z-10"
      style={{ top: RULER_PX }}
    >
      {beats.map((b, i) => {
        const outputSec = b - trimInSec + offsetSec
        if (outputSec < 0 || outputSec > editedDur) return null
        return (
          <div
            key={i}
            className="absolute top-0 bottom-0 w-px bg-[rgb(217_164_65_/_0.4)]"
            style={{ left: HEADER_COL_PX + outputSec * pxPerSec }}
          />
        )
      })}
    </div>
  )
})
