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

let workerPromise: Promise<Worker> | null = null
let seq = 0

function spawn(): Worker {
  return new Worker(new URL('./opfsWriteWorker.ts', import.meta.url), { type: 'module' })
}

/** One worker for the whole session — spawning per write would dominate. */
function worker(): Promise<Worker> {
  if (!workerPromise) workerPromise = Promise.resolve(spawn())
  return workerPromise
}

/**
 * One request/response round trip.
 *
 * The message id is generated HERE and never comes from the payload: the file
 * id used to double as the message id, so two operations on the same file
 * could resolve each other's promise.
 */
async function call(
  op: string,
  payload: Record<string, unknown> = {},
  transfer: Transferable[] = []
): Promise<void> {
  const w = await worker()
  const id = `m${++seq}`
  return new Promise((resolve, reject) => {
    const onMessage = (e: MessageEvent): void => {
      const msg = e.data as { id: string; ok: boolean; error?: string }
      if (msg.id !== id) return
      w.removeEventListener('message', onMessage)
      if (msg.ok) resolve()
      else reject(new Error(msg.error || 'เขียนไฟล์ไม่สำเร็จ'))
    }
    w.addEventListener('message', onMessage)
    w.postMessage({ ...payload, id, op }, transfer)
  })
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

async function toArrayBuffer(data: Uint8Array | Blob): Promise<ArrayBuffer> {
  if (data instanceof Blob) return data.arrayBuffer()
  // Copy: the worker takes ownership of whatever is transferred, and the
  // caller's view may be a slice of a buffer it still uses.
  return data.slice().buffer as ArrayBuffer
}

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
