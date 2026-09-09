import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Clapperboard,
  Film,
  Info,
  Plus,
  RefreshCw,
  Save,
  Square,
  Upload,
  Wand2,
  X
} from 'lucide-react'
import type { Session } from '../App'
import type { ApiSession } from '../lib/videosLocalApi'
import { pollJob } from '../lib/videosLocalApi'
import {
  createStyle,
  deleteStyle,
  getStyle,
  isLegacyEffectsStyle,
  listStyles,
  regenerateStyle,
  updateStyle,
  type StyleDetail,
  type StyleSummary
} from '../lib/stylesApi'
import { pickFile } from '../lib/pickFile'
import { cn } from '../lib/cn'
import { canUseZoomEffects } from '../lib/platformFeatures'
import { emitTokens } from '../lib/sessionBus'
import { usePublishNavSection } from '../lib/navSection'
import { PageHeader } from '../components/shell/PageHeader'
import { Button } from '../components/ui/Button'
import { Chip } from '../components/ui/Chip'
import { Dialog } from '../components/ui/Dialog'
import { Input, Textarea } from '../components/ui/Input'
import { Progress } from '../components/ui/Progress'
import { Skeleton } from '../components/ui/Skeleton'
import { StatusLine } from '../components/ui/StatusLine'

/** Styles library (R8) — the only things left in the คลัง after the overlay
 * half was removed: reusable AI styles the user teaches once from a clip.
 * Two categories, both server-backed rows on /effect-styles split by `kind`:
 *   - สไตล์การตัด  (kind='cut')     — cut rhythm, feeds the dub/highlight edit pass
 *   - สไตล์การซูม  (kind='effects') — camera-motion rhythm, feeds plan-effects
 * Same layout for both (R8 §4): compact card list + a 340px detail panel.
 * The former component/sticker/template categories are gone with the
 * node-sidecar (2026-08-12). */

type Category = 'cutStyles' | 'zoomStyles'

/**
 * Only categories this build can actually USE.
 *
 * A zoom style is distilled by a server-side AI pass and costs the account's
 * allowance, and the only thing that consumes one is the zoom editor — which
 * `canUseZoomEffects` hides in a browser. Offering the library anyway let
 * someone pay for a style, name it, regenerate it and delete it forever
 * without a hint that nothing here would ever apply it.
 */
const ALL_CATEGORIES: {
  id: Category
  label: string
  title: string
  blurb: string
  kind: 'cut' | 'effects'
}[] = [
  {
    id: 'cutStyles',
    label: 'สไตล์การตัด',
    title: 'สไตล์การตัด',
    blurb:
      'สอนจังหวะการตัดของคุณให้ AI จำไว้ครั้งเดียว แล้วเลือกใช้ได้ทุกงาน — เช่น ตัดถี่ ขึ้นฮุกเร็ว หรือปล่อยจังหวะให้อ่านคำบรรยายทัน',
    kind: 'cut'
  },
  {
    id: 'zoomStyles',
    label: 'สไตล์การซูม',
    title: 'สไตล์การซูม',
    blurb: 'แนบคลิปที่ซูมได้ถูกใจไว้ครั้งเดียว AI จะจำวิธีซูมของคุณ แล้วเลือกใช้ได้ทุกงาน',
    kind: 'effects'
  }
]

const CATEGORIES = ALL_CATEGORIES.filter((c) => c.kind === 'cut' || canUseZoomEffects)

// ── shared bits ──────────────────────────────────────────────────────────────

/** dd/mm formatting for meta lines — no year, these are all recent. */
function fmtDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${d.getDate()}/${d.getMonth() + 1}`
}

/** HANDOFF §3: status is a StatusLine, never a pill. The Thai is the user's
 * words, not the API's. A ready-but-legacy zoom style gets its own wording —
 * its prose was distilled from the removed overlay system and would steer the
 * AI toward things the renderer can no longer draw (R8 §9). */
function StyleStatus({ style }: { style: StyleSummary }): React.JSX.Element {
  if (isLegacyEffectsStyle(style)) return <StatusLine status="idle" label="ต้องเรียนรู้ใหม่" />
  if (style.status === 'ready') return <StatusLine status="ok" label="พร้อมใช้" />
  if (style.status === 'error') return <StatusLine status="error" label="เรียนรู้ไม่สำเร็จ" />
  return <StatusLine status="working" label="กำลังเรียนรู้จากคลิป" />
}

const PLATFORM_OPTIONS: { value: string; label: string }[] = [
  { value: 'tiktok', label: 'TikTok' },
  { value: 'reels', label: 'Instagram Reels' },
  { value: 'shorts', label: 'YouTube Shorts' },
  { value: 'youtube', label: 'YouTube ยาว' },
  { value: 'other', label: 'อื่นๆ' }
]

function platformLabel(value: string): string {
  return PLATFORM_OPTIONS.find((o) => o.value === value)?.label ?? value
}

/** Matches the two progress points `distill_style_local` actually reports. */
const DISTILL_STEPS = ['อ่านคลิปอ้างอิง', 'สรุปเป็นสไตล์']

// ── list cards (R8: compact row, details live in the right panel) ────────────

function StyleRow({
  style,
  selected,
  watching,
  progress,
  onSelect,
  onStop
}: {
  style: StyleDetail
  selected: boolean
  watching: boolean
  progress: number
  onSelect: () => void
  onStop: () => void
}): React.JSX.Element {
  const isPending = style.status === 'pending'
  const meta = [
    style.has_reference ? 'มีคลิปอ้างอิง' : 'ไม่มีคลิปอ้างอิง',
    style.kind === 'cut' && style.target_platform ? platformLabel(style.target_platform) : null,
    `แก้ล่าสุด ${fmtDate(style.updated_at)}`
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelect()
      }}
      className={cn(
        'w-full cursor-pointer rounded-md border px-4 py-3.5 text-left transition-colors duration-state ease-out',
        selected ? 'border-accent' : 'border-divider hover:border-border'
      )}
    >
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[17px] font-semibold text-ink">{style.name}</p>
          <p className="mt-1 truncate text-sm tabular-nums text-muted">{meta}</p>
        </div>
        <StyleStatus style={style} />
      </div>
      {isPending && (
        <>
          {/* The two steps are the worker's own phases: it reports 20% while
              reading the clip and 60% once the model starts writing, so the
              boundary is real rather than a guess. */}
          <Progress
            className="mt-3"
            steps={DISTILL_STEPS}
            currentIndex={progress >= 60 ? 1 : 0}
            percent={watching ? progress : 20}
            busy
          />
          <div className="mt-2.5 flex justify-end">
            <Button
              size="sm"
              icon={<Square size={13} fill="currentColor" />}
              onClick={(e) => {
                e.stopPropagation()
                onStop()
              }}
            >
              หยุดการเรียนรู้
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

/** The list ends with what actually runs when no style is picked (R8): the
 * app's own fallback, not a server row — nothing to select, edit or delete. */
function DefaultStyleRow({ kind }: { kind: 'effects' | 'cut' }): React.JSX.Element {
  return (
    <div className="flex items-center gap-4 rounded-md border border-divider px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <p className="text-[17px] font-semibold text-ink">สไตล์เริ่มต้น (ระบบ)</p>
        <p className="mt-1 text-sm text-muted">
          {kind === 'cut'
            ? 'จังหวะกลาง ๆ ใช้ได้กับทุกคลิป — ใช้เมื่อไม่ได้เลือกสไตล์ของตัวเอง'
            : 'ใช้เมื่อไม่ได้เลือกสไตล์ของตัวเอง'}
        </p>
      </div>
      <span className="shrink-0 text-sm text-muted">ของระบบ</span>
    </div>
  )
}

// ── right detail panel (R8: 340px, prose + actions) ─────────────────────────

function StyleDetailPanel({
  style,
  kind,
  reportCopied,
  onEdit,
  onRegenerate,
  onDelete,
  onPickNewReference,
  onCopyReport
}: {
  style: StyleDetail
  kind: 'effects' | 'cut'
  reportCopied: boolean
  onEdit: () => void
  onRegenerate: () => void
  onDelete: () => void
  onPickNewReference: () => void
  onCopyReport: () => void
}): React.JSX.Element {
  const [confirmRegenerate, setConfirmRegenerate] = useState(false)
  const isError = style.status === 'error'
  const legacy = isLegacyEffectsStyle(style)
  const body = style.system_prompt || style.description || 'ยังไม่มีผลวิเคราะห์'

  const regenerateButton = style.has_reference ? (
    <Button
      className="w-full justify-center"
      variant={isError || legacy ? 'primary' : 'secondary'}
      icon={<RefreshCw size={14} />}
      onClick={() => setConfirmRegenerate(true)}
    >
      กลั่นใหม่
    </Button>
  ) : (
    <Button
      className="w-full justify-center"
      icon={<RefreshCw size={14} />}
      disabled
      reasonAs="tooltip"
      disabledReason="ไม่มีคลิปอ้างอิงให้กลั่นซ้ำ"
    >
      กลั่นใหม่
    </Button>
  )

  return (
    <aside className="flex w-full shrink-0 flex-col overflow-hidden border-t border-divider p-5 lg:w-[340px] lg:border-l lg:border-t-0">
      <div>
        <p className="mb-1 text-sm text-muted">สไตล์ที่เลือก</p>
        <p className="text-[17px] font-semibold text-ink">{style.name}</p>
      </div>

      <div className="mt-3.5 border-t border-divider pt-3.5">
        <p className="mb-2 text-sm text-muted">คลิปที่ใช้สอน</p>
        {style.has_reference ? (
          // The clip itself lives on the server and is never streamed back, so
          // this can only ever be a marker. It used to be an empty black
          // rectangle, which reads as a thumbnail that failed to load.
          <div className="flex items-center gap-2.5">
            <div className="flex h-[92px] w-[52px] items-center justify-center rounded-[3px] border border-divider bg-media">
              <Film size={18} className="text-[rgb(243_242_242_/_0.35)]" />
            </div>
            <p className="text-[13px] leading-[1.6] text-ink-3">
              แนบคลิปไว้แล้ว
              <br />
              เก็บอยู่บนเซิร์ฟเวอร์
            </p>
          </div>
        ) : (
          <p className="text-sm text-ink-3">ไม่มีคลิปอ้างอิง — สร้างจากคำอธิบายอย่างเดียว</p>
        )}
      </div>

      <div className="mt-3.5 flex min-h-0 flex-1 flex-col border-t border-divider pt-3.5">
        <p className="mb-1.5 text-sm text-muted">สิ่งที่ AI จับได้จากคลิป</p>
        {isError ? (
          <p className="text-sm leading-[1.7] text-ink-3 select-text">
            {style.error_msg || 'เรียนรู้ไม่สำเร็จ — ลองกลั่นใหม่ หรือแก้คำอธิบายแล้วลองอีกครั้ง'}
          </p>
        ) : (
          <div className="scroll-ghost min-h-0 flex-1 overflow-y-auto pr-1">
            {legacy && (
              <p className="mb-2 flex gap-2 rounded-md bg-[rgb(243_242_242_/_0.04)] p-2.5 text-sm leading-relaxed text-muted">
                <Info size={14} className="mt-0.5 shrink-0" />
                สไตล์นี้เรียนมาจากระบบเอฟเฟกต์เดิมที่ถูกถอดออกแล้ว — กดกลั่นใหม่ให้ AI
                อ่านคลิปอีกครั้งเป็นสไตล์การซูมก่อนใช้
              </p>
            )}
            <p className="whitespace-pre-wrap text-sm leading-[1.7] text-ink-3 select-text">
              {body}
            </p>
          </div>
        )}
      </div>

      <div className="mt-4 flex shrink-0 flex-col gap-2 border-t border-divider pt-4">
        {isError ? (
          <>
            <Button
              className="w-full justify-center"
              icon={<Upload size={14} />}
              onClick={onPickNewReference}
            >
              เลือกคลิปใหม่
            </Button>
            {regenerateButton}
            <button
              type="button"
              onClick={onCopyReport}
              className="inline-flex h-9 w-full items-center justify-center rounded-md text-sm font-semibold text-muted transition-colors duration-state ease-out hover:bg-[rgb(243_242_242_/_0.06)] hover:text-ink"
            >
              {reportCopied ? 'คัดลอกแล้ว' : 'คัดลอกข้อมูลแจ้งปัญหา'}
            </button>
          </>
        ) : (
          <>
            <Button className="w-full justify-center" onClick={onEdit}>
              แก้คำอธิบาย
            </Button>
            {regenerateButton}
          </>
        )}
        <Button className="w-full justify-center" variant="danger" onClick={onDelete}>
          ลบสไตล์
        </Button>
      </div>

      {confirmRegenerate ? (
        <Dialog
          open
          onClose={() => setConfirmRegenerate(false)}
          title="ให้ AI วิเคราะห์ใหม่?"
          subtitle={style.name}
          width={560}
        >
          <p className="text-[15px] leading-[1.7] text-ink-2">
            ระบบจะส่งคลิปอ้างอิงให้ AI ดูอีกครั้งแล้วเขียนสไตล์ขึ้นใหม่ — ผลที่ได้อาจต่างจากเดิม
            และคำอธิบายที่แก้ไว้เองจะถูกเขียนทับ
          </p>
          <div className="mt-4 flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmRegenerate(false)}>
              ยกเลิก
            </Button>
            <Button
              variant="primary"
              icon={<RefreshCw size={15} />}
              onClick={() => {
                setConfirmRegenerate(false)
                onRegenerate()
              }}
            >
              วิเคราะห์ใหม่
            </Button>
          </div>
        </Dialog>
      ) : null}
      {kind === 'cut' && null}
    </aside>
  )
}

// ── create / edit dialogs ────────────────────────────────────────────────────

/** Create dialog — one pass, then the style is reusable forever. Cut styles
 * keep their R6 shape (platform chips, rhythm-flavoured copy); zoom styles use
 * the R8 box: name · clip drop · optional description · 2–3 นาที note. */
function CreateStyleDialog({
  kind,
  busy,
  stage,
  error,
  onCancel,
  onCreate
}: {
  kind: 'effects' | 'cut'
  busy: boolean
  stage: string
  error: string | null
  onCancel: () => void
  onCreate: (input: {
    name: string
    description: string
    refPath: string | null
    platform: string
  }) => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [refPath, setRefPath] = useState<string | null>(null)
  const [refName, setRefName] = useState<string | null>(null)
  const [platform, setPlatform] = useState('tiktok')
  const isZoom = kind === 'effects'

  const pickRef = async (): Promise<void> => {
    // Both style kinds are distilled from footage rhythm — video only.
    const picked = await pickFile('video/*')
    if (!picked) return
    setRefPath(picked.path)
    setRefName(picked.name)
  }

  // The backend refuses a style with neither input; a cut style additionally
  // has nothing to time without footage. The gate says why rather than letting
  // the request fail.
  const blocked = !name.trim()
    ? 'ตั้งชื่อสไตล์ก่อน'
    : kind === 'cut' && !refPath
      ? 'สไตล์การตัดต้องแนบคลิปอ้างอิง'
      : !description.trim() && !refPath
        ? 'แนบคลิปตัวอย่าง หรือใส่คำอธิบายอย่างน้อยหนึ่งอย่าง'
        : null

  return (
    <Dialog
      open
      onClose={onCancel}
      title={isZoom ? 'สร้างสไตล์การซูม' : 'สร้างสไตล์การตัด'}
      subtitle="ทำครั้งเดียว ใช้ได้ทุกงานหลังจากนี้"
      width={680}
    >
      <div className="space-y-4">
        <div
          className={cn(
            'grid gap-4',
            kind === 'cut' ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1'
          )}
        >
          <Input
            label="ชื่อสไตล์"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={isZoom ? 'เช่น ซูมแรงตามจังหวะพูด' : 'เช่น รีวิวสายรัว'}
            autoFocus
          />
          {kind === 'cut' && (
            <div>
              <p className="mb-1.5 text-sm text-muted">ทำไปลงที่ไหน</p>
              <div className="flex flex-wrap gap-1.5">
                {PLATFORM_OPTIONS.map((o) => (
                  <Chip
                    key={o.value}
                    selected={platform === o.value}
                    onClick={() => setPlatform(o.value)}
                  >
                    {o.label}
                  </Chip>
                ))}
              </div>
            </div>
          )}
        </div>

        <div>
          <div className="mb-1.5 flex items-baseline justify-between gap-3">
            <span className="text-sm text-muted">
              {isZoom ? 'คลิปตัวอย่าง' : 'คลิปที่ตัดมาแล้วชอบ'}
            </span>
            <span className="text-sm text-muted">
              {isZoom ? 'ยาวไม่เกิน 5 นาที' : 'ยาวไม่เกิน 20 นาที'}
            </span>
          </div>
          {refName ? (
            <div className="flex items-center gap-3 rounded-md border border-divider p-3">
              <span className="flex h-11 w-8 shrink-0 items-center justify-center rounded-[3px] bg-[rgb(243_242_242_/_0.06)] text-muted">
                <Clapperboard size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] text-ink">{refName}</p>
                <p className="text-sm text-muted">
                  {isZoom
                    ? 'ระบบจะดูจังหวะและระยะการซูม ไม่ใช้ภาพในคลิป'
                    : 'ระบบจะดูจังหวะการตัด ไม่ใช้ภาพในคลิป'}
                </p>
              </div>
              <button
                type="button"
                aria-label="เอาคลิปอ้างอิงออก"
                onClick={() => {
                  setRefPath(null)
                  setRefName(null)
                }}
                className="shrink-0 text-muted transition-colors duration-state ease-out hover:text-ink"
              >
                <X size={16} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void pickRef()}
              className="flex h-16 w-full items-center justify-center gap-2 rounded-md border border-dashed border-border text-sm text-ink-3 transition-colors duration-state ease-out hover:border-accent hover:text-accent"
            >
              <Upload size={15} />
              {isZoom
                ? 'ลากไฟล์มาวาง หรือเลือกจากเครื่อง — คลิปที่ซูมได้อย่างที่คุณชอบ'
                : 'เลือกคลิปอ้างอิง (บังคับ)'}
            </button>
          )}
        </div>

        <div>
          <div className="mb-1.5 flex items-baseline justify-between gap-3">
            <span className="text-sm text-muted">
              {isZoom ? 'อธิบายเพิ่ม (ไม่บังคับ)' : 'อธิบายจังหวะการตัดที่ชอบ'}
            </span>
            <span className="text-sm text-muted">ยิ่งบอกละเอียด ยิ่งตรงใจ</span>
          </div>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={isZoom ? 3 : 4}
            aria-label="คำอธิบายสไตล์"
            placeholder={
              isZoom
                ? 'เช่น ซูมเฉพาะตอนพูดถึงราคา ไม่ซูมตอนโชว์หน้า'
                : 'เช่น ตัดถี่ทุก 1–2 วินาที · ขึ้นฮุกใน 2 วินาทีแรก · ไม่ค้างช็อตเดิมเกิน 3 วินาที'
            }
          />
        </div>

        <p className="flex gap-2.5 rounded-md bg-[rgb(243_242_242_/_0.04)] p-3 text-sm leading-relaxed text-muted">
          <Info size={15} className="mt-0.5 shrink-0" />
          <span>
            การเรียนรู้ใช้เวลาราว 2–3 นาที ระหว่างนั้นใช้งานอย่างอื่นต่อได้ ·
            แก้คำอธิบายภายหลังได้ตลอด และไม่กระทบงานที่ทำไปแล้ว
          </span>
        </p>

        {error && <p className="text-sm text-error">{error}</p>}

        <div className="flex items-center justify-end gap-2 border-t border-divider pt-4">
          <Button variant="ghost" onClick={onCancel}>
            ยกเลิก
          </Button>
          {blocked ? (
            <Button variant="primary" icon={<Wand2 size={16} />} disabled disabledReason={blocked}>
              เริ่มเรียนรู้
            </Button>
          ) : (
            <Button
              variant="primary"
              icon={<Wand2 size={16} />}
              loading={busy}
              onClick={() =>
                onCreate({ name: name.trim(), description: description.trim(), refPath, platform })
              }
            >
              {busy ? stage || 'กำลังทำงาน…' : 'เริ่มเรียนรู้'}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  )
}

/** Edit dialog — rename, reword the description, or hand-correct the prose the
 * distillation produced (the API takes all three in one PUT). */
function EditStyleDialog({
  style,
  onCancel,
  onSave
}: {
  style: StyleDetail
  onCancel: () => void
  onSave: (patch: { name: string; description: string; system_prompt: string }) => void
}): React.JSX.Element {
  const [name, setName] = useState(style.name)
  const [description, setDescription] = useState(style.description ?? '')
  const [prompt, setPrompt] = useState(style.system_prompt ?? '')

  return (
    <Dialog
      open
      onClose={onCancel}
      title="แก้คำอธิบายสไตล์"
      subtitle="มีผลกับงานถัดไป งานที่ทำไปแล้วไม่เปลี่ยน"
      width={680}
    >
      <div className="space-y-4">
        <Input label="ชื่อสไตล์" value={name} onChange={(e) => setName(e.target.value)} />
        <Textarea
          label="คำอธิบายของคุณ"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
        />
        <Textarea
          label="สไตล์ที่ AI สรุปได้ — แก้ได้ตรงนี้"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={8}
        />
        <div className="flex items-center justify-end gap-2 border-t border-divider pt-4">
          <Button variant="ghost" onClick={onCancel}>
            ยกเลิก
          </Button>
          <Button
            variant="primary"
            icon={<Save size={16} />}
            onClick={() =>
              onSave({
                name: name.trim() || style.name,
                description: description.trim(),
                system_prompt: prompt.trim()
              })
            }
          >
            บันทึก
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

// ── the tab (shared by both categories, differs only by kind) ────────────────

function StylesTab({
  session,
  kind,
  createOpen,
  onCreateClose,
  onCountChange
}: {
  session: ApiSession
  kind: 'effects' | 'cut'
  createOpen: boolean
  onCreateClose: () => void
  onCountChange: () => void
}): React.JSX.Element {
  // Details, not summaries: the panel body IS the distilled prose, so the list
  // has to carry it. N is small (a user has a handful of styles) and the list
  // endpoint does not return it.
  const [styles, setStyles] = useState<StyleDetail[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [progress, setProgress] = useState(0)
  const [watchUid, setWatchUid] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<StyleDetail | null>(null)
  const [selectedUid, setSelectedUid] = useState<string | null>(null)
  const [reportCopied, setReportCopied] = useState(false)
  // Set while a distillation is being polled, so the stop control has something
  // to abort. There is no server-side cancel — stopping abandons the poll and
  // removes the pending row, which is what the user means by "หยุด".
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback((): void => {
    listStyles(session, kind)
      .then(async (list) => {
        const details = await Promise.all(
          list.map((s) => getStyle(session, s.uid).catch(() => ({ ...s }) as StyleDetail))
        )
        setStyles(details)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [session, kind])
  useEffect(load, [load])

  // A style stays `pending` until the worker writes the prose, and nothing
  // pushes that to us — poll while any card is still being learned.
  useEffect(() => {
    if (!styles.some((s) => s.status === 'pending')) return
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [styles, load])

  const selected = styles.find((s) => s.uid === selectedUid) ?? styles[0] ?? null

  const runJob = async (jobId: string, uid: string): Promise<void> => {
    const abort = new AbortController()
    abortRef.current = abort
    setWatchUid(uid)
    setProgress(0)
    try {
      await pollJob(
        session,
        jobId,
        (s) => {
          setProgress(s.progress ?? 0)
          const msg = (s.result as { message?: string } | null)?.message
          if (msg) setStage(msg)
        },
        { signal: abort.signal }
      )
    } finally {
      abortRef.current = null
      setWatchUid(null)
      setStage('')
      setProgress(0)
      load()
      onCountChange()
    }
  }

  const create = async (input: {
    name: string
    description: string
    refPath: string | null
    platform: string
  }): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setStage('กำลังส่งให้ AI…')
      const { job_id, style_uid } = await createStyle(session, {
        name: input.name,
        description: input.description,
        referencePath: input.refPath ?? undefined,
        kind,
        targetPlatform: kind === 'cut' ? input.platform : undefined
      })
      onCreateClose()
      setBusy(false)
      setSelectedUid(style_uid)
      load()
      onCountChange()
      await runJob(job_id, style_uid)
    } catch (e) {
      setBusy(false)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** Error card's way out: re-run the distillation against a different clip.
   * The API has no replace-reference route — recreate then drop the old row. */
  const pickNewReference = async (style: StyleDetail): Promise<void> => {
    const picked = await pickFile('video/*')
    if (!picked) return
    setError(null)
    try {
      const { job_id, style_uid } = await createStyle(session, {
        name: style.name,
        description: style.description ?? '',
        referencePath: picked.path,
        kind,
        targetPlatform: kind === 'cut' ? (style.target_platform ?? undefined) : undefined
      })
      await deleteStyle(session, style.uid).catch(() => undefined)
      setSelectedUid(style_uid)
      load()
      onCountChange()
      await runJob(job_id, style_uid)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const regenerate = async (uid: string): Promise<void> => {
    setError(null)
    try {
      const { job_id } = await regenerateStyle(session, uid)
      setStyles((xs) => xs.map((x) => (x.uid === uid ? { ...x, status: 'pending' } : x)))
      await runJob(job_id, uid)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** Stop a distillation in flight: abandon the poll and drop the pending row. */
  const stop = async (uid: string): Promise<void> => {
    if (watchUid === uid) abortRef.current?.abort()
    await deleteStyle(session, uid).catch(() => undefined)
    load()
    onCountChange()
  }

  const remove = async (uid: string): Promise<void> => {
    await deleteStyle(session, uid).catch(() => undefined)
    if (selectedUid === uid) setSelectedUid(null)
    load()
    onCountChange()
  }

  const saveEdit = async (patch: {
    name: string
    description: string
    system_prompt: string
  }): Promise<void> => {
    if (!editing) return
    const uid = editing.uid
    setEditing(null)
    try {
      const next = await updateStyle(session, uid, patch)
      setStyles((xs) => xs.map((x) => (x.uid === uid ? next : x)))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const copyReport = (style: StyleDetail): void => {
    const report = [
      `สไตล์: ${style.name} (${style.uid})`,
      `ชนิด: ${style.kind}`,
      `สถานะ: ${style.status}`,
      `เวลา: ${new Date().toISOString()}`,
      `ข้อความผิดพลาด: ${style.error_msg ?? '(ไม่มี)'}`
    ].join('\n')
    void navigator.clipboard.writeText(report).catch(() => undefined)
    setReportCopied(true)
    window.setTimeout(() => setReportCopied(false), 2000)
  }

  return (
    // Stacked below `lg` the two panes each resolved to 0 height inside an
    // overflow-hidden parent, clipping the detail panel with nothing to
    // scroll. The whole column scrolls as one there instead.
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      <div className="scroll-ghost min-w-0 flex-1 py-5 pl-5 pr-5 sm:pl-8 sm:pr-6 lg:min-h-0 lg:overflow-y-auto">
        {error && <p className="mb-3 text-sm text-error">{error}</p>}

        {loading ? (
          <div className="space-y-2.5">
            <Skeleton className="h-[68px] w-full" />
            <Skeleton className="h-[68px] w-full" />
          </div>
        ) : (
          <div className="space-y-2.5">
            {styles.length === 0 && (
              <div className="rounded-md border border-dashed border-border p-8 text-center">
                <p className="text-[15px] text-ink-2">
                  {kind === 'cut' ? 'ยังไม่มีสไตล์การตัด' : 'ยังไม่มีสไตล์การซูม'}
                </p>
                <p className="mt-1.5 text-sm text-muted">
                  {kind === 'cut'
                    ? 'สอนจังหวะการตัดจากคลิปที่คุณชอบครั้งเดียว แล้วเลือกใช้ได้ทุกงาน'
                    : 'แนบคลิปที่ซูมได้ถูกใจครั้งเดียว แล้วเลือกใช้ได้ทุกงาน'}
                </p>
              </div>
            )}
            {styles.map((st) => (
              <StyleRow
                key={st.uid}
                style={st}
                selected={selected?.uid === st.uid}
                watching={watchUid === st.uid}
                progress={progress}
                onSelect={() => setSelectedUid(st.uid)}
                onStop={() => void stop(st.uid)}
              />
            ))}
            <DefaultStyleRow kind={kind} />
          </div>
        )}
      </div>

      {selected && (
        <StyleDetailPanel
          style={selected}
          kind={kind}
          reportCopied={reportCopied}
          onEdit={() => setEditing(selected)}
          onRegenerate={() => void regenerate(selected.uid)}
          onDelete={() => void remove(selected.uid)}
          onPickNewReference={() => void pickNewReference(selected)}
          onCopyReport={() => copyReport(selected)}
        />
      )}

      {createOpen && (
        <CreateStyleDialog
          kind={kind}
          busy={busy}
          stage={stage}
          error={error}
          onCancel={onCreateClose}
          onCreate={(input) => void create(input)}
        />
      )}
      {editing && (
        <EditStyleDialog
          style={editing}
          onCancel={() => setEditing(null)}
          onSave={(patch) => void saveEdit(patch)}
        />
      )}
    </div>
  )
}

// ── page shell ───────────────────────────────────────────────────────────────

/** Style counts come from the server, so they load with the session. */
function useStyleCounts(
  session: ApiSession,
  nonce: number,
  onCounts: (cut: number, effects: number) => void
): void {
  useEffect(() => {
    let cancelled = false
    void Promise.all([
      listStyles(session, 'cut').catch(() => []),
      listStyles(session, 'effects').catch(() => [])
    ]).then(([cut, effects]) => {
      if (!cancelled) onCounts(cut.length, effects.length)
    })
    return () => {
      cancelled = true
    }
    // Re-runs only when a style is created/deleted; the parent rebuilds
    // `session` and `onCounts` every render, so neither can be a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce])
}

export default function EffectsStudioPage({
  session,
  initialCategory
}: {
  session: Session
  /** Deep link from elsewhere (e.g. the wizard's "สร้างในหน้าสไตล์" opens
   * straight onto สไตล์การซูม instead of the first category). */
  initialCategory?: Category
}): React.JSX.Element {
  const [category, setCategory] = useState<Category>(initialCategory ?? 'cutStyles')
  const [createStyleOpen, setCreateStyleOpen] = useState(false)
  const [styleCounts, setStyleCounts] = useState({ cutStyles: 0, zoomStyles: 0 })
  const [styleNonce, setStyleNonce] = useState(0)

  const apiSession: ApiSession = {
    baseUrl: session.baseUrl,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    // Refreshed tokens used to be DROPPED here (onTokens was a no-op), so the
    // page kept working while the rest of the app -- App state, the service
    // worker, the next page mounted from the same props -- stayed on the dead
    // token. The bus hands them to App, which owns all three.
    onTokens: (access, refresh) => emitTokens(access, refresh)
  }

  useStyleCounts(apiSession, styleNonce, (cut, effects) =>
    setStyleCounts({ cutStyles: cut, zoomStyles: effects })
  )

  const active = CATEGORIES.find((c) => c.id === category)!

  // The categories live in the app's left rail, under the main nav — see
  // lib/navSection.tsx for why the page publishes them upward.
  usePublishNavSection(
    () => ({
      title: 'หมวดในคลัง',
      items: CATEGORIES.map((c) => ({ id: c.id, label: c.label, count: styleCounts[c.id] })),
      activeId: category,
      onSelect: (id) => setCategory(id as Category)
    }),
    [category, styleCounts.cutStyles, styleCounts.zoomStyles]
  )

  return (
    <>
      {/* R8: the page IS the category — its own title, subtitle and create
          button. A fixed heading told you where you were but never what you
          were looking at. */}
      <PageHeader
        title={active.title}
        subtitle={active.blurb}
        actions={
          <Button
            variant="primary"
            icon={<Plus size={16} />}
            onClick={() => setCreateStyleOpen(true)}
          >
            สร้างสไตล์ใหม่
          </Button>
        }
      />

      <StylesTab
        key={active.kind}
        session={apiSession}
        kind={active.kind}
        createOpen={createStyleOpen}
        onCreateClose={() => setCreateStyleOpen(false)}
        onCountChange={() => setStyleNonce((n) => n + 1)}
      />
    </>
  )
}
