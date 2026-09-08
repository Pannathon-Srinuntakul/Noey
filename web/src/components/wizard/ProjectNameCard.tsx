import {
  defaultProjectName,
  fmtClock,
  mergeNameValue,
  projectCount,
  type WizardFile,
  type WizardState
} from '../../lib/wizardState'
import { Input } from '../ui/Input'
import { ClipThumbnail } from './ClipThumbnail'

/** `IMG_2989.mov · 4:12 · 1080 × 1920` — whatever of it is known yet. */
function clipMeta(clip: WizardFile): string {
  const parts: string[] = [clip.name]
  if (clip.durationSec !== null) parts.push(fmtClock(clip.durationSec))
  if (clip.width && clip.height) parts.push(`${clip.width} × ${clip.height}`)
  return parts.join(' · ')
}

/**
 * "ชื่อโปรเจกต์" — step 3's first card, above the summary table (R11.3/R11.4).
 *
 * Deliberately NOT a row in that table: every row there carries a "แก้" link
 * that jumps back to the step which owns the value, and the name has no step to
 * jump to. It is edited here or nowhere.
 *
 * Merge mode names the single project and previews the clips that will be
 * concatenated. Separate mode names each clip's own project, one row each.
 */
export function ProjectNameCard({
  state,
  onChangeName,
  onChangeFileName
}: {
  state: WizardState
  /** Merge mode — also marks the field as touched, which stops the prefill. */
  onChangeName: (value: string) => void
  /** Separate mode — per clip id. */
  onChangeFileName: (id: string, value: string) => void
}): React.JSX.Element {
  const separate = projectCount(state) > 1

  if (separate) {
    return (
      <div className="shrink-0 rounded-md border border-[rgb(217_164_65_/_0.4)] bg-[#1e1c19] px-5 py-4">
        <p className="text-[15px] font-semibold text-ink">ชื่อโปรเจกต์แต่ละคลิป</p>
        <p className="mt-[7px] text-[13.5px] text-muted">
          แต่ละคลิปกลายเป็นโปรเจกต์แยก ตั้งชื่อทีละอันได้ · เว้นว่างไว้จะใช้ชื่อไฟล์
        </p>
        <div className="scroll-ghost mt-2.5 flex max-h-[268px] flex-col gap-px overflow-y-auto rounded-[5px] border border-[rgb(243_242_242_/_0.1)]">
          {state.files.map((clip) => (
            <div key={clip.id} className="flex items-center gap-3 bg-[#191715] px-3 py-[11px]">
              <ClipThumbnail
                file={clip.file}
                path={clip.path}
                pending="blank"
                className="h-[78px] w-11 rounded-[4px] border border-[rgb(243_242_242_/_0.14)] bg-[#0e0d0c]"
              />
              <div className="flex min-w-0 flex-1 flex-col gap-[7px]">
                <Input
                  value={clip.projectName ?? defaultProjectName([clip])}
                  onChange={(e) => onChangeFileName(clip.id, e.target.value)}
                  placeholder={defaultProjectName([clip])}
                  aria-label={`ชื่อโปรเจกต์ของ ${clip.name}`}
                />
                <span className="truncate text-[12.5px] tabular-nums text-muted">
                  {clipMeta(clip)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="shrink-0 rounded-md border border-[rgb(217_164_65_/_0.4)] bg-[#1e1c19] px-5 py-4">
      <div className="flex items-center gap-4">
        <label
          htmlFor="wizard-project-name"
          className="shrink-0 text-[15px] font-semibold text-ink"
        >
          ชื่อโปรเจกต์
        </label>
        <div className="min-w-0 flex-1">
          <Input
            id="wizard-project-name"
            fieldSize="lg"
            value={mergeNameValue(state)}
            onChange={(e) => onChangeName(e.target.value)}
            placeholder={defaultProjectName(state.files)}
          />
        </div>
      </div>
      <p className="mt-[9px] text-[13.5px] text-muted">
        ใช้ในหน้าโปรเจกต์ และชื่อไฟล์ที่ส่งออก · เปลี่ยนทีหลังได้
      </p>
      {state.files.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-[9px] gap-y-2 border-t border-[rgb(243_242_242_/_0.1)] pt-3">
          {/* Only as many as fit — the strip is orientation, not an inventory;
              the full list with its ordering lives in step 1. */}
          {state.files.slice(0, 6).map((clip) => (
            <span key={clip.id} className="relative shrink-0">
              <ClipThumbnail
                file={clip.file}
                path={clip.path}
                pending="blank"
                className="h-[78px] w-11 rounded-[4px] border border-[rgb(243_242_242_/_0.14)] bg-[#0e0d0c]"
              />
              {clip.durationSec !== null ? (
                <span className="absolute inset-x-0 bottom-0 bg-[rgb(9_8_7_/_0.72)] pb-[3px] pt-[2px] text-center text-[10px] tabular-nums text-ink-2">
                  {fmtClock(clip.durationSec)}
                </span>
              ) : null}
            </span>
          ))}
          <span className="text-[13px] leading-[1.6] text-muted">
            {state.files.length > 1
              ? `${state.files.length} คลิปนี้จะต่อกันเป็นวิดีโอเดียว`
              : 'คลิปนี้จะกลายเป็นวิดีโอเดียว'}
            <br />
            ลากเรียงลำดับได้ในขั้นที่ 1
          </span>
        </div>
      ) : null}
    </div>
  )
}
