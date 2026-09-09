import { useState } from 'react'
import { Check, ChevronDown, Clapperboard, Layers, Mic, Music2, Scissors, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import {
  DUB_DURATION_AUTO,
  DUB_DURATION_FIXED,
  DUB_SCRIPT_STYLES,
  dubTargetDurationSec
} from '../../lib/dubBrief'
import type { StyleSummary } from '../../lib/stylesApi'
import {
  UI_MODE_LABEL,
  VOICEOVER_LABEL,
  captionGate,
  fmtClock,
  type UiMode,
  type VoiceoverChoice,
  type WizardState
} from '../../lib/wizardState'
import { Segmented } from '../ui/Segmented'
import { Select } from '../ui/Select'
import { Switch } from '../ui/Switch'
import { Textarea } from '../ui/Input'
import { Checkbox } from '../ui/Checkbox'
import { CaptionPanel } from './CaptionPanel'
import { canSnapToBeat, canUseOriginalVoice } from '../../lib/platformFeatures'

type Patch = (patch: Partial<WizardState>) => void

const MODE_CARDS: { value: UiMode; icon: typeof Mic; blurb: string; badge?: string }[] = [
  {
    value: 'silence',
    icon: Mic,
    blurb: 'คลิปพูดหน้ากล้อง ตัดช่วงเงียบและเทคซ้ำออก คงเสียงเดิม'
  },
  {
    value: 'highlight',
    // Clapperboard, not scissors — Scissors already means "trim the music" on
    // this same screen, and one glyph cannot mean two things at once.
    icon: Clapperboard,
    blurb: 'เลือกฉากเด่นจากหลายคลิป แล้วตั้งค่าด้านล่างว่าจะพากย์หรือไม่ และจะใส่เพลงไหม'
  },
  {
    value: 'longform',
    // Layers — Mic and Clapperboard are taken on this same grid (R17.8).
    icon: Layers,
    blurb: 'AI ฟังคำพูดในคลิปยาว แล้วตัดช่วงเด่นออกมาเป็นคลิปสั้นหลายคลิป เสียงเดิมทั้งหมด',
    // The result COUNT is what separates this card — it has to be readable
    // before clicking, not discovered after the render.
    badge: 'ได้หลายคลิป'
  }
]

// `original` (ใช้เสียงในคลิป) is offered only where the build enables it —
// hidden on web for now by owner's call (see lib/platformFeatures.ts).
const VOICEOVER_CHOICES: VoiceoverChoice[] = canUseOriginalVoice
  ? ['ai', 'own', 'none', 'original']
  : ['ai', 'own', 'none']

/** What ตัดไฮไลต์จากคลิปยาว does — same shape as the silence-mode row (R14.8):
 * an explanation, not a setting, shown where it is read. */
const LONGFORM_MODE_NOTES = [
  'ถอดเสียงทั้งคลิปแล้วอ่านว่าพูดเรื่องอะไรบ้าง',
  'เลือกช่วงที่ดูจบได้ในตัวเอง ตัดเป็นคลิปแยกทีละช่วง',
  'จำนวนคลิปขึ้นกับเนื้อหา — ช่วงที่ไม่ถึงเกณฑ์จะไม่ถูกนับ'
]

/** What ตัดช่วงเงียบ does for the user. Same sentence the "ตั้งค่าเพิ่มเติม"
 * panel used to hide, split into its three clauses (R14.8) — this is an
 * explanation of the mode, not a setting, so it belongs where it is read. */
const SILENCE_MODE_NOTES = [
  'ดูทุกคลิปแล้วแก้คำที่ถอดเสียงผิด',
  'ตัดช่วงพูดติดหรือพูดซ้ำออก',
  'เก็บช่วงเงียบที่ยังมีภาพสำคัญไว้'
]

/**
 * One setting per row, in a table with a fixed name column (R14.2).
 *
 * Replaces the old `flex-wrap` bag of groups, where two unrelated settings
 * could land on the same line with nothing between them and the group labels
 * were smaller and fainter than the options they named.
 *
 * `align="top"` is for rows whose control is a textarea: the name lines up with
 * the first line of the field instead of with the middle of a 90px box.
 */
function Row({
  label,
  hint,
  first,
  align = 'center',
  children
}: {
  label: string
  /** Second line under the name — "เลือกได้หลายข้อ", "ไม่บังคับ". Never glued
   * to the end of the name: appended there it read as part of the label. */
  hint?: string
  /** The first row has no rule above it; the card's own border is that line. */
  first?: boolean
  align?: 'center' | 'top'
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        // STACKS below `lg`. It used to be a row at every width with a
        // `w-full shrink-0` label: the label took 100% and refused to shrink,
        // and the control cell — `min-w-0 flex-1`, i.e. flex-basis 0 — was
        // therefore laid out at exactly 0px, twenty pixels past the right
        // edge. Every control in step 2 was invisible.
        //
        // `lg`, not `sm`: at 768 the 208px nav rail is back in flow, leaving
        // ~560px, and a 132px label plus gap would put the เสียง rail into
        // 292px it does not fit.
        'flex flex-col gap-2 px-[18px] lg:flex-row lg:gap-5',
        first ? '' : 'border-t border-divider',
        align === 'center' ? 'py-[11px] lg:items-center' : 'py-[13px]'
      )}
    >
      <div className={cn('w-full shrink-0 lg:w-[132px]', align === 'top' && 'lg:pt-[2px]')}>
        <p className="text-sm text-ink-2">{label}</p>
        {hint ? <p className="mt-[3px] text-[12.5px] text-muted">{hint}</p> : null}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

export function WizardStepOutcome({
  state,
  patch,
  cutStyles,
  previewThumb,
  onPickMusic,
  onEditMusicRange
}: {
  state: WizardState
  patch: Patch
  cutStyles: StyleSummary[]
  previewThumb: string | null
  onPickMusic: () => void
  onEditMusicRange: () => void
}): React.JSX.Element {
  const isCut = state.uiMode === 'highlight'
  const isLongform = state.uiMode === 'longform'
  // ใช้เสียงในคลิป (R17): no script, no music — the rows below branch on it.
  const isOriginalVoice = isCut && state.voiceover === 'original'
  // ตัดช่วงเงียบ/ตัดไฮไลต์ have one real setting on this screen and the rest
  // lives in here, so the panel opens with the step in those modes. Switching
  // INTO them later opens it too (see the mode-card handler); switching away
  // never closes it — a panel the user opened stays open. (Initial value only:
  // uiMode changes after mount go through the handler, not this useState.)
  const [advancedOpen, setAdvancedOpen] = useState(!isCut)
  const captions = captionGate(state)
  const musicLen = state.music ? state.music.trimOutSec - state.music.trimInSec : null
  // The number the submission will actually send, not a second guess at it.
  const musicTargetSec = dubTargetDurationSec(state.duration, state.customSec, musicLen)
  // Where the caption text comes from differs per mode, and getting it wrong
  // is the thing users ask about first (R7 screen 1).
  const captionSourceNote = !isCut
    ? 'โหมดนี้ใช้เสียงเดิม — คำบรรยายจะถูกสร้างจากคำพูดในคลิปตามเวลาจริง'
    : state.voiceover === 'own'
      ? 'โหมดนี้พากย์เอง — คำบรรยายจะถูกสร้างจากสคริปต์พากย์ตามเวลาของแต่ละประโยค'
      : 'โหมดนี้ AI ร่างสคริปต์ให้ — คำบรรยายจะถูกสร้างจากสคริปต์พากย์ตามเวลาของแต่ละประโยค'

  return (
    <div className="scroll-ghost flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-6 md:px-10">
      <div className="grid shrink-0 grid-cols-1 gap-4 md:grid-cols-3">
        {MODE_CARDS.map(({ value, icon: Icon, blurb, badge }) => {
          const selected = state.uiMode === value
          return (
            <button
              key={value}
              type="button"
              aria-pressed={selected}
              onClick={() => {
                patch({ uiMode: value })
                // Modes whose main panel has nothing to configure open the
                // advanced panel themselves (R14.8 / R17.8).
                if (value === 'silence' || value === 'longform') setAdvancedOpen(true)
              }}
              className={cn(
                'relative rounded-md border p-[18px] text-left transition-colors duration-state ease-out',
                selected
                  ? 'border-accent bg-accent-tint'
                  : 'border-border-faint hover:border-border-strong'
              )}
            >
              {selected ? (
                <Check size={18} className="absolute right-4 top-4 text-accent" strokeWidth={2.2} />
              ) : null}
              <Icon
                size={20}
                strokeWidth={1.7}
                className={selected ? 'text-accent' : 'text-muted'}
              />
              <p className="mt-2.5 text-[17px] font-semibold text-ink">
                {UI_MODE_LABEL[value]}
                {badge ? (
                  <span className="ml-2 inline-flex h-[22px] items-center rounded-[4px] border border-[rgb(217_164_65_/_0.55)] px-1.5 align-middle text-[12px] font-normal text-accent">
                    {badge}
                  </span>
                ) : null}
              </p>
              <p
                className={cn(
                  'mt-1.5 text-[15px] leading-[1.6]',
                  selected ? 'text-ink-2' : 'text-muted'
                )}
              >
                {blurb}
              </p>
            </button>
          )
        })}
      </div>

      {/* Not `overflow-hidden` despite reading as one card: the cut-style
          dropdown opens downward out of its row, and hidden overflow would cut
          the list off at the row's edge. */}
      <div className="flex shrink-0 flex-col rounded-md border border-border-faint">
        {isCut ? (
          <>
            <Row label="เสียง" first>
              <Segmented
                ariaLabel="เสียง"
                value={state.voiceover}
                onChange={(v) => patch({ voiceover: v as VoiceoverChoice })}
                options={VOICEOVER_CHOICES.map((v) => ({ value: v, label: VOICEOVER_LABEL[v] }))}
              />
              {isOriginalVoice ? (
                <p className="mt-[7px] text-[13px] leading-[1.55] text-[#8a8681]">
                  AI อ่านคำพูดในคลิปแล้วเลือกช่วงที่ร้อยเป็นเรื่องเดียวกัน คงเสียงต้นฉบับ
                  ไม่มีเสียงพากย์ · ไม่ส่งวิดีโอขึ้นเซิร์ฟเวอร์
                </p>
              ) : (
                // What this family of choices actually means for the sound —
                // said HERE, before anything is cut, not discovered from a
                // silent result (owner's request 2026-09-09).
                <p className="mt-[7px] text-[13px] leading-[1.55] text-[#8a8681]">
                  โหมดนี้ไม่ใช้เสียงในคลิปเลย — ได้คลิปที่ตัดภาพไว้ให้ แล้วนำไปพากย์เสียงเองภายหลัง
                </p>
              )}
            </Row>

            {/* Both of these answer "where does the script come from", so they
                take the same slot: the styles when AI writes it, the script
                itself when the user does. Voiceover "none" has no answer and
                no row. */}
            {state.voiceover === 'ai' ? (
              <Row label="สไตล์สคริปต์" hint="เลือกได้หลายข้อ">
                <div className="flex flex-wrap items-center gap-[22px]">
                  {DUB_SCRIPT_STYLES.map(({ value, label }) => (
                    <Checkbox
                      key={value}
                      id={`script-style-${value}`}
                      label={label}
                      checked={state.scriptStyles.includes(value)}
                      onChange={() =>
                        patch({
                          scriptStyles: state.scriptStyles.includes(value)
                            ? state.scriptStyles.filter((s) => s !== value)
                            : [...state.scriptStyles, value]
                        })
                      }
                    />
                  ))}
                </div>
              </Row>
            ) : null}

            {state.voiceover === 'own' ? (
              <Row label="สคริปต์พากย์" hint="บรรทัดละประโยค" align="top">
                <Textarea
                  rows={4}
                  value={state.userScript}
                  onChange={(e) => patch({ userScript: e.target.value })}
                  placeholder={'บรรทัดละหนึ่งประโยคพากย์'}
                />
                <p className="mt-[7px] text-[13px] text-muted">AI จะเลือกฉากให้ตรงกับแต่ละบรรทัด</p>
              </Row>
            ) : null}

            <Row label="ความยาว">
              <div className="flex flex-wrap items-center gap-3">
                <Segmented
                  ariaLabel="ความยาว"
                  value={state.duration}
                  onChange={(duration) => patch({ duration })}
                  options={DUB_DURATION_FIXED.map((c) => ({
                    value: c.value,
                    label: c.label,
                    numeric: c.value !== 'custom'
                  }))}
                />
                {state.duration === 'custom' ? (
                  <input
                    type="number"
                    min={15}
                    max={600}
                    aria-label="ความยาวเป็นวินาที"
                    value={state.customSec}
                    onChange={(e) => patch({ customSec: e.target.value })}
                    placeholder="วินาที"
                    className="h-[34px] w-24 rounded-md border border-border bg-transparent px-2.5 text-sm tabular-nums text-ink transition-colors duration-state ease-out"
                  />
                ) : null}
                {/* The right-hand pair is not "two more numbers", it is
                    "let the system decide" — so it sits outside the rail,
                    behind a divider, as ordinary buttons. Kept together in one
                    flex box so a narrow window drops the whole group onto the
                    next line instead of splitting it. */}
                <div className="flex items-center gap-3">
                  <span aria-hidden className="mx-0.5 h-5 w-px bg-border-faint" />
                  {DUB_DURATION_AUTO.map((c) => {
                    const blocked = c.value === 'music' && (isOriginalVoice || !state.music)
                    const on = state.duration === c.value
                    return (
                      <button
                        key={c.value}
                        type="button"
                        disabled={blocked}
                        aria-pressed={on}
                        onClick={() => patch({ duration: c.value })}
                        className={cn(
                          'flex h-[34px] items-center rounded-md border px-[13px] text-sm transition-colors duration-state ease-out',
                          on
                            ? 'border-accent bg-accent-tint font-semibold text-accent'
                            : 'border-border-faint text-ink-2 hover:border-border-strong hover:bg-[rgb(243_242_242_/_0.06)]',
                          blocked &&
                            'cursor-not-allowed border-[rgb(243_242_242_/_0.10)] text-[rgb(243_242_242_/_0.34)] hover:border-[rgb(243_242_242_/_0.10)] hover:bg-transparent'
                        )}
                      >
                        {c.label}
                      </button>
                    )
                  })}
                  {/* Why it is unavailable, or what picking it works out to —
                      beside the button, not in a tooltip nobody hovers. */}
                  {isOriginalVoice ? (
                    <span className="text-[13px] text-muted">โหมดนี้ยังใส่เพลงไม่ได้</span>
                  ) : !state.music ? (
                    <span className="text-[13px] text-muted">เลือกเพลงก่อน</span>
                  ) : state.duration === 'music' && musicTargetSec ? (
                    <span className="text-[13px] tabular-nums text-muted">
                      ≈ {musicTargetSec} วินาที
                    </span>
                  ) : null}
                </div>
              </div>
            </Row>

            {/* A list, whatever the count. The row used to be chips below a
                threshold and a dropdown above it, so the screen looked
                different on every machine. */}
            <Row label="สไตล์การตัด">
              <div className="flex items-center gap-3.5">
                <div className="w-full max-w-[280px]">
                  <Select
                    dense
                    value={state.cutStyleUid ?? ''}
                    onValueChange={(v) => patch({ cutStyleUid: v })}
                    options={[
                      { value: '', label: 'สไตล์เริ่มต้น (ระบบ)' },
                      ...cutStyles.map((s) => ({ value: s.uid, label: s.name }))
                    ]}
                  />
                </div>
                {cutStyles.length > 0 ? (
                  <span className="text-[13px] text-muted">
                    มี {cutStyles.length} สไตล์ที่บันทึกไว้
                  </span>
                ) : null}
              </div>
            </Row>

            {/* Two quality dials. Deliberately worded around what the user
                gets, never how it works — no vendor, no frame rate. */}
            <Row label="รุ่น AI" hint="ตัวไหนเป็นคนตัด">
              <Segmented
                ariaLabel="รุ่น AI"
                value={state.engine}
                onChange={(v) => patch({ engine: v as WizardState['engine'] })}
                options={[
                  { value: 'lite', label: 'Lite' },
                  { value: 'pro', label: 'Pro' }
                ]}
              />
              <p className="mt-[7px] text-[13px] leading-[1.55] text-[#8a8681]">
                {state.engine === 'lite'
                  ? 'เร็วและประหยัดกว่า เหมาะกับคลิปง่าย ๆ หรือลองดูก่อน'
                  : 'อ่านฟุตเทจได้ลึกกว่า เลือกช็อตแม่นกว่า — แนะนำสำหรับงานจริง'}
              </p>
            </Row>

            <Row label="ความละเอียด" hint="AI ดูคลิปถี่แค่ไหน">
              <Segmented
                ariaLabel="ความละเอียด"
                value={state.precision}
                onChange={(v) => patch({ precision: v as WizardState['precision'] })}
                options={[
                  { value: 'standard', label: 'Standard' },
                  { value: 'high', label: 'High' }
                ]}
              />
              <p className="mt-[7px] text-[13px] leading-[1.55] text-[#8a8681]">
                {state.precision === 'high'
                  ? 'AI ดูคลิปละเอียดขึ้น 5 เท่า จับจังหวะสั้น ๆ ที่ระดับปกติมองข้าม — ใช้เวลานานขึ้นและคิดค่าใช้จ่ายมากกว่า'
                  : 'สมดุลระหว่างคุณภาพกับความเร็ว เหมาะกับงานทั่วไป'}
              </p>
            </Row>

            <Row label="เพลงประกอบ">
              <div className="flex flex-wrap items-center gap-3">
                {isOriginalVoice ? (
                  // Disabled with its reason, not hidden — the user must see
                  // WHY the row went quiet when they picked ใช้เสียงในคลิป.
                  <span className="text-[13px] leading-[1.6] text-muted">
                    โหมดนี้ใช้เสียงในคลิป ยังผสมเพลงทับไม่ได้
                  </span>
                ) : state.music ? (
                  <>
                    <span className="inline-flex h-[34px] max-w-[280px] items-center gap-2 rounded-md border border-accent bg-accent-tint px-3 text-sm text-accent">
                      <Music2 size={14} className="shrink-0" />
                      <span className="truncate">{state.music.name}</span>
                      <span className="shrink-0 tabular-nums">
                        {fmtClock(state.music.trimOutSec - state.music.trimInSec)}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={onEditMusicRange}
                      aria-label="แก้ช่วงเพลง"
                      className="flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors duration-state ease-out hover:bg-[rgb(243_242_242_/_0.06)] hover:text-ink"
                    >
                      <Scissors size={15} />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        patch({
                          music: null,
                          beatSync: false,
                          duration: state.duration === 'music' ? '' : state.duration
                        })
                      }
                      aria-label="เอาเพลงออก"
                      className="flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors duration-state ease-out hover:bg-[rgb(243_242_242_/_0.06)] hover:text-error"
                    >
                      <X size={15} />
                    </button>
                    {/* Hidden where the build cannot do it: the cut comes
                        out byte-identical with this on or off, and the
                        timeline editor already hides its own snap control
                        behind the same flag. */}
                    {canSnapToBeat ? (
                      <Switch
                        checked={state.beatSync}
                        onChange={(beatSync) => patch({ beatSync })}
                        label="ตัดตามจังหวะ"
                      />
                    ) : null}
                  </>
                ) : (
                  <>
                    {/* "ไม่ใส่" is a real picked value, not an empty slot — the
                        row has to read as an answered question before a file
                        exists. Picking the other side opens the file dialog;
                        the state only changes once a file comes back. */}
                    <Segmented
                      ariaLabel="เพลงประกอบ"
                      value="none"
                      onChange={(v) => {
                        if (v === 'pick') onPickMusic()
                      }}
                      options={[
                        { value: 'none', label: 'ไม่ใส่' },
                        {
                          value: 'pick',
                          ariaLabel: 'เลือกไฟล์เพลง',
                          label: (
                            <>
                              <Music2 size={14} /> เลือกไฟล์เพลง
                            </>
                          )
                        }
                      ]}
                    />
                    {canSnapToBeat ? (
                      <Switch
                        checked={false}
                        onChange={() => undefined}
                        label="ตัดตามจังหวะ"
                        disabled
                        disabledReason="เลือกเพลงก่อน"
                      />
                    ) : null}
                  </>
                )}
              </div>
            </Row>

            <Row label="เล่าให้ AI ฟัง" hint="ไม่บังคับ" align="top">
              <Textarea
                rows={2}
                value={state.note}
                onChange={(e) => patch({ note: e.target.value })}
                placeholder="เช่น รีวิวลิปทินท์ เน้นว่าติดทน ปิดท้ายชวนกดลิงก์ในไบโอ"
              />
            </Row>
          </>
        ) : isLongform ? (
          <>
            <Row label="ความยาวไฮไลต์" first>
              <div className="flex flex-wrap items-center gap-3">
                <Segmented
                  ariaLabel="ความยาวไฮไลต์"
                  value={state.duration}
                  onChange={(duration) => patch({ duration })}
                  options={[
                    { value: '30', label: '30 วิ', numeric: true },
                    { value: '60', label: '60 วิ', numeric: true },
                    { value: '90', label: '90 วิ', numeric: true },
                    { value: 'custom', label: 'กำหนดเอง' }
                  ]}
                />
                {state.duration === 'custom' ? (
                  <input
                    type="number"
                    min={15}
                    max={600}
                    aria-label="ความยาวไฮไลต์เป็นวินาที"
                    value={state.customSec}
                    onChange={(e) => patch({ customSec: e.target.value })}
                    placeholder="วินาที"
                    className="h-[34px] w-24 rounded-md border border-border bg-transparent px-2.5 text-sm tabular-nums text-ink transition-colors duration-state ease-out"
                  />
                ) : null}
                {/* R14.5 shape: "let the system decide" sits outside the rail.
                    No "ตามความยาวเพลง" here — this mode has no music at all. */}
                <div className="flex items-center gap-3">
                  <span aria-hidden className="mx-0.5 h-5 w-px bg-border-faint" />
                  <button
                    type="button"
                    aria-pressed={state.duration === 'auto'}
                    onClick={() => patch({ duration: 'auto' })}
                    className={cn(
                      'flex h-[34px] items-center rounded-md border px-[13px] text-sm transition-colors duration-state ease-out',
                      state.duration === 'auto'
                        ? 'border-accent bg-accent-tint font-semibold text-accent'
                        : 'border-border-faint text-ink-2 hover:border-border-strong hover:bg-[rgb(243_242_242_/_0.06)]'
                    )}
                  >
                    ให้ AI เลือก
                  </button>
                  <span className="text-[13px] text-muted">ความยาวต่อไฮไลต์หนึ่งคลิป</span>
                </div>
              </div>
            </Row>

            <Row label="โหมดนี้ทำอะไร" align="top">
              <div className="flex flex-col gap-[7px] text-sm leading-[1.6] text-muted">
                {LONGFORM_MODE_NOTES.map((note) => (
                  <span key={note} className="flex gap-[9px]">
                    <span aria-hidden className="opacity-70">
                      ·
                    </span>
                    {note}
                  </span>
                ))}
              </div>
            </Row>

            <Row label="เล่าให้ AI ฟัง" hint="ไม่บังคับ" align="top">
              <Textarea
                rows={2}
                value={state.note}
                onChange={(e) => patch({ note: e.target.value })}
                placeholder="เช่น พอดแคสต์เรื่องการลงทุน เน้นช่วงที่แขกเล่าเคสจริง"
              />
            </Row>
          </>
        ) : (
          <>
            <Row label="บริบท / ชื่อสินค้า" hint="ไม่บังคับ" align="top" first>
              <Textarea
                rows={2}
                value={state.note}
                onChange={(e) => patch({ note: e.target.value })}
                // Two different jobs, two different examples: ตัดฉากเด่น wants
                // creative direction for the script, ตัดช่วงเงียบ only uses
                // this as spelling/context hints for the transcript.
                placeholder="เช่น รีวิวลิปทินท์แบรนด์ Rom&nd รุ่น Juicy Lasting"
              />
              <p className="mt-[7px] text-[13px] text-muted">
                ช่วยให้ AI สะกดชื่อแบรนด์ถูกตอนถอดเสียง
              </p>
            </Row>

            <Row label="โหมดนี้ทำอะไร" align="top">
              <div className="flex flex-col gap-[7px] text-sm leading-[1.6] text-muted">
                {SILENCE_MODE_NOTES.map((note) => (
                  <span key={note} className="flex gap-[9px]">
                    <span aria-hidden className="opacity-70">
                      ·
                    </span>
                    {note}
                  </span>
                ))}
              </div>
            </Row>
          </>
        )}
      </div>

      <div className="shrink-0 rounded-md border border-divider">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          aria-expanded={advancedOpen}
          className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
        >
          <span className="flex items-center gap-2 text-[15px] text-ink">
            <ChevronDown
              size={16}
              className={cn(
                'text-muted transition-transform duration-state ease-out',
                // HANDOFF §3: this collapsible's chevron-down rotates to -90deg
                // over --duration-state, not 180deg over --duration-panel.
                advancedOpen && '-rotate-90'
              )}
            />
            ตั้งค่าเพิ่มเติม
            <span className="text-muted">
              — คำบรรยาย{state.files.length > 1 ? ' · การแยกโปรเจกต์' : ''}
            </span>
          </span>
          <span className="text-sm text-muted">{advancedOpen ? 'ซ่อน' : 'ใช้ค่าที่ตั้งไว้'}</span>
        </button>

        {advancedOpen ? (
          <div className="flex flex-col gap-5 border-t border-divider px-5 py-5">
            <div>
              <div className="flex items-center gap-3">
                {captions.ok ? (
                  <Switch
                    checked={state.captionEnabled}
                    onChange={(captionEnabled) => patch({ captionEnabled })}
                    label="ใส่คำบรรยาย"
                  />
                ) : (
                  <Switch
                    checked={false}
                    onChange={() => undefined}
                    label="ใส่คำบรรยาย"
                    disabled
                    disabledReason={captions.reason ?? ''}
                  />
                )}
              </div>
              {captions.ok && state.captionEnabled ? (
                <div className="mt-4">
                  <p className="mb-3 text-sm text-muted">{captionSourceNote}</p>
                  <CaptionPanel
                    style={state.captionStyle}
                    onChange={(captionStyle) => patch({ captionStyle })}
                    previewThumb={previewThumb}
                  />
                </div>
              ) : null}
            </div>

            {state.files.length > 1 ? (
              <div className="border-t border-divider pt-5">
                <p className="mb-2.5 text-sm text-muted">คลิปหลายไฟล์</p>
                <div className="flex flex-col gap-2.5">
                  <Checkbox
                    checked={state.uploadMode === 'merge'}
                    onChange={() => patch({ uploadMode: 'merge' })}
                    label="รวมเป็นวิดีโอเดียว — ต่อคลิปตามลำดับที่เรียงไว้"
                  />
                  <Checkbox
                    checked={state.uploadMode === 'separate'}
                    onChange={() => patch({ uploadMode: 'separate' })}
                    label={`แยกเป็นคนละโปรเจกต์ — สร้าง ${state.files.length} งาน คลิปละ 1 วิดีโอ`}
                  />
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
