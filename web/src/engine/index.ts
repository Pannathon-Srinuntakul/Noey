/**
 * The render engine's public face: the same `sidecar.*` surface the desktop
 * preload exposes, so `useProjectPipeline` and the editors call it unchanged.
 *
 * Behind it there is no Python and no ffmpeg — jobs run in a worker on
 * WebCodecs. What has to match exactly is the CONTRACT, because the UI depends
 * on it in ways that are easy to miss:
 *
 *   - progress events are broadcast and filtered by `projectDir`, so every
 *     event this emits carries the `projectDir` of the job that produced it;
 *   - the promise resolves with the LAST event a job emits, whatever its
 *     `event` field says (the desktop resolves with `lastEvent`, which is how
 *     `render-effects` gets away with emitting `result` instead of `done`);
 *   - jobs for one project are serialised, matching `withProjectLock` — several
 *     of them delete and rewrite the same `clips/` directory.
 *
 * Job implementations land in `./jobs/*` as the gates are worked through; until
 * one exists its command rejects with a clear message rather than resolving
 * with something the UI would treat as success.
 */

import type { JobCommandApi, SidecarEvent } from '../platform/types'
import { holdScreenAwake } from '../lib/wakeLock'

export type ProgressCallback = (evt: SidecarEvent) => void

type Listener = { cb: ProgressCallback; projectDir?: string }

/** One implementation per sidecar command. */
export type JobRunner = (
  job: Record<string, unknown>,
  emit: ProgressCallback
) => Promise<SidecarEvent>

const runners = new Map<string, JobRunner>()

/** Registered by `./jobs/index.ts` as each command is implemented. */
export function registerJob(command: string, runner: JobRunner): void {
  runners.set(command, runner)
}

// ── per-project serialisation (the desktop's withProjectLock) ────────────────
const projectQueues = new Map<string, Promise<unknown>>()

function withProjectLock<T>(projectDir: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!projectDir) return fn()
  const prev = projectQueues.get(projectDir) ?? Promise.resolve()
  const next = prev.catch(() => undefined).then(fn)
  projectQueues.set(
    projectDir,
    next.catch(() => undefined)
  )
  return next
}

// ── cancellation ─────────────────────────────────────────────────────────────
const aborters = new Map<string, AbortController>()

export function currentAbortSignal(projectDir: string): AbortSignal | undefined {
  return aborters.get(projectDir)?.signal
}

function cancel(projectDir: string): void {
  aborters.get(projectDir)?.abort()
}

// ── the command surface ──────────────────────────────────────────────────────
function jobCommand(command: string): JobCommandApi {
  const listeners = new Set<Listener>()

  return {
    run: async (job: unknown): Promise<SidecarEvent> => {
      const spec = (job ?? {}) as Record<string, unknown>
      const projectDir = typeof spec.projectDir === 'string' ? spec.projectDir : undefined

      return withProjectLock(projectDir, async () => {
        const runner = runners.get(command)
        if (!runner) {
          throw new Error(`ยังไม่รองรับคำสั่ง "${command}" บนเว็บ`)
        }
        const controller = new AbortController()
        if (projectDir) aborters.set(projectDir, controller)

        // Stamped with projectDir on the way out, so a listener that passed one
        // hears only its own project — same reason the desktop main process
        // stamps it.
        const emit: ProgressCallback = (evt) => {
          const stamped = projectDir ? { ...evt, projectDir } : evt
          for (const l of listeners) {
            if (l.projectDir && stamped.projectDir !== l.projectDir) continue
            l.cb(stamped)
          }
        }

        // A render that outlives the screen going dark is the difference
        // between finishing and stopping halfway on a phone: dimming is the
        // first step to the tab being suspended, and a suspended tab stops
        // encoding. Held for every job, since every job is work someone is
        // waiting on.
        const releaseScreen = holdScreenAwake()
        try {
          // The signal goes IN with the job — jobs read `job.signal`, and
          // without this `cancel()` aborted a controller nothing was watching,
          // so หยุดงาน left the encode running to completion.
          return await runner({ ...spec, signal: controller.signal }, emit)
        } finally {
          releaseScreen()
          if (projectDir && aborters.get(projectDir) === controller) {
            aborters.delete(projectDir)
          }
        }
      })
    },

    onProgress: (cb, projectDir) => {
      const listener: Listener = { cb, projectDir }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

/** `probe` is the one command that is not a job file — it takes a path. */
async function probe(path: string): Promise<SidecarEvent> {
  const runner = runners.get('probe')
  if (!runner) throw new Error('ยังไม่รองรับการอ่านข้อมูลไฟล์บนเว็บ')
  return runner({ file: path }, () => undefined)
}

export const sidecar = {
  ping: async (): Promise<SidecarEvent> => ({ event: 'pong', engine: 'webcodecs' }),
  probe,
  ingest: jobCommand('ingest'),
  extractProxy: jobCommand('extract-proxy'),
  renderSilent: jobCommand('render-silent'),
  renderFinal: jobCommand('render-final'),
  mixMusic: jobCommand('mix-music'),
  extractAudio: jobCommand('extract-audio'),
  renderTimeline: jobCommand('render-timeline'),
  renderHighlights: jobCommand('render-highlights'),
  renderAiPreview: jobCommand('render-ai-preview'),
  renderEffects: jobCommand('render-effects'),
  proxyOne: jobCommand('proxy-one'),
  filmstrip: jobCommand('filmstrip'),
  cancel: async (projectDir: string): Promise<void> => cancel(projectDir)
}
