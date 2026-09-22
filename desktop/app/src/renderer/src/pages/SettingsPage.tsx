import { useCallback, useEffect, useState } from 'react'
import { FolderOpen, LogOut } from 'lucide-react'
import type { Session } from '../App'
import type { StorageReport } from '../../../preload'
import {
  ApiError,
  getPlanPrices,
  getUsage,
  getWallet,
  previewPlanChange,
  restoreSession,
  startTopup,
  switchPlan,
  type Usage,
  type Wallet
} from '../lib/api'
import { checkoutAlreadyCredited, formatPack } from '../lib/usageLimits'
import { usePrefs } from '../lib/prefs'
import { isBusy } from '../lib/projectFlow'
import { useToast } from '../lib/toast'
import { DUB_DURATION_AUTO, DUB_DURATION_FIXED } from '../lib/dubBrief'
import { UI_MODE_LABEL } from '../lib/wizardState'
import { TaskBreakdown } from '../components/settings/TaskBreakdown'
import { UsageCard } from '../components/settings/UsageCard'
import { PlansCard } from '../components/settings/PlansCard'
import { PlanChangeDialog } from '../components/settings/PlanChangeDialog'
import { planLabel } from '../lib/planLadder'
import { WalletCard } from '../components/settings/WalletCard'
import { PageHeader } from '../components/shell/PageHeader'
import { Button } from '../components/ui/Button'
import { Chip } from '../components/ui/Chip'
import { Skeleton } from '../components/ui/Skeleton'
import { Switch } from '../components/ui/Switch'
import { Tabs } from '../components/ui/Tabs'

/** A default can only be a value this page can store on its own: "กำหนดเอง"
 * needs a number typed next to it and "ตามความยาวเพลง" needs a music file, and
 * neither exists here. */
const DEFAULT_DURATION_CHOICES = [
  ...DUB_DURATION_FIXED.filter((c) => c.value !== 'custom'),
  ...DUB_DURATION_AUTO.filter((c) => c.value !== 'music')
]

type TabKey = 'usage' | 'storage' | 'defaults' | 'account'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'usage', label: 'การใช้งาน' },
  { key: 'storage', label: 'ที่เก็บไฟล์' },
  { key: 'defaults', label: 'ค่าเริ่มต้นของงานใหม่' },
  { key: 'account', label: 'บัญชี' }
]

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

/**
 * Call an account endpoint with the session's token, refreshing it once on a
 * 401 — the settings screen is often the first thing opened after a long
 * idle, when the access token has lapsed.
 */
async function withFreshToken<T>(
  session: Session,
  call: (baseUrl: string, accessToken: string) => Promise<T>
): Promise<T> {
  let accessToken = session.accessToken
  try {
    return await call(session.baseUrl, accessToken)
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
  return call(session.baseUrl, accessToken)
}

// ── tab: usage ───────────────────────────────────────────────────────────────

/**
 * Plan limits, the top-up balance and where the work went — as percentages
 * and baht only (docs/token-billing-design.md §19; docs/design/editor-limits.md
 * §1). Nothing here states, or could be turned back into, a token count.
 */
function UsageTab({ session }: { session: Session }): React.JSX.Element {
  const [usage, setUsage] = useState<Usage | null>(null)
  const [wallet, setWallet] = useState<Wallet | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [topupBusy, setTopupBusy] = useState(false)
  // A checkout opened in another tab: refresh when the user comes back to
  // this one, since that is when the payment has (probably) gone through.
  const [awaitingPayment, setAwaitingPayment] = useState(false)
  const { projects } = useProjectCounts()
  const { showToast } = useToast()
  // Monthly prices by tier (satang) for the plan list — public, no token.
  const [prices, setPrices] = useState<Record<string, number>>({})
  const [pickTier, setPickTier] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getPlanPrices(session.baseUrl)
      .then((r) => {
        if (!cancelled) setPrices(Object.fromEntries(r.plans.map((p) => [p.tier, p.unit_amount])))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [session.baseUrl])

  const fetchAll = useCallback(async (): Promise<{ usage: Usage; wallet: Wallet | null }> => {
    const [u, w] = await Promise.all([
      withFreshToken(session, getUsage),
      // The wallet is secondary: a server without it must not blank the meters.
      withFreshToken(session, getWallet).catch(() => null)
    ])
    return { usage: u, wallet: w }
  }, [session])

  /** Retry after a failed load — clears the error up front so the panel goes
   * back to the skeleton instead of holding a stale message. */
  const load = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      const r = await fetchAll()
      setUsage(r.usage)
      setWallet(r.wallet)
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'โหลดข้อมูลไม่สำเร็จ')
    }
  }, [fetchAll])

  // The first fetch is its own inline flow rather than a call to `load`: no
  // state is touched before the first await (the skeleton already covers the
  // wait), and a response that arrives after unmount is dropped.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const r = await fetchAll()
        if (cancelled) return
        setUsage(r.usage)
        setWallet(r.wallet)
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.detail : 'โหลดข้อมูลไม่สำเร็จ')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [fetchAll])

  useEffect(() => {
    if (!awaitingPayment) return
    const onFocus = (): void => {
      setAwaitingPayment(false)
      void load()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [awaitingPayment, load])

  /**
   * Open the checkout in the system browser (the main process sends every
   * `window.open` there). A local server with no payment provider credits at
   * once (`checkoutAlreadyCredited`) and there is nothing to open.
   */
  const onTopup = async (packSatang: number, method: string): Promise<void> => {
    setTopupBusy(true)
    try {
      const { url } = await withFreshToken(session, (base, token) =>
        startTopup(base, token, packSatang, method)
      )
      if (checkoutAlreadyCredited(url)) {
        showToast({ text: `เติมเงิน ${formatPack(packSatang)} แล้ว`, variant: 'ok' })
        await load()
        return
      }
      window.open(url, '_blank')
      setAwaitingPayment(true)
    } catch (err) {
      showToast({ text: err instanceof ApiError ? err.detail : 'เปิดหน้าชำระเงินไม่สำเร็จ' })
    } finally {
      setTopupBusy(false)
    }
  }

  /**
   * Go ahead with a plan change the dialog confirmed: a payment page opens in
   * the system browser (like the top-up); a change the server made or
   * scheduled itself just refreshes the meters.
   */
  const onSwitchPlan = async (tier: string): Promise<void> => {
    const r = await withFreshToken(session, (base, token) => switchPlan(base, token, tier, true))
    if (r.url) {
      window.open(r.url, '_blank')
      setAwaitingPayment(true)
    } else {
      showToast({ text: `เปลี่ยนเป็นแผน ${planLabel(tier)} แล้ว`, variant: 'ok' })
    }
    setPickTier(null)
    await load()
  }

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

  const tasks = usage.by_task ?? []

  return (
    <div className="flex flex-col gap-4">
      {/* Stacks on a phone: the usage card is flex-1 next to a `sm:w-[300px]`
          sibling that is w-full below sm. */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <UsageCard usage={usage} />
        </div>

        {/* Straight off the local registry, so it counts every project on this
         * machine — not the design's "เดือนนี้", which we have no data for. */}
        <div className="w-full shrink-0 rounded-md border border-divider p-5 sm:w-[300px]">
          <p className="text-sm text-muted">งานในเครื่องนี้</p>
          <div className="mt-3 flex flex-col gap-2.5 text-body">
            <StatRow label="วิดีโอที่เสร็จ" value={`${projects.done} คลิป`} />
            <StatRow label="กำลังทำอยู่" value={`${projects.running} งาน`} />
            <StatRow label="งานที่ล้มเหลว" value={`${projects.error} งาน`} />
          </div>
        </div>
      </div>

      {wallet ? (
        <WalletCard wallet={wallet} busy={topupBusy} onTopup={(p, m) => void onTopup(p, m)} />
      ) : null}

      <PlansCard
        current={usage.plan}
        prices={prices}
        pendingPlan={usage.pending_plan?.plan ?? null}
        onPick={setPickTier}
      />
      <PlanChangeDialog
        key={pickTier ?? 'none'}
        tier={pickTier}
        loadPreview={(tier) =>
          withFreshToken(session, (base, token) => previewPlanChange(base, token, tier))
        }
        onConfirm={onSwitchPlan}
        onClose={() => setPickTier(null)}
      />

      {!usage.unlimited && tasks.some((t) => t.pct > 0) ? (
        <Section title="การใช้งานแยกตามงาน" hint="สัดส่วนของที่ใช้ไปในรอบปัจจุบัน">
          <TaskBreakdown tasks={tasks} />
        </Section>
      ) : null}
    </div>
  )
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
  // Only the modes prefs can store (main/prefs.ts keeps the union narrow) —
  // longform starting as the wizard default is not an R17 decision.
  const modes: ('silence' | 'highlight')[] = ['silence', 'highlight']

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
          {DEFAULT_DURATION_CHOICES.map((c) => (
            <Chip
              key={c.value}
              dense
              selected={prefs?.defaultDuration === c.value}
              onClick={() => void update({ defaultDuration: c.value })}
            >
              {c.label}
            </Chip>
          ))}
        </div>
      </Section>

      <Section title="คำบรรยายบนภาพ" hint="เปิดไว้ก่อนสำหรับงานใหม่ที่ใส่คำบรรยายได้">
        <Switch
          checked={prefs?.defaultCaptions ?? false}
          onChange={(defaultCaptions) => void update({ defaultCaptions })}
          label={(prefs?.defaultCaptions ?? false) ? 'เปิดไว้' : 'ปิดไว้'}
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
