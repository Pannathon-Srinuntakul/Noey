/**
 * One way to write a file into OPFS, whichever API this browser has.
 *
 * WEB ONLY. Chrome and Firefox give the main thread
 * `FileSystemFileHandle.createWritable()`. Safari does not — it implements
 * `createSyncAccessHandle()` instead, and only inside a Worker. Every write in
 * this app went through `createWritable`, so on an iPhone the app loaded,
 * accepted a clip, and died on the first write with
 * `c.createWritable is not a function` (2026-09-09).
 *
 * So: probe once, then route every write down whichever path works. Callers
 * (`fs.writeFileAtomic`, `fs.openStagedWrite`) see the same contract either
 * way — bytes land in `.<name>.part` and the destination appears complete or
 * not at all.
 */

import { splitFsPath } from './fs'

let current: Worker | null = null
let seq = 0

type Pending = { resolve: () => void; reject: (err: Error) => void }

/** Calls awaiting a reply from `current`, by message id. */
const pending = new Map<string, Pending>()

/**
 * One worker for the whole session — spawning per write would dominate.
 *
 * Its three listeners are attached once, here. `message` answers a call;
 * `error` (an uncaught throw inside the worker, or a failure to load it) and
 * `messageerror` (a reply that could not be deserialised) used to have no
 * listener at all, so a worker that died left every caller's promise
 * pending for ever — the render sat at its last percentage with no error.
 * Now every outstanding call is rejected and the next call gets a fresh
 * worker; the caller's own discard/retry logic takes it from there.
 */
function worker(): Worker {
  if (current) return current
  const w = new Worker(new URL('./opfsWriteWorker.ts', import.meta.url), { type: 'module' })
  w.addEventListener('message', (e: MessageEvent) => {
    const msg = e.data as { id?: string; ok?: boolean; error?: string }
    const p = msg.id ? pending.get(msg.id) : undefined
    if (!p) return
    pending.delete(msg.id as string)
    if (msg.ok) p.resolve()
    else p.reject(new Error(msg.error || 'เขียนไฟล์ไม่สำเร็จ'))
  })
  const died = (why: string): void => {
    if (current === w) current = null
    w.terminate()
    const waiting = [...pending.values()]
    pending.clear()
    for (const p of waiting) p.reject(new Error(`เขียนไฟล์ไม่สำเร็จ — ${why}`))
  }
  w.addEventListener('error', (e: ErrorEvent) => died(e.message || 'worker error'))
  w.addEventListener('messageerror', () => died('unreadable reply'))
  current = w
  return w
}

/**
 * One request/response round trip.
 *
 * The message id is generated HERE and never comes from the payload: the file
 * id used to double as the message id, so two operations on the same file
 * could resolve each other's promise.
 */
function call(
  op: string,
  payload: Record<string, unknown> = {},
  transfer: Transferable[] = []
): Promise<void> {
  const w = worker()
  const id = `m${++seq}`
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      w.postMessage({ ...payload, id, op }, transfer)
    } catch (err) {
      pending.delete(id)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

/** Test seam: outstanding calls, and a way to kill the worker as the browser would. */
export const __workerRpc = {
  pendingCount: (): number => pending.size,
  current: (): Worker | null => current
}

// ── which path does this browser take? ───────────────────────────────────────

let capability: Promise<'writable' | 'worker' | 'none'> | null = null

/**
 * Resolved ONCE, by trying rather than sniffing.
 *
 * A feature test on the prototype is not enough: Safari has shipped the
 * property in some builds and thrown on use, and the capability gate has to
 * report what actually works.
 */
export function writeCapability(): Promise<'writable' | 'worker' | 'none'> {
  if (capability) return capability
  capability = (async () => {
    const proto = (globalThis as unknown as { FileSystemFileHandle?: { prototype?: object } })
      .FileSystemFileHandle?.prototype
    if (proto && 'createWritable' in proto) return 'writable' as const
    try {
      await call('probe')
      return 'worker' as const
    } catch {
      return 'none' as const
    }
  })()
  return capability
}

// ── the two operations fs.ts needs ───────────────────────────────────────────

async function toArrayBuffer(data: Uint8Array): Promise<ArrayBuffer> {
  // Copy: the worker takes ownership of whatever is transferred, and the
  // caller's view may be a slice of a buffer it still uses.
  return data.slice().buffer as ArrayBuffer
}

/** A Blob crosses to the worker in slices of this size, never whole. */
const BLOB_SLICE = 8 * 1024 * 1024

/** Whole-file atomic write through the worker. */
export async function workerWriteFile(
  path: string,
  data: Uint8Array | Blob | ReadableStream<Uint8Array>
): Promise<void> {
  const { segments, name } = splitFsPath(path)
  const file = `f${++seq}`
  await call('begin', { file, segments, name })
  try {
    if (data instanceof ReadableStream) {
      const reader = data.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const buf = await toArrayBuffer(value)
        await call('chunk', { file, data: buf }, [buf])
      }
    } else if (data instanceof Blob) {
      // Sliced: a staged source clip is a Blob, and `arrayBuffer()` on the
      // whole of it put a multi-gigabyte file in the tab's memory to copy it
      // into a store it was already in.
      for (let at = 0; at < data.size; at += BLOB_SLICE) {
        const buf = await data.slice(at, Math.min(data.size, at + BLOB_SLICE)).arrayBuffer()
        await call('chunk', { file, data: buf }, [buf])
      }
    } else {
      const buf = await toArrayBuffer(data)
      await call('chunk', { file, data: buf }, [buf])
    }
    await call('publish', { file })
  } catch (err) {
    await call('discard', { file }).catch(() => undefined)
    throw err
  }
}

/** What mediabunny's StreamTarget writes into the stream it is given. */
export type MuxChunk = { type: 'write'; data: Uint8Array; position: number }

/**
 * A `WritableStream` the encoder can hand to mediabunny's StreamTarget, backed
 * by the worker. Same shape `openStagedWrite` returns on the fast path.
 *
 * The muxer writes `{type,data,position}` and revisits earlier offsets (the
 * moov box is patched once the media is written), so the position travels with
 * every chunk rather than being inferred.
 */
export async function workerStagedWrite(path: string): Promise<{
  writable: WritableStream<MuxChunk>
  publish: () => Promise<string>
  discard: () => Promise<void>
}> {
  const { segments, name } = splitFsPath(path)
  const file = `s${++seq}`
  await call('begin', { file, segments, name })

  const writable = new WritableStream<MuxChunk>({
    async write(chunkData) {
      const buf = await toArrayBuffer(chunkData.data)
      await call('chunk', { file, data: buf, at: chunkData.position }, [buf])
    },
    // A stream the muxer aborts must not leave the staging handle locked:
    // the next write to the same path would wait on that lock for ever.
    async abort() {
      await call('discard', { file }).catch(() => undefined)
    }
  })

  return {
    writable,
    publish: async () => {
      await call('publish', { file })
      return path
    },
    discard: async () => {
      await call('discard', { file }).catch(() => undefined)
    }
  }
}
