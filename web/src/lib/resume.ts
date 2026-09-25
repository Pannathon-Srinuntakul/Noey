/**
 * Continuing a project the server parked because the plan's quota ran out.
 *
 * The server is the only place that knows where a run stopped: it records the
 * furthest pipeline BOUNDARY a project completed (`stage`) plus a ticket for
 * the boundary it was attempting, and prices a resume on that one stage. This
 * module is the client half of that contract — parsing, vocabulary and the
 * sentences a person reads. It holds no state and touches no network, so the
 * pipeline, the cards and the tests all read the same definitions.
 *
 * Two rules the whole feature rests on:
 *
 *   1. The ORDER of stages is never hardcoded here. It differs per mode and
 *      arrives as `stages`; this module only knows how to NAME a stage.
 *   2. Money is satang and quota is percent. Nothing turns either back into a
 *      token count, because the server never sends one.
 *
 * Contract: the backend's RESUME CONTRACT (GET/POST /videos/{uid}/resume).
 */

import {
  estimateBlockLine,
  estimateLine,
  formatBaht,
  limitLabel,
  whenBack,
  type LimitKey,
  type UsageEstimate
} from './usageLimits'
import type { ProjectMode, ProjectStep } from './projectFlow'

// ── shapes ───────────────────────────────────────────────────────────────────

export type ResumeRunsOn = 'server' | 'client'
export type ResumeAction = 'server_job' | 'client_step' | 'already_running' | 'nothing_to_resume'
/** `ticket` = priced on the stage the server recorded; `declared` = priced on
 * the lengths declared at creation (older build, display only); `free` = the
 * next step is local and costs nothing. */
export type EstimateSource = 'ticket' | 'declared' | 'free'

/**
 * The live quota answer that rides on every resume payload.
 *
 * Deliberately the RAW server shape (`wallet_satang`, `resets_at`): it is
 * `POST /usage/estimate`'s response plus `balance_satang`, so every sentence
 * `usageLimits` already writes for an estimate works on it unchanged.
 */
export interface ResumeQuota extends UsageEstimate {
  /** Spendable top-up balance right now, in satang. */
  balance_satang: number
}

/** A call the client must repeat itself, because only it has the numbers. */
export interface ResumeClientStep {
  method: string
  path: string
  body: Record<string, unknown>
}

/** `GET /videos/{uid}/resume` — works on any local project, paused or not. */
export interface ResumeState {
  uid: string
  /** The project row's status, e.g. `paused_quota`, `processing`, `done`. */
  status: string
  mode: string
  paused: boolean
  reason: string | null
  /** Furthest COMPLETED boundary; null on a project made before stages existed. */
  stage: string | null
  /** What continuing will do; null means nothing is left. */
  nextStage: string | null
  /** This mode's boundary order, server-supplied. Never hardcode it. */
  stages: string[]
  runsOn: ResumeRunsOn | null
  clientStep: ResumeClientStep | null
  pausedAt: string | null
  /** The window that ran out (frozen at pause time). */
  window: LimitKey | null
  windowResetsAt: string | null
  /** The server's own Thai sentence, only while paused. */
  message: string | null
  resumable: boolean
  /** False ⇒ continuing costs nothing (the next step is local). */
  charges: boolean
  estimateSource: EstimateSource
  quota: ResumeQuota
}

/** `POST /videos/{uid}/resume` — the same keys, plus what the call did. */
export interface ResumeOutcome extends ResumeState {
  action: ResumeAction
  jobId: string | null
  runId: string | null
  resumed: boolean
  detail: string | null
}

// ── parsing ──────────────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function limitKey(v: unknown): LimitKey | null {
  return v === 'five_hour' || v === 'weekly' || v === 'monthly' ? v : null
}

function pctMap(v: unknown): Partial<Record<LimitKey, number>> {
  if (!v || typeof v !== 'object') return {}
  const out: Partial<Record<LimitKey, number>> = {}
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    const key = limitKey(k)
    if (key && typeof n === 'number' && Number.isFinite(n)) out[key] = n
  }
  return out
}

/**
 * The quota block, defaulted to "the plan covers it".
 *
 * A missing or malformed block must never read as "you cannot continue": the
 * server refuses nothing here — it starts the run and pauses again if the
 * window is still full — so an unreadable estimate should offer the plain
 * "ทำต่อ" rather than push a top-up nobody needs.
 */
export function parseQuota(v: unknown): ResumeQuota {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const fits = o.fits === 'wallet' || o.fits === 'none' ? o.fits : 'plan'
  return {
    fits,
    pct: pctMap(o.pct),
    wallet_satang: num(o.wallet_satang),
    balance_satang: num(o.balance_satang),
    binding: limitKey(o.binding),
    resets_at: str(o.resets_at),
    unlimited: o.unlimited === true
  }
}

function parseClientStep(v: unknown): ResumeClientStep | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const path = str(o.path)
  if (!path) return null
  return {
    method: str(o.method) ?? 'POST',
    path,
    body: (o.body && typeof o.body === 'object' ? o.body : {}) as Record<string, unknown>
  }
}

function stageList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && !!s) : []
}

/** `GET /videos/{uid}/resume`, defensively. Unknown fields are ignored. */
export function parseResumeState(body: unknown): ResumeState {
  const o = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const source = o.estimate_source
  return {
    uid: str(o.uid) ?? '',
    status: str(o.status) ?? '',
    mode: str(o.mode) ?? 'dub_first',
    // `paused` is the server's own word for it; the status is the fallback so
    // an older payload that omits the flag still reads correctly.
    paused: o.paused === true || o.status === 'paused_quota',
    reason: str(o.reason),
    stage: str(o.stage),
    nextStage: str(o.next_stage),
    stages: stageList(o.stages),
    runsOn: o.runs_on === 'server' || o.runs_on === 'client' ? o.runs_on : null,
    clientStep: parseClientStep(o.client_step),
    pausedAt: str(o.paused_at),
    window: limitKey(o.window),
    windowResetsAt: str(o.window_resets_at),
    message: str(o.message),
    resumable: o.resumable === true,
    charges: o.charges === true,
    estimateSource: source === 'ticket' || source === 'declared' ? source : 'free',
    quota: parseQuota(o.quota)
  }
}

/** `POST /videos/{uid}/resume`. All four actions send the same key set, so
 * nothing here may branch on a key being present. */
export function parseResumeOutcome(body: unknown): ResumeOutcome {
  const o = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const action = o.action
  return {
    ...parseResumeState(body),
    action:
      action === 'server_job' ||
      action === 'client_step' ||
      action === 'already_running' ||
      action === 'nothing_to_resume'
        ? action
        : 'nothing_to_resume',
    jobId: str(o.job_id),
    runId: str(o.run_id),
    resumed: o.resumed === true,
    detail: str(o.detail)
  }
}

// ── vocabulary ───────────────────────────────────────────────────────────────

/**
 * Stage name → the step the local pipeline calls it.
 *
 * `render_final` is the one that forks: the dub chain calls it
 * `final_rendering`, the speech chain `rendering` — hence `stageStep` taking
 * the mode. A stage with no local equivalent (`reedit`, `effects`) maps to
 * null: those sit outside the pipeline order and the caller handles them.
 */
const STAGE_STEPS: Record<string, ProjectStep> = {
  imported: 'imported',
  proxy: 'analyzing',
  analyze: 'analyzing',
  render_silent: 'silent_rendering',
  voiceover: 'waiting_vo',
  plan: 'planning',
  extract_audio: 'extracting_audio',
  transcribe: 'transcribing',
  select: 'selecting',
  done: 'done'
}

function isSpeechish(mode: string): boolean {
  return mode === 'talking_head' || mode === 'speech_highlights' || mode === 'speech_scenes'
}

export function stageStep(stage: string | null, mode: string): ProjectStep | null {
  if (!stage) return null
  if (stage === 'render_final') return isSpeechish(mode) ? 'rendering' : 'final_rendering'
  return STAGE_STEPS[stage] ?? null
}

/**
 * What a stage is called to a person — a NOUN phrase ("ถอดเสียง"), not the
 * progressive label the progress bar uses, because these read as "ทำต่อจาก …"
 * and "ขั้นถัดไป: …".
 */
const STAGE_LABELS: Record<string, string> = {
  imported: 'นำเข้าคลิป',
  proxy: 'เตรียมวิดีโอให้ AI',
  analyze: 'ให้ AI วิเคราะห์วิดีโอ',
  render_silent: 'ตัดวิดีโอ (ยังไม่มีเสียงพากย์)',
  voiceover: 'ใส่เสียงพากย์',
  plan: 'วางแผนไทม์ไลน์ตามเสียงพากย์',
  render_final: 'เรนเดอร์วิดีโอสุดท้าย',
  extract_audio: 'แยกเสียงจากคลิป',
  transcribe: 'ถอดเสียง',
  select: 'เลือกช่วงเด่น',
  done: 'เสร็จแล้ว',
  // Side stages — outside the pipeline order, but they can be `next_stage`.
  reedit: 'ให้ AI ตัดใหม่',
  effects: 'เอฟเฟกต์การซูม'
}

export function stageLabel(stage: string | null): string {
  if (!stage) return 'ขั้นตอนถัดไป'
  return STAGE_LABELS[stage] ?? stage
}

/** "ขั้นที่ 3 จาก 8", or null when the stage is not one of this mode's. */
export function stagePosition(state: ResumeState): string | null {
  if (!state.nextStage || state.stages.length === 0) return null
  const i = state.stages.indexOf(state.nextStage)
  if (i < 0) return null
  return `ขั้นที่ ${i + 1} จาก ${state.stages.length}`
}

// ── sentences ────────────────────────────────────────────────────────────────

/**
 * The headline of a paused project. The plan's own word for the window comes
 * first because that is the thing that ran out; the server's sentence is kept
 * for the body, where it can say more than a headline has room for.
 */
export function pausedHeadline(state: ResumeState): string {
  if (!state.paused) return ''
  return state.window ? `หยุดไว้ชั่วคราว — ${limitLabel(state.window)}หมด` : 'หยุดไว้ชั่วคราว'
}

/**
 * When the window that ran out comes back, in the VIEWER's timezone — which
 * the server's own message cannot do. Empty when no time was frozen.
 */
export function windowResetLine(state: ResumeState, now: Date = new Date()): string {
  const back = whenBack(state.windowResetsAt, now)
  if (!back) return ''
  const label = state.window ? limitLabel(state.window) : 'โควตา'
  return `${label}จะรีเซ็ต${back.startsWith('อีก') ? '' : ' '}${back}`
}

/** "ทำต่อจากขั้น: ถอดเสียง" — where continuing picks up. */
export function nextStageLine(state: ResumeState): string {
  if (!state.nextStage) return 'ไม่มีขั้นตอนค้างอยู่'
  const pos = stagePosition(state)
  return `ทำต่อที่: ${stageLabel(state.nextStage)}${pos ? ` · ${pos}` : ''}`
}

/**
 * What continuing would cost, in the same percent-of-window language the
 * wizard uses. Null when the next step is local (nothing is charged) or the
 * account has no enforced windows.
 */
export function resumeCostLine(state: ResumeState): string | null {
  if (!state.charges) return 'ขั้นตอนถัดไปทำบนเครื่องนี้ — ไม่ใช้โควตาเพิ่ม'
  const line = estimateLine(state.quota)
  if (!line) return null
  // A ticket is priced on the stage the server measured; a `declared` estimate
  // was worked out from the lengths given at creation and is a rough guide.
  return state.estimateSource === 'declared' ? `${line} (ประมาณการคร่าว ๆ)` : line
}

/** Why the plan cannot pay for it, and what the balance would do instead. */
export function resumeBlockLine(state: ResumeState, now: Date = new Date()): string | null {
  if (!state.charges) return null
  return estimateBlockLine(state.quota, now)
}

/** True when continuing needs the user's consent to spend the top-up balance. */
export function needsWalletConsent(state: ResumeState): boolean {
  return state.charges && state.quota.fits === 'wallet'
}

/**
 * The label on the continue button.
 *
 * `none` still offers a press: the server does not refuse a resume that cannot
 * fit — it starts the run, the guard stops it and the project parks again — so
 * the honest word is "ลองทำต่อ", not a disabled button that explains nothing.
 */
export function resumeActionLabel(state: ResumeState): string {
  if (!state.charges) return 'ทำต่อ'
  if (state.quota.fits === 'wallet') {
    return `ใช้ยอดเงินคงเหลือ ${formatBaht(state.quota.wallet_satang)} ทำต่อ`
  }
  if (state.quota.fits === 'none') return 'ลองทำต่อ'
  return 'ทำต่อ'
}

/** "ยอดเงินคงเหลือ ฿120.00" — shown beside the wallet action. */
export function balanceLine(state: ResumeState): string {
  return `ยอดเงินคงเหลือ ${formatBaht(state.quota.balance_satang)}`
}

/**
 * The one case that genuinely cannot work, said out loud.
 *
 * A project's footage lives in this browser's own storage. The server holds a
 * synced copy of most of it, so opening the project elsewhere usually works —
 * but when the next boundary runs on the CLIENT and the footage is not
 * reachable from here, continuing is impossible and nothing else in the UI
 * would say why. `footageReachable === null` means "not checked yet" and
 * produces no claim either way.
 */
export function localFootageWarning(
  state: ResumeState,
  footageReachable: boolean | null
): string | null {
  if (state.runsOn !== 'client') return null
  if (footageReachable !== false) return null
  return 'ขั้นตอนถัดไปทำบนเครื่องนี้ แต่ไม่พบไฟล์วิดีโอของโปรเจกต์นี้ในเบราว์เซอร์นี้ — ไฟล์เก็บไว้ต่อเบราว์เซอร์ ทำต่อได้จากเบราว์เซอร์หรืออุปกรณ์ที่สร้างโปรเจกต์นี้เท่านั้น'
}

/** What the POST actually did, for the toast after pressing "ทำต่อ". */
export function outcomeMessage(outcome: ResumeOutcome): string {
  switch (outcome.action) {
    case 'server_job':
      return `ทำต่อแล้ว — ${stageLabel(outcome.nextStage)}`
    case 'already_running':
      return 'งานนี้กำลังทำอยู่แล้ว'
    case 'client_step':
      return `ทำต่อแล้ว — ${stageLabel(outcome.nextStage)}`
    case 'nothing_to_resume':
      return outcome.detail ?? 'ไม่มีขั้นตอนค้างอยู่'
  }
}

/**
 * Where a resumed project should sit locally once the pause is cleared.
 *
 * Driven by the SERVER's status, not by whatever the browser last wrote: a
 * project paused on one machine and resumed on another has no useful local
 * step to fall back to. `fallback` covers `pending`, which only says "nothing
 * is running".
 */
export function stepAfterResume(
  state: ResumeState,
  mode: ProjectMode,
  fallback: ProjectStep
): ProjectStep {
  if (state.status === 'done') return 'done'
  if (state.status === 'waiting_vo') return 'waiting_vo'
  if (state.status === 'processing') return stageStep(state.nextStage, mode) ?? fallback
  return fallback
}
