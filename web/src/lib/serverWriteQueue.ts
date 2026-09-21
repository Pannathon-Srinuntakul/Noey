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
 */

/** The two server documents the editor, the swap and the revert rewrite. */
export type ServerDoc = 'edit_script' | 'timeline'

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
}

export function createServerWriteQueue(): ServerWriteQueue {
  let chain: Promise<unknown> = Promise.resolve()
  const gens: Record<ServerDoc, number> = { edit_script: 0, timeline: 0 }
  return {
    write: <T>(doc: ServerDoc, put: () => Promise<T>, opts?: { draft?: boolean }) => {
      const gen = ++gens[doc]
      const run = chain.then(() => (opts?.draft && gen !== gens[doc] ? undefined : put()))
      chain = run.catch(() => undefined)
      return run
    },
    idle: async () => {
      await chain
    }
  }
}
