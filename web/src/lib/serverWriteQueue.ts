/**
 * Every write of a project's server edit script / timeline, in ONE ordered
 * queue.
 *
 * Draft pushes used to run on their own chain while the editor's Save, the
 * shot swap and the revert PUT directly. On a slow server a draft queued
 * behind an earlier one then landed AFTER the Save: the server kept an older
 * cut, and plan-dub — which reads the server copy — planned the voiceover
 * render on it. Here a later write always lands later, and a queued draft that
 * a newer write of the same document has already superseded is skipped
 * outright (it would only be overwritten again).
 *
 * The queue also REMEMBERS a write that failed. Every caller swallowed the
 * rejection (a draft is safe on this device, so a failed push is not an
 * error to show), which left nothing to say that the server's copy is
 * behind — and plan-dub then planned against a cut the user had already
 * edited past. `failed(doc)` is what the plan-dub start checks.
 */

/** The two server documents the editor, the swap and the revert rewrite. */
export type ServerDoc = 'edit_script' | 'timeline'

export interface ServerWriteFailure {
  doc: ServerDoc
  error: unknown
  at: number
}

export interface ServerWriteQueue {
  /** Run `put` after every write queued before it; resolves/rejects with it.
   * A `draft` resolves undefined, unsent, when a newer write of `doc` was
   * queued while it waited. */
  write: <T>(
    doc: ServerDoc,
    put: () => Promise<T>,
    opts?: { draft?: boolean }
  ) => Promise<T | undefined>
  /** Settles once everything queued so far has landed (or failed). */
  idle: () => Promise<void>
  /** The most recent failed write of `doc` — null once a later write of the
   * same document has landed. Without `doc`, the most recent of either. */
  failed: (doc?: ServerDoc) => ServerWriteFailure | null
}

export function createServerWriteQueue(): ServerWriteQueue {
  let chain: Promise<unknown> = Promise.resolve()
  const gens: Record<ServerDoc, number> = { edit_script: 0, timeline: 0 }
  const failures: Record<ServerDoc, ServerWriteFailure | null> = {
    edit_script: null,
    timeline: null
  }
  return {
    write: <T>(doc: ServerDoc, put: () => Promise<T>, opts?: { draft?: boolean }) => {
      const gen = ++gens[doc]
      const run = chain.then(async () => {
        if (opts?.draft && gen !== gens[doc]) return undefined
        try {
          const out = await put()
          // A superseded draft resolved above without touching the server;
          // only a write that actually landed clears the record.
          failures[doc] = null
          return out
        } catch (error) {
          failures[doc] = { doc, error, at: Date.now() }
          throw error
        }
      })
      chain = run.catch(() => undefined)
      return run
    },
    idle: async () => {
      await chain
    },
    failed: (doc) => {
      if (doc) return failures[doc]
      const both = [failures.edit_script, failures.timeline].filter(
        (f): f is ServerWriteFailure => f !== null
      )
      if (both.length === 0) return null
      return both.reduce((a, b) => (b.at > a.at ? b : a))
    }
  }
}
