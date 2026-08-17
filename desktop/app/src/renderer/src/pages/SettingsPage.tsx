import { useCallback, useEffect, useState } from 'react'
import { FolderOpen, LogOut } from 'lucide-react'
import type { Session } from '../App'
import type { StorageReport } from '../../../preload'
import { ApiError, getUsage, restoreSession, type Usage } from '../lib/api'
import { usePrefs } from '../lib/prefs'
import { isBusy } from '../lib/projectFlow'
import { useToast } from '../lib/toast'
import { DUB_DURATION_CHIPS } from '../lib/dubBrief'
import { UI_MODE_LABEL, type UiMode } from '../lib/wizardState'
import { Bar, TaskBreakdown } from '../components/settings/TaskBreakdown'
import { PageHeader } from '../components/shell/PageHeader'
import { Button } from '../components/ui/Button'
import { Chip } from '../components/ui/Chip'
import { Skeleton } from '../components/ui/Skeleton'
import { Switch } from '../components/ui/Switch'
import { Tabs } from '../components/ui/Tabs'

type TabKey = 'usage' | 'storage' | 'defaults' | 'account'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'usage', label: 'เครดิตและการใช้งาน' },
  { key: 'storage', label: 'ที่เก็บไฟล์' },
  { key: 'defaults', label: 'ค่าเริ่มต้นของงานใหม่' },
  { key: 'account', label: 'บัญชี' }
]

/** How long the user has to wait for the daily quota to roll over. */
function untilResetLabel(): string {
  const now = new Date()
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0)
  )
  const mins = Math.max(0, Math.round((next.getTime() - now.getTime()) / 60000))
  const h = Math.floor(mins / 60)
  return h >= 1 ? `รีเซ็ตอีก ${h} ชม.` : `รีเซ็ตอีก ${mins} นาที`
}

function fmtGB(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

function Section({
  title,
  hint,
  children
}: {
  title: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="rounded-md border border-divider p-5">
      <p className="text-item font-semibold text-ink">{title}</p>
      {hint ? <p className="mt-1 text-sm leading-[1.6] text-muted">{hint}</p> : null}
      <div className="mt-3.5">{children}</div>
    </section>
  )
}

/** Label left, value right — the shape R5 uses inside the summary card. */
function StatRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <span className="flex justify-between gap-3 tabular-nums text-ink">
      {label}
      <span className="font-semibold">{value}</span>
    </span>
  )
}

async function fetchUsage(session: Session): Promise<Usage> {
  let accessToken = session.accessToken
  try {
    return await getUsage(session.baseUrl, accessToken)
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) throw err
  }
  const pair = await restoreSession(session.baseUrl, accessToken, session.refreshToken)
  if (!pair) throw new ApiError(401, 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่')
  accessToken = pair.access_token
  await window.noey.auth.save({
    baseUrl: session.baseUrl,
    email: session.profile.email,
    accessToken: pair.access_token,
    refreshToken: pair.refresh_token
  })
  return getUsage(session.baseUrl, accessToken)
}

// ── tab: usage ───────────────────────────────────────────────────────────────

function UsageTab({ session }: { session: Session }): React.JSX.Element {
  const [usage, setUsage] = useState<Usage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [technicalOpen, setTechnicalOpen] = useState(false)
  const { projects } = useProjectCounts()

  /** Retry after a failed load — clears the error up front so the panel goes
   * back to the skeleton instead of holding a stale message. */
  const load = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      setUsage(await fetchUsage(session))
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'โหลดข้อมูลไม่สำเร็จ')
    }
  }, [session])

  // The first fetch is its own inline flow rather than a call to `load`: no
  // state is touched before the first await (the skeleton already covers the
  // wait), and a response that arrives after unmount is dropped.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const result = await fetchUsage(session)
        if (!cancelled) setUsage(result)
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.detail : 'โหลดข้อมูลไม่สำเร็จ')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [session])

  if (error) {
    return (
      <div className="rounded-md border border-error px-5 py-4">
        <p className="text-sm text-error" style={{ userSelect: 'text' }}>
          {error}
        </p>
        <div className="mt-3">
          <Button onClick={() => void load()}>ลองใหม่</Button>
        </div>
      </div>
    )
  }
  if (!usage) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton variant="text" index={0} className="h-20 w-full" />
        <Skeleton variant="text" index={1} className="h-32 w-full" />
      </div>
    )
  }

  const pct = usage.unlimited ? null : (usage.usage_pct ?? 0)
  const tasks = usage.by_task ?? []
  const featureShares = featureSharePct(usage)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-4">
        {/* The quota is the one card on this page that carries the accent —
         * accent border and accent figure, per R5. */}
        <div className="flex-1 rounded-md border border-accent p-5">
          <p className="text-sm text-muted">โควตาที่ใช้ไปวันนี้</p>
          {pct === null ? (
            <p className="mt-1.5 text-sm text-muted">แผนนี้ไม่จำกัดโควตา จึงไม่มีสัดส่วนให้แสดง</p>
          ) : (
            <>
              <p className="mt-1.5 text-[34px] font-semibold leading-[1.1] tabular-nums text-accent">
                {Math.min(100, Math.round(pct))}
                <span className="text-[20px]">%</span>
              </p>
              <div className="mt-3.5">
                <Bar pct={pct} />
              </div>
              <p className="mt-2.5 text-sm tabular-nums text-muted">{untilResetLabel()}</p>
            </>
          )}
        </div>

        {/* Straight off the local registry, so it counts every project on this
         * machine — not the design's "เดือนนี้", which we have no data for. */}
        <div className="w-[300px] shrink-0 rounded-md border border-divider p-5">
          <p className="text-sm text-muted">งานในเครื่องนี้</p>
          <div className="mt-3 flex flex-col gap-2.5 text-body">
            <StatRow label="วิดีโอที่เสร็จ" value={`${projects.done} คลิป`} />
            <StatRow label="กำลังทำอยู่" value={`${projects.running} งาน`} />
            <StatRow label="งานที่ล้มเหลว" value={`${projects.error} งาน`} />
          </div>
        </div>
      </div>

      <Section
        title="การใช้งานแยกตามงาน"
        hint={
          tasks.length === 0
            ? 'เซิร์ฟเวอร์รุ่นนี้ยังไม่ส่งข้อมูลแยกตามงาน'
            : 'สัดส่วนของโควตา AI ที่ใช้ไปวันนี้ — การถอดเสียงคิดแยกต่างหาก ไม่รวมอยู่ในนี้'
        }
      >
        {tasks.length > 0 ? <TaskBreakdown tasks={tasks} /> : null}

        {/* R5 puts the disclosure inside this card as its last line. It is a
         * bare link, not a header row: a header row would nest the refresh
         * <Button> inside a <button>. */}
        <p className="mt-4 border-t border-divider pt-3.5 text-sm leading-[1.6] text-muted">
          <button
            type="button"
            onClick={() => setTechnicalOpen((v) => !v)}
            aria-expanded={technicalOpen}
            className="text-accent underline hover:text-accent-hover-text"
          >
            ดูรายละเอียดทางเทคนิค
          </button>{' '}
          สำหรับสัดส่วนแยกตามคำขอ
        </p>

        {technicalOpen ? (
          <div className="mt-3 text-sm text-ink-2" style={{ userSelect: 'text' }}>
            <p className="text-muted">
              แผน {usage.plan} · {usage.unlimited ? 'ไม่จำกัดโควตา' : 'มีโควตารายวัน'}
            </p>
            {featureShares.length > 0 ? (
              <div className="mt-2 flex flex-col gap-1">
                {featureShares.map((f) => (
                  <p key={f.feature} className="flex justify-between gap-3 tabular-nums">
                    <span className="text-muted">{f.feature}</span>
                    <span>{f.pct}%</span>
                  </p>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-muted">ยังไม่มีคำขอในรอบนี้</p>
            )}
          </div>
        ) : null}
      </Section>
    </div>
  )
}

/** Per-request usage as shares of the day's total. The ledger is kept in
 * tokens, but the UI only ever states usage as a percentage. */
function featureSharePct(usage: Usage): { feature: string; pct: number }[] {
  const total = usage.by_feature.reduce((sum, f) => sum + f.total_tokens, 0)
  if (total <= 0) return []
  return [...usage.by_feature]
    .sort((a, b) => b.total_tokens - a.total_tokens)
    .map((f) => ({ feature: f.feature, pct: Math.round((f.total_tokens / total) * 100) }))
}

/** Counts straight off the local registry — nothing here is an estimate. */
function useProjectCounts(): { projects: { done: number; running: number; error: number } } {
  const [counts, setCounts] = useState({ done: 0, running: 0, error: 0 })
  useEffect(() => {
    let cancelled = false
    void window.noey.projects.list().then((list) => {
      if (cancelled) return
      setCounts({
        done: list.filter((p) => p.step === 'done').length,
        // `isBusy` rather than a hand-written exclusion list: the two agreed on
        // all twelve steps, which is exactly the kind of duplicate that drifts
        // the next time a step is added.
        running: list.filter((p) => isBusy(p.step)).length,
        error: list.filter((p) => p.step === 'error').length
      })
    })
    return () => {
      cancelled = true
    }
  }, [])
  return { projects: counts }
}

// ── tab: storage ─────────────────────────────────────────────────────────────

/**
 * Disk usage and where the library lives — reporting only.
 *
 * The "ล้างไฟล์ต้นฉบับเก่า" button and the auto-delete-after-N-days setting were
 * removed on 2026-08-15. Deleting `normalized/` made a project permanently
 * read-only — every re-edit entry point in the sidecar (timeline_render,
 * ai_reedit, dub, audio) globs `normalized/norm_*.*` and raises "no normalized
 * clips — run ingest first" — and the retention sweep did it silently at
 * startup. Reporting the size is honest; freeing it that way was not.
 */
function StorageTab(): React.JSX.Element {
  const { showToast } = useToast()
  const [report, setReport] = useState<StorageReport | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    setReport(await window.noey.storage.report())
  }, [])

  useEffect(() => {
    let cancelled = false
    void window.noey.storage.report().then((r) => {
      if (!cancelled) setReport(r)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const move = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.noey.storage.moveLibrary()
      if (result.status === 'cancelled') return
      if (result.status === 'rejected') {
        showToast({ text: `ย้ายไม่ได้ — ${result.reason}` })
        return
      }
      showToast({ text: `ย้าย ${result.projects} โปรเจกต์แล้ว` })
      await reload()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title="โฟลเดอร์เก็บงาน">
      <p className="break-all text-sm text-ink-2" style={{ userSelect: 'text' }}>
        {report?.root ?? '—'}
      </p>
      <p className="mt-1.5 text-sm tabular-nums text-muted">
        {report
          ? `${report.projectCount} โปรเจกต์ · ใช้พื้นที่ ${fmtGB(report.totalBytes)}`
          : 'กำลังอ่านขนาดโฟลเดอร์…'}
      </p>
      <div className="mt-3.5 flex items-center gap-3">
        <Button icon={<FolderOpen size={16} />} loading={busy} onClick={() => void move()}>
          เปลี่ยนที่เก็บ
        </Button>
      </div>
    </Section>
  )
}

// ── tab: defaults ────────────────────────────────────────────────────────────

function DefaultsTab(): React.JSX.Element {
  const { prefs, update } = usePrefs()
  const modes: UiMode[] = ['silence', 'highlight']

  return (
    <div className="flex flex-col gap-4">
      <Section title="โหมดที่เลือกไว้ก่อน" hint="ค่าที่ตัวช่วยสร้างวิดีโอเปิดขึ้นมาพร้อมใช้">
        <div className="flex flex-wrap gap-2">
          {modes.map((m) => (
            <Chip
              key={m}
              dense
              selected={prefs?.defaultMode === m}
              onClick={() => void update({ defaultMode: m })}
            >
              {UI_MODE_LABEL[m]}
            </Chip>
          ))}
        </div>
      </Section>

      <Section title="ความยาวที่ใช้บ่อย" hint="ใช้เฉพาะโหมดตัดฉากเด่น">
        <div className="flex flex-wrap gap-2">
          {DUB_DURATION_CHIPS.filter((c) => c.value !== 'music' && c.value !== 'custom').map(
            (c) => (
              <Chip
                key={c.value}
                dense
                selected={prefs?.defaultDuration === c.value}
                onClick={() => void update({ defaultDuration: c.value })}
              >
                {c.label}
              </Chip>
            )
          )}
        </div>
      </Section>

      <Section title="คำบรรยายบนภาพ" hint="เปิดไว้ก่อนสำหรับงานใหม่ที่ใส่คำบรรยายได้">
        <Switch
          checked={prefs?.defaultCaptions ?? true}
          onChange={(defaultCaptions) => void update({ defaultCaptions })}
          label={(prefs?.defaultCaptions ?? true) ? 'เปิดไว้' : 'ปิดไว้'}
        />
      </Section>
    </div>
  )
}

// ── tab: account ─────────────────────────────────────────────────────────────

function AccountTab({
  session,
  onLogout
}: {
  session: Session
  onLogout: () => void
}): React.JSX.Element {
  const { prefs, update } = usePrefs()
  const name = session.profile.email.split('@')[0]

  return (
    <div className="flex flex-col gap-4">
      <Section title={name}>
        <p className="text-sm text-muted" style={{ userSelect: 'text' }}>
          {session.profile.email}
        </p>
        <div className="mt-3.5">
          <Button icon={<LogOut size={16} />} onClick={onLogout}>
            ออกจากระบบ
          </Button>
        </div>
      </Section>

      <Section
        title="แจ้งเตือน"
        hint="เมื่องานเรนเดอร์เสร็จหรือเกิดข้อผิดพลาด และหน้าต่างไม่ได้อยู่ข้างหน้า"
      >
        <Switch
          checked={prefs?.notifications ?? true}
          onChange={(notifications) => void update({ notifications })}
          label={(prefs?.notifications ?? true) ? 'เปิด' : 'ปิด'}
        />
      </Section>
    </div>
  )
}

// ── page ─────────────────────────────────────────────────────────────────────

export default function SettingsPage({
  session,
  onLogout
}: {
  session: Session
  onLogout: () => void
}): React.JSX.Element {
  const [tab, setTab] = useState<TabKey>('usage')

  return (
    <>
      <PageHeader title="ตั้งค่า" />
      <div className="shrink-0 px-8">
        <Tabs items={TABS} activeKey={tab} onChange={(key) => setTab(key as TabKey)} />
      </div>
      <div className="scroll-ghost min-h-0 flex-1 overflow-y-auto px-8 pb-8 pt-5">
        <div className="max-w-[720px]">
          {tab === 'usage' ? <UsageTab session={session} /> : null}
          {tab === 'storage' ? <StorageTab /> : null}
          {tab === 'defaults' ? <DefaultsTab /> : null}
          {tab === 'account' ? <AccountTab session={session} onLogout={onLogout} /> : null}
        </div>
      </div>
    </>
  )
}
