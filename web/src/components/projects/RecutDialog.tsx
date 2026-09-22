import { useEffect, useMemo, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import type { LocalProject } from '@renderer/platform/types'
import { useJobs } from '../../lib/jobs'
import { MODE_LABEL } from '../../lib/modeLabel'
import { listStyles } from '../../lib/stylesApi'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Textarea } from '../ui/Input'
import { UsageEstimateLine } from '../wizard/UsageEstimate'
import { useUsageEstimate } from '../../lib/useUsageEstimate'
import { startDecision } from '../../lib/usageEstimate'
import type { EstimateRequest } from '../../lib/usageLimits'

/** A recut is the same analysis over the same clips at the same tiers, so it
 * is estimated exactly like the first cut was. */
function recutEstimateRequest(project: LocalProject): EstimateRequest | null {
  const clips = (project.clips ?? []).filter((c) => Number.isFinite(c.durationSec))
  if (clips.length === 0) return null
  return {
    mode: project.mode ?? 'dub_first',
    ...(project.engine ? { engine: project.engine } : {}),
    ...(project.precision ? { precision: project.precision } : {}),
    clips: clips.map((c) => ({ duration_sec: c.durationSec, has_audio: c.hasAudio !== false }))
  }
}

/** "15 ส.ค. 07:13" — same shape as the card's meta line. */
function fmtWhen(iso: string): string {
  const d = new Date(iso)
  return `${d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString(
    'th-TH',
    { hour: '2-digit', minute: '2-digit' }
  )}`
}

/** "07:13" — time only, for the history rows where the date is noise. */
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
}

function fmtRunTime(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m === 0) return `${r} วินาที`
  return r === 0 ? `${m} นาที` : `${m} นาที ${r} วินาที`
}

/**
 * "ให้ AI ตัดใหม่" — one comment box, then the same pipeline with the same
 * settings (HANDOFF R12.3).
 *
 * Nothing here is configurable on purpose. The point of the command is "try
 * again", not "set it up again"; a second place to edit length/style/music
 * would be a second wizard to keep in sync. The settings line states plainly
 * what carries over instead.
 */
export function RecutDialog({
  open,
  project,
  onClose,
  onSubmit
}: {
  open: boolean
  project: LocalProject
  onClose: () => void
  /** `allowWallet`: the user agreed to pay from the top-up balance for this run. */
  onSubmit: (text: string, allowWallet: boolean) => void
}): React.JSX.Element | null {
  const { session } = useJobs()
  const { estimate, loading: estimating } = useUsageEstimate(session, recutEstimateRequest(project))
  const [allowWallet, setAllowWallet] = useState(false)
  const decision = startDecision(estimate, allowWallet)
  // Mounted only while open (see the card), so a comment typed and cancelled
  // dies with the dialog — no reset effect needed.
  const [text, setText] = useState('')
  const [cutStyleName, setCutStyleName] = useState<string | null>(null)
  const boxId = 'recut-comment'

  // `autoFocus` alone loses the race: Dialog focuses its own panel on open for
  // the focus trap, which lands after the input mounts. Typing is the only
  // thing to do here, so the caret belongs in the box.
  useEffect(() => {
    document.getElementById(boxId)?.focus()
  }, [])

  // Only fetched when there is a uid to name — the settings line omits the
  // style entirely rather than showing a raw uid or a placeholder dash.
  useEffect(() => {
    if (!open || !project.cutStyleUid) return
    let cancelled = false
    void listStyles(session, 'cut')
      .then((styles) => {
        if (cancelled) return
        setCutStyleName(styles.find((s) => s.uid === project.cutStyleUid)?.name ?? null)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [open, project.cutStyleUid, session])

  const notes = project.recutNotes ?? []
  // Newest first: a third comment is usually a correction to the second, so
  // the thing most worth re-reading sits closest to the box.
  const history = useMemo(() => [...notes].reverse(), [notes])

  const settings = useMemo(() => {
    const parts: string[] = [MODE_LABEL[project.mode ?? 'dub_first']]
    if (project.mode !== 'talking_head') {
      parts.push(project.userScript?.trim() ? 'สคริปต์ของคุณ' : 'AI ร่างสคริปต์')
    }
    if (project.targetDurationSec) parts.push(`${project.targetDurationSec} วินาที`)
    if (cutStyleName) parts.push(`สไตล์${cutStyleName}`)
    if (project.music?.path) parts.push(project.music.path.split(/[\\/]/).pop() ?? '')
    return parts.filter(Boolean).join(' · ')
  }, [project, cutStyleName])

  const canSubmit = text.trim().length > 0 && decision === 'go'
  // The recut is refused BEFORE it re-uploads anything: the dialog already
  // knows whether the plan (or the balance, with consent) can pay for it.
  const blockedReason =
    decision === 'blocked'
      ? 'โควตาเหลือไม่พอสำหรับการตัดใหม่รอบนี้'
      : decision === 'ask_wallet'
        ? 'ติ๊กใช้ยอดเงินคงเหลือก่อน'
        : 'พิมพ์บอกก่อนว่าอยากให้แก้อะไร'

  if (!open) return null
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="ให้ AI ตัดใหม่"
      subtitle={`${project.name} · ตัดครั้งล่าสุด ${fmtWhen(project.updatedAt)}`}
      width={620}
      footerNote={
        project.lastRunSeconds ? (
          <span className="tabular-nums">รอบก่อนใช้เวลา {fmtRunTime(project.lastRunSeconds)}</span>
        ) : undefined
      }
      footerActions={
        <>
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
          {/* Branch on the whole element: Button's disabled/disabledReason is a
              discriminated union and cannot be narrowed through a spread. */}
          {canSubmit ? (
            <Button variant="primary" onClick={() => onSubmit(text.trim(), allowWallet)}>
              ตัดใหม่
            </Button>
          ) : (
            <Button variant="primary" disabled disabledReason={blockedReason}>
              ตัดใหม่
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div>
          <p className="text-[15px] font-semibold text-ink">บอก AI ว่าอยากให้แก้อะไร</p>
          <p className="mt-1 text-[13.5px] text-muted">
            พิมพ์เป็นภาษาพูดได้เลย ข้อความนี้จะถูกส่งไปพร้อมกับสิ่งที่เคยบอกไว้ตอนสร้างโปรเจกต์
          </p>
          {/* No preset chips: the user's own words point at the actual problem
              better than any phrase we could guess for them. */}
          <Textarea
            id={boxId}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="เช่น ช่วงต้นยืดไป ตัดให้เข้าเรื่องเร็วขึ้น แล้วเก็บตอนลองใส่กางเกงไว้ให้ยาวกว่านี้"
            className="mt-2.5 h-[108px]"
          />
        </div>

        {history.length > 0 ? (
          <div className="rounded-md border border-border-faint">
            <div className="flex items-center justify-between border-b border-divider px-3.5 py-2.5">
              <p className="text-sm text-muted">เคยบอกไว้ก่อนหน้านี้</p>
              <p className="text-sm tabular-nums text-muted">{history.length} รอบ</p>
            </div>
            {/* Four rows fit; beyond that the list scrolls rather than pushing
                the confirm button off a short window. */}
            <div className="scroll-ghost max-h-[168px] overflow-y-auto">
              {history.map((n) => (
                <div
                  key={`${n.round}-${n.at}`}
                  className="flex items-start gap-3 px-3.5 py-2.5 text-ink-2"
                >
                  <span className="w-[52px] shrink-0 text-sm tabular-nums text-muted">
                    รอบ {n.round}
                  </span>
                  <p className="min-w-0 flex-1 text-sm leading-[1.55]">{n.text}</p>
                  <span className="shrink-0 text-[13px] tabular-nums text-muted">
                    {fmtTime(n.at)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* Before the button, not a toast after it — one spare version is a
            thing to know while deciding, not to be told once it is too late. */}
        <div className="flex gap-3 rounded-md border border-[rgb(217_164_65_/_0.4)] bg-[#211d17] px-3.5 py-3">
          <RotateCcw size={16} className="mt-[2px] shrink-0 text-accent" />
          <div className="min-w-0">
            <p className="text-sm leading-[1.55] text-ink-2">
              คลิปที่มีอยู่ตอนนี้จะถูกเก็บเป็นเวอร์ชันก่อนหน้า ถ้ารอบใหม่ไม่ดีกว่า
              กดย้อนกลับได้จากเมนูเดิม
            </p>
            <p className="mt-0.5 text-[13px] leading-[1.5] text-muted">
              เก็บได้ครั้งละหนึ่งเวอร์ชัน — ตัดใหม่อีกรอบจะทับของเก่า
            </p>
          </div>
        </div>

        <p className="text-[13.5px] leading-[1.6] text-muted">
          ใช้ค่าเดิมทั้งหมด — {settings} อยากเปลี่ยนค่าพวกนี้ต้องสร้างโปรเจกต์ใหม่
        </p>

        <UsageEstimateLine
          estimate={estimate}
          loading={estimating}
          allowWallet={allowWallet}
          onAllowWallet={setAllowWallet}
        />
      </div>
    </Dialog>
  )
}
