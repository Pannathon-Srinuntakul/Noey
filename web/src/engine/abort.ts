/**
 * The one place that turns "the user pressed หยุดงาน" into a thrown error.
 *
 * `engine/index.ts` threads an AbortSignal into every job, but only the encoder
 * read it — so cancelling during an import kept decoding and re-encoding every
 * frame to completion, and because jobs are serialised per project, the next
 * thing the user started queued behind work the UI had already said was
 * stopped.
 *
 * Called at the top of each per-clip iteration: a loop that checks once per
 * clip stops within one clip, which is as responsive as it needs to be and
 * costs nothing.
 */

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('ยกเลิกแล้ว', 'AbortError')
}

/** The signal a job was handed, if any. */
export function signalOf(job: Record<string, unknown>): AbortSignal | undefined {
  return job.signal as AbortSignal | undefined
}
