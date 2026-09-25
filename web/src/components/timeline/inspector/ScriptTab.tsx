import { Plus } from 'lucide-react'
import { memo } from 'react'
import {
  clamp,
  cutIndexInLine,
  cutLineId,
  cutsInLine,
  lineScriptDraft
} from '../../../lib/timelineMath'
import type { FilmstripStripMap } from '../../../lib/useFilmstripStrips'
import { Textarea } from '../../ui/Input'
import { withShortcut } from '../shortcuts'
import type { WorkingCut } from '../types'

// One frame per angle of the selected line. The angle buttons were black
// rectangles — "2 มุม" with nothing to tell them apart (live report
// 2026-08-13).
//
// These used to be captured here, from a hidden <video> seeked per angle.
// They are now just a tile out of the source's extracted strip: the nearest
// sample to a hair past the cut's start (the very first frame of a trim is
// often a fade, which reads as the black box this replaces). No decode, no
// canvas, no state — a plain lookup that is correct the first time it paints.
function angleThumbUrl(strips: FilmstripStripMap, cut: WorkingCut): string | null {
  const strip = strips[cut.source]
  if (!strip) return null
  const idx = Math.round((cut.in + 0.08) / strip.tileSec - 0.5)
  return strip.urlFor(clamp(idx, 0, strip.count - 1))
}

/** บทพากย์ (dub): the selected line's script, shared by all its angles, and
 * the angles themselves. */
export const ScriptTab = memo(function ScriptTab({
  selectedCut,
  selectedId,
  isHighlight,
  cuts,
  strips,
  onScriptChange,
  onBeginEdit,
  onCommitEdit,
  onSelectCut,
  onAddAngle
}: {
  selectedCut: WorkingCut | null
  selectedId: string | null
  /** ตัดฉากเด่น keeps a per-scene note here instead of a voiceover line. */
  isHighlight: boolean
  cuts: WorkingCut[]
  strips: FilmstripStripMap
  onScriptChange: (lineId: number, script: string) => void
  onBeginEdit: () => void
  onCommitEdit: () => void
  /** An angle thumbnail is a "show me this one" control, not a handle to
   * grab — so it seeks and reveals, unlike a click on a timeline block. */
  onSelectCut: (cut: WorkingCut) => void
  onAddAngle: () => void
}): React.JSX.Element {
  if (!selectedCut) {
    return <p className="text-sm text-muted">เลือกฉากก่อนถึงจะแก้บทพากย์ได้</p>
  }
  const lineCuts = cutsInLine(cuts, cutLineId(selectedCut))
  return (
    <>
      <p className="mb-1.5 text-[13px] text-muted">
        {isHighlight
          ? `โน้ตของฉากนี้ (ไม่บังคับ)`
          : `ประโยคพากย์ที่ ${cutLineId(selectedCut)}` +
            (lineCuts.length > 1 ? ` — แก้ที่นี่ เปลี่ยนทั้ง ${lineCuts.length} มุม` : '')}
      </p>
      <Textarea
        // As typed — spaces and new lines included; trimmed when stored.
        value={lineScriptDraft(cuts, cutLineId(selectedCut))}
        onChange={(e) => onScriptChange(cutLineId(selectedCut), e.target.value)}
        onFocus={onBeginEdit}
        onBlur={onCommitEdit}
        rows={4}
        placeholder={
          isHighlight ? 'พิมพ์โน้ตสำหรับฉากนี้…' : 'พิมพ์สคริปต์สำหรับประโยคนี้ (ใช้ร่วมทุกมุม)…'
        }
      />
      {!isHighlight && (
        <>
          <p className="mt-4 mb-1.5 text-[13px] text-muted">
            มุมของประโยคนี้ <span className="font-semibold text-ink">{lineCuts.length} มุม</span>
          </p>
          <div className="flex items-center gap-1.5">
            {lineCuts.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => onSelectCut(c)}
                title={`มุม ${cutIndexInLine(cuts, c)} · ${(c.out - c.in).toFixed(1)} วิ`}
                className={`h-11 w-[26px] overflow-hidden rounded border bg-black transition-colors duration-state ${
                  c.id === selectedId ? 'border-accent' : 'border-border hover:border-border-strong'
                }`}
              >
                {angleThumbUrl(strips, c) ? (
                  <img
                    src={angleThumbUrl(strips, c) ?? undefined}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : null}
              </button>
            ))}
            <button
              type="button"
              onClick={onAddAngle}
              title={withShortcut('เพิ่มมุมให้ประโยคนี้', 'add-angle')}
              className="flex h-11 w-[26px] items-center justify-center rounded border border-dashed border-border text-muted transition-colors duration-state hover:border-border-strong hover:text-ink"
            >
              <Plus size={12} />
            </button>
          </div>
        </>
      )}
    </>
  )
})
