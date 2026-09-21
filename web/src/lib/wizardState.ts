/** Pure state + derivations for the create-job wizard (PLAN.md chunk 5).
 *
 * Everything here is side-effect free so the mode mapping and the gating
 * rules can be unit-tested without mounting the wizard. The components own
 * the React state; this module owns what the state *means*.
 */
import { CAPTION_STYLE_DEFAULT, type CaptionStyle } from './captionStyle'
import { buildDubBrief, dubTargetDurationSec } from './dubBrief'
import type { ProjectMode } from './projectFlow'
import { canSnapToBeat } from './platformFeatures'

/** What the user picks. `highlight` (ตัดฉากเด่น) fans out into three backend
 * modes via the voice choice; `longform` (R17) is its own card because its
 * RESULT differs in kind — many clips, not one. */
export type UiMode = 'silence' | 'highlight' | 'longform'

/** Voice choice, only meaningful for `highlight`. `original` (R17) keeps the
 * clip's own audio and cuts from the transcript — no script, no voiceover. */
export type VoiceoverChoice = 'ai' | 'own' | 'none' | 'original'

export interface WizardFile {
  id: string
  path: string
  name: string
  /** Absent for files received over LAN — they arrive as a path only. */
  file?: File
  /** Filled in asynchronously once the clip has been probed; null until then. */
  durationSec: number | null
  width: number | null
  height: number | null
  sizeBytes: number | null
  /** Source video codec, once probed. */
  codec?: string | null
  /**
   * Whether this browser can decode the clip's pictures. `false` means the
   * import will be refused, so the row says so while there is still a choice
   * to make — the alternative is finding out after the wizard has been
   * completed and a job started.
   */
  decodable?: boolean
  /** The probe has been ATTEMPTED. Separate from the fields above because a
   * successful sidecar probe still leaves `sizeBytes` null (it has no File),
   * and "no numbers yet" therefore cannot mean "not probed yet" — see the
   * probe effect in WizardPage. */
  probed?: boolean
  /** Project name for this clip in `separate` mode, where every clip becomes
   * its own project. `undefined` is "never typed here", `''` is "cleared on
   * purpose" — both fall back to the file name, but only the first may be
   * overwritten by the prefill. */
  projectName?: string
}

export interface WizardMusic {
  path: string
  name: string
  trimInSec: number
  trimOutSec: number
}

export interface WizardState {
  files: WizardFile[]
  uiMode: UiMode
  voiceover: VoiceoverChoice
  /** One project for all clips, or one project per clip. */
  uploadMode: 'merge' | 'separate'
  /** A `DUB_DURATION_FIXED` / `DUB_DURATION_AUTO` value; '' means nothing
   * picked yet. */
  duration: string
  customSec: string
  /** Free-text context for the AI — one field for both modes. */
  note: string
  /** Only used when `voiceover === 'own'`. */
  userScript: string
  cutStyleUid: string
  /** AI quality tiers. `engine` picks which model does the cut, `precision`
   * how densely it reads the footage — see backend packages/video/quality.py
   * for what each maps to (nothing user-visible names the vendor). */
  engine: 'lite' | 'pro'
  precision: 'standard' | 'high'
  music: WizardMusic | null
  /** Whether the AI should be given the music's beat grid to cut against.
   * Meaningless without music, so it is force-disabled in the UI until one
   * is chosen. */
  beatSync: boolean
  captionEnabled: boolean
  captionStyle: CaptionStyle
  /** Project name in `merge` mode, where every clip lands in one project.
   * Prefilled from the first clip's file name while `projectNameTouched` is
   * false. */
  projectName: string
  /** The user has edited the merge-mode name — including clearing it. Without
   * this flag the prefill could not tell "hasn't typed yet" from "deleted it
   * on purpose", and adding a clip would silently restore a name the user had
   * just removed. */
  projectNameTouched: boolean
}

export const WIZARD_INITIAL: WizardState = {
  files: [],
  uiMode: 'silence',
  voiceover: 'ai',
  uploadMode: 'merge',
  projectName: '',
  projectNameTouched: false,
  duration: '30',
  customSec: '',
  note: '',
  userScript: '',
  cutStyleUid: '',
  engine: 'pro',
  precision: 'standard',
  music: null,
  beatSync: true,
  captionEnabled: true,
  captionStyle: CAPTION_STYLE_DEFAULT
}

export const UI_MODE_LABEL: Record<UiMode, string> = {
  silence: 'ตัดช่วงเงียบ',
  highlight: 'ตัดฉากเด่น',
  longform: 'ตัดไฮไลต์จากคลิปยาว'
}

export const VOICEOVER_LABEL: Record<VoiceoverChoice, string> = {
  ai: 'ให้ AI ร่างสคริปต์',
  own: 'พิมพ์เอง',
  none: 'ไม่พากย์',
  original: 'ใช้เสียงในคลิป'
}

/**
 * The value actually stored on the project and sent to the backend. The third
 * backend mode survives here and only here — no other part of the UI may
 * branch on it.
 */
export function backendMode(uiMode: UiMode, voiceover: VoiceoverChoice): ProjectMode {
  if (uiMode === 'silence') return 'talking_head'
  if (uiMode === 'longform') return 'speech_highlights'
  if (voiceover === 'original') return 'speech_scenes'
  return voiceover === 'none' ? 'highlight' : 'dub_first'
}

/** Total source length, or null while any clip is still being probed. */
export function totalDurationSec(files: WizardFile[]): number | null {
  if (files.length === 0) return 0
  let total = 0
  for (const f of files) {
    if (f.durationSec === null) return null
    total += f.durationSec
  }
  return total
}

/**
 * Combined source-length ceiling — two hours for both modes.
 *
 * ตัดฉากเด่น used to stop at 20 minutes because it uploads a video proxy for AI
 * analysis rather than audio. Measured on this machine, that proxy runs about
 * 60 KB/s (480p/12fps/crf28) and Gemini reads it at ~66 tokens per second of
 * footage, so two hours is roughly a 430 MB upload and ~480k input tokens —
 * large, but inside the model's context and inside what the pipeline can carry.
 * The ceiling is therefore about what the machine can move, not about what the
 * model can read; `SOFT_CAP_SEC` is where the UI starts warning that a run will
 * cost real time and credits.
 */
export function capSecFor(uiMode: UiMode): number {
  // longform/silence never upload video at all (audio only), highlight uploads
  // a proxy — all three share the same two-hour ceiling today.
  return uiMode === 'highlight' ? 2 * 60 * 60 : 2 * 60 * 60
}

/** Past this much footage a ตัดฉากเด่น run is slow and expensive enough that the
 * user should be told before starting, not after. */
export const SOFT_CAP_SEC = 40 * 60

export type ClipRole = 'only' | 'open' | 'mid' | 'close'

/** Role is derived from position, never stored — the backend only ever sees
 * the clip order, so a role that could disagree with it would be a lie. */
export function roleFor(index: number, total: number): ClipRole {
  if (total <= 1) return 'only'
  if (index === 0) return 'open'
  if (index === total - 1) return 'close'
  return 'mid'
}

export const ROLE_LABEL: Record<ClipRole, string> = {
  only: 'คลิปเดียว',
  open: 'คลิปเปิด',
  mid: 'กลางคลิป',
  close: 'คลิปปิด'
}

/** A freshly-added clip: identified, not yet probed. */
export function toWizardFile(picked: { path: string; name: string; file?: File }): WizardFile {
  return {
    id: crypto.randomUUID(),
    path: picked.path,
    name: picked.name,
    file: picked.file,
    durationSec: null,
    width: null,
    height: null,
    sizeBytes: null
  }
}

export function moveToIndex<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items
  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return h > 0 ? `${h}:${mm}:${String(r).padStart(2, '0')}` : `${mm}:${String(r).padStart(2, '0')}`
}

export function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${Math.round(bytes / 1024 ** 2)} MB`
}

export interface Gate {
  ok: boolean
  /** Why the step cannot be left — shown beside the disabled button. */
  reason?: string
}

/** The cap as prose ("20 นาที" / "2 ชั่วโมง"), never as a clock — the 2h cap
 * formatted by `fmtClock` reads "2:00:00", and a h:mm:ss string glued to the
 * word "นาที" is not a reason anyone can act on. */
export function capLabel(uiMode: UiMode): string {
  const sec = capSecFor(uiMode)
  return sec % 3600 === 0 ? `${sec / 3600} ชั่วโมง` : `${sec / 60} นาที`
}

export function fileStepGate(state: WizardState): Gate {
  if (state.files.length === 0) return { ok: false, reason: 'เลือกคลิปอย่างน้อย 1 ไฟล์' }
  const total = totalDurationSec(state.files)
  if (total !== null && total > capSecFor(state.uiMode)) {
    return { ok: false, reason: `รวมกันเกิน ${capLabel(state.uiMode)}` }
  }
  return { ok: true }
}

export function outcomeStepGate(state: WizardState): Gate {
  if (state.uiMode === 'silence') return { ok: true }
  if (!state.duration) return { ok: false, reason: 'เลือกความยาวก่อน' }
  if (state.duration === 'custom' && !state.customSec) {
    return { ok: false, reason: 'ใส่ความยาวเป็นวินาที' }
  }
  if (state.uiMode === 'longform') return { ok: true }
  if (state.voiceover === 'own' && !state.userScript.trim()) {
    return { ok: false, reason: 'พิมพ์สคริปต์ที่จะพากย์ก่อน' }
  }
  return { ok: true }
}

/**
 * Whether captions can be burned in for the current choices.
 *
 * Captions need text with timings. talking_head always has it (the
 * transcript). ตัดฉากเด่น has none yet — splitting a voiceover line across its
 * scenes is chunk 9's work — and with voiceover "none" there is no text at
 * all, which stays true even after chunk 9. Both cases are surfaced as a
 * disabled switch with its reason rather than a switch that silently does
 * nothing; `buildSubmission` drops the style on exactly the same condition.
 */
export function captionGate(state: WizardState): Gate {
  if (state.uiMode === 'silence' || state.uiMode === 'longform') return { ok: true }
  // ใช้เสียงในคลิป (R17): the transcript is the caption source, same as ตัดช่วงเงียบ.
  if (state.voiceover === 'original') return { ok: true }
  // ตัดฉากเด่น has no transcript, but it does have the voiceover script — the
  // caption lines come from splitting each spoken line across its scenes
  // (`captionLines.dubCaptionLines`). With no voiceover there is no text at
  // all, and no split can invent one.
  if (state.voiceover === 'none') return { ok: false, reason: 'โหมดไม่พากย์ไม่มีข้อความให้ใส่' }
  return { ok: true }
}

/** How many projects "เริ่มตัดต่อ" will create. */
export function projectCount(state: WizardState): number {
  return state.uploadMode === 'separate' && state.files.length > 1 ? state.files.length : 1
}

/**
 * The name the wizard used before R11: the first clip's file name without its
 * extension. Still the fallback, so a project is never nameless — it is just no
 * longer the only option.
 */
export function defaultProjectName(group: WizardFile[]): string {
  return (group[0]?.name ?? '').replace(/\.[^.]+$/, '')
}

/**
 * The name handed to `projects.create` for one group of clips.
 *
 * Whitespace-only counts as empty: a name of three spaces is indistinguishable
 * from no name in every list that shows it. Duplicates are allowed on purpose —
 * two takes of the same shoot legitimately share a name, and the uid is what
 * identifies a project anyway.
 */
export function resolvedProjectName(state: WizardState, group: WizardFile[]): string {
  const typed =
    projectCount(state) > 1
      ? (group[0]?.projectName ?? '')
      : // An untouched merge-mode field SHOWS the default rather than storing
        // it (see `mergeNameValue`), so an untouched state must resolve the
        // same way instead of reading a `projectName` that is still ''.
        state.projectNameTouched
        ? state.projectName
        : ''
  return typed.trim() || defaultProjectName(group)
}

/**
 * What the merge-mode field displays: the file-name default until the user
 * types, their text afterwards. Keeping the default out of state is what lets
 * "never typed" and "cleared on purpose" stay distinguishable without an
 * effect writing back into the state it just read.
 */
export function mergeNameValue(state: WizardState): string {
  return state.projectNameTouched ? state.projectName : defaultProjectName(state.files)
}

/**
 * Everything the wizard has to hand to `projects.create` / `projects.update`,
 * derived in one place so step 3 can display exactly what will be sent.
 */
export interface WizardSubmission {
  mode: ProjectMode
  brief: string
  userScript: string
  targetDurationSec: number | undefined
  cutStyleUid: string | undefined
  captionStyle: CaptionStyle | undefined
  beatSync: boolean
}

export function buildSubmission(state: WizardState): WizardSubmission {
  const mode = backendMode(state.uiMode, state.voiceover)
  const isCut = mode === 'dub_first' || mode === 'highlight'
  const isSpeech = mode === 'speech_highlights' || mode === 'speech_scenes'
  const musicLen = state.music ? state.music.trimOutSec - state.music.trimInSec : null

  return {
    mode,
    // Speech modes: the free-text note travels alone — the duration prefix
    // buildDubBrief adds exists for the video prompt, and the speech selector
    // receives duration as a real field instead.
    brief: isCut ? (buildDubBrief(state.duration, state.customSec, state.note) ?? '') : state.note.trim(),
    userScript: state.voiceover === 'own' && mode === 'dub_first' ? state.userScript.trim() : '',
    targetDurationSec:
      isCut || isSpeech
        ? (dubTargetDurationSec(state.duration, state.customSec, musicLen) ?? undefined)
        : undefined,
    // speech_scenes keeps the saved cut style; speech_highlights uses none.
    cutStyleUid:
      (isCut || mode === 'speech_scenes') && state.cutStyleUid ? state.cutStyleUid : undefined,
    // Same condition the UI shows — see captionGate.
    captionStyle: captionGate(state).ok && state.captionEnabled ? state.captionStyle : undefined,
    // Speech modes keep the original audio — no music track, no beat grid.
    // And never true on a build that cannot snap: the switch is hidden there,
    // so a default of `true` would travel into the project and describe a cut
    // that was never made that way.
    beatSync: canSnapToBeat && isCut && Boolean(state.music) && state.beatSync
  }
}

export interface SummaryRow {
  key: 'outcome' | 'sources' | 'cutStyle' | 'quality' | 'music' | 'captions' | 'cost'
  label: string
  value: string
  /** Which step "แก้" jumps back to. */
  step: 1 | 2
}

export function summaryRows(state: WizardState, cutStyleName: string | null): SummaryRow[] {
  const total = totalDurationSec(state.files)
  const durationLabel =
    state.duration === 'auto'
      ? 'ให้ AI เลือกความยาว'
      : state.duration === 'music'
        ? 'ยาวตามเพลง'
        : state.duration === 'custom'
          ? `${state.customSec || '—'} วินาที`
          : `${state.duration} วินาที`

  const outcome =
    state.uiMode === 'silence'
      ? UI_MODE_LABEL.silence
      : state.uiMode === 'longform'
        ? `${UI_MODE_LABEL.longform} · ${durationLabel}`
        : `${UI_MODE_LABEL.highlight} · ${VOICEOVER_LABEL[state.voiceover]} · ${durationLabel}`

  const count = projectCount(state)
  const sources =
    `${state.files.length} ไฟล์` +
    (total === null ? '' : ` · ${fmtClock(total)}`) +
    (count > 1 ? ` · แยกเป็น ${count} โปรเจกต์` : '')

  const rows: SummaryRow[] = [
    { key: 'outcome', label: 'ผลลัพธ์', value: outcome, step: 2 },
    { key: 'sources', label: 'คลิปต้นฉบับ', value: sources, step: 1 }
  ]

  if (state.uiMode === 'highlight' && state.voiceover !== 'original') {
    rows.push({
      key: 'cutStyle',
      label: 'สไตล์การตัด',
      value: cutStyleName ?? 'สไตล์เริ่มต้น (ระบบ)',
      step: 2
    })
    rows.push({
      key: 'music',
      label: 'เพลงประกอบ',
      value: state.music
        ? `${state.music.name}${canSnapToBeat && state.beatSync ? ' · ตัดตามจังหวะ' : ''}`
        : 'ไม่ใส่',
      step: 2
    })
  }
  if (state.uiMode === 'highlight' && state.voiceover === 'original') {
    rows.push({
      key: 'cutStyle',
      label: 'สไตล์การตัด',
      value: cutStyleName ?? 'สไตล์เริ่มต้น (ระบบ)',
      step: 2
    })
  }

  // Speech modes bill by audio length (Scribe) + a transcript-sized LLM call.
  // The row states the measured total only — a guessed minutes figure would
  // violate the same rule etaMinutes follows (estimates must be measurements).
  if (
    state.uiMode === 'longform' ||
    (state.uiMode === 'highlight' && state.voiceover === 'original')
  ) {
    rows.push({
      key: 'cost',
      label: 'เวลาและเครดิต',
      value:
        total === null
          ? 'คิดตามความยาวเสียงรวม'
          : `ถอดเสียง ${fmtClock(total)} · คิดเครดิตตามความยาวเสียง`,
      step: 1
    })
  }

  // Only the video-cut modes read the footage frame by frame, so precision is
  // the only tier that means anything there; the speech modes cut from a
  // transcript and would show a dial that changes nothing.
  if (state.uiMode === 'highlight' && state.voiceover !== 'original') {
    rows.push({
      key: 'quality',
      label: 'คุณภาพ AI',
      value: `${state.engine === 'pro' ? 'Pro' : 'Lite'} · ความละเอียด${
        state.precision === 'high' ? ' High' : ' Standard'
      }`,
      step: 2
    })
  }

  const captions = captionGate(state)
  rows.push({
    key: 'captions',
    label: 'คำบรรยาย',
    value: !captions.ok
      ? `ปิด — ${captions.reason}`
      : state.captionEnabled
        ? `เปิด · ${state.captionStyle.font} ${state.captionStyle.size}px`
        : 'ปิด',
    step: 2
  })

  return rows
}
