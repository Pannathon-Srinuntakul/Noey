/**
 * OPFS writes for browsers with no `createWritable()`.
 *
 * WEB ONLY. Safari — every version on iOS as of 2026-09 — implements OPFS but
 * NOT `FileSystemFileHandle.createWritable()`. The whole app writes through
 * that one call, so an iPhone got as far as "เริ่มตัดต่อ" and then
 * `c.createWritable is not a function` (live report 2026-09-09).
 *
 * What Safari does implement is `createSyncAccessHandle()`, which the spec
 * allows only inside a Worker — hence this file. It is a plain message pump
 * over the sync API, and `opfsWrite.ts` on the main thread is its client.
 *
 * The atomic contract is the same one `fs.writeFileAtomic` guarantees: bytes
 * go to `.<name>.part`, and the destination is only written once the staging
 * file is complete. "A file that exists is complete" holds on Safari too.
 */

/// <reference lib="webworker" />

interface SyncHandle {
  write(data: BufferSource, opts?: { at?: number }): number
  read(data: BufferSource, opts?: { at?: number }): number
  truncate(n: number): void
  flush(): void
  close(): void
  getSize(): number
}

type OpenFile = {
  dir: FileSystemDirectoryHandle
  name: string
  stagingName: string
  handle: SyncHandle
  offset: number
}

const open = new Map<string, OpenFile>()

async function dirFor(segments: string[]): Promise<FileSystemDirectoryHandle> {
  let dir = await navigator.storage.getDirectory()
  for (const seg of segments) dir = await dir.getDirectoryHandle(seg, { create: true })
  return dir
}

async function syncHandle(dir: FileSystemDirectoryHandle, name: string): Promise<SyncHandle> {
  const file = await dir.getFileHandle(name, { create: true })
  const h = await (
    file as unknown as { createSyncAccessHandle: () => Promise<SyncHandle> }
  ).createSyncAccessHandle()
  return h
}

async function begin(file: string, segments: string[], name: string): Promise<void> {
  const dir = await dirFor(segments)
  const stagingName = `.${name}.part`

  // A sync access handle is an EXCLUSIVE lock held until close(). A write that
  // was interrupted (a thrown render, a closed dialog) leaves one open, and
  // opening the same staging file again then blocks FOREVER — the tab freezes
  // with no error. Anything still open for this path is closed first, so a
  // previous failure costs a discarded staging file, never a hang.
  for (const [otherId, f] of open) {
    if (f.stagingName !== stagingName) continue
    try {
      f.handle.close()
    } catch {
      // already closed
    }
    open.delete(otherId)
  }

  const handle = await syncHandle(dir, stagingName)
  handle.truncate(0)
  open.set(file, { dir, name, stagingName, handle, offset: 0 })
}

/**
 * `at` is explicit when the muxer supplies one. mediabunny's StreamTarget
 * writes `{type,data,position}` and DOES revisit earlier offsets (the moov box
 * is patched after the media), so appending blindly would corrupt the file.
 */
function chunk(id: string, data: ArrayBuffer, at?: number): void {
  const f = open.get(id)
  if (!f) throw new Error(`no open write ${id}`)
  const view = new Uint8Array(data)
  const pos = at ?? f.offset
  f.handle.write(view, { at: pos })
  f.offset = Math.max(f.offset, pos + view.byteLength)
}

/**
 * Copy staging → destination, then drop staging.
 *
 * Copied in slices rather than one buffer: the destination of a long render is
 * hundreds of megabytes, and materialising it whole would undo the streaming
 * this path exists to provide.
 */
const COPY_SLICE = 4 * 1024 * 1024

async function publish(id: string): Promise<void> {
  const f = open.get(id)
  if (!f) throw new Error(`no open write ${id}`)
  f.handle.flush()
  const total = f.handle.getSize()

  const dest = await syncHandle(f.dir, f.name)
  try {
    dest.truncate(0)
    const buf = new Uint8Array(Math.min(COPY_SLICE, Math.max(total, 1)))
    let at = 0
    while (at < total) {
      const want = Math.min(COPY_SLICE, total - at)
      const slice = buf.subarray(0, want)
      f.handle.read(slice, { at })
      dest.write(slice, { at })
      at += want
    }
    dest.flush()
  } finally {
    dest.close()
    f.handle.close()
    open.delete(id)
  }
  await f.dir.removeEntry(f.stagingName).catch(() => undefined)
}

async function discard(id: string): Promise<void> {
  const f = open.get(id)
  if (!f) return
  try {
    f.handle.close()
  } catch {
    // already closed
  }
  open.delete(id)
  await f.dir.removeEntry(f.stagingName).catch(() => undefined)
}

async function remove(segments: string[], name: string): Promise<void> {
  const dir = await dirFor(segments)
  await dir.removeEntry(name).catch(() => undefined)
}

self.onmessage = async (e: MessageEvent): Promise<void> => {
  // `id` identifies the MESSAGE (so the caller can match a reply); `file`
  // identifies the open write. Conflating them meant a reply could resolve the
  // wrong pending promise the moment two operations overlapped.
  const msg = e.data as {
    id: string
    file?: string
    op: 'begin' | 'chunk' | 'publish' | 'discard' | 'remove' | 'probe'
    segments?: string[]
    name?: string
    data?: ArrayBuffer
    at?: number
  }
  try {
    switch (msg.op) {
      case 'probe': {
        // Can this browser write at all through the sync API? Answered by
        // doing it, not by feature-sniffing — the gate needs a real answer.
        const dir = await navigator.storage.getDirectory()
        const probeName = '.opfs-write-probe'
        const h = await syncHandle(dir, probeName)
        h.write(new Uint8Array([1]), { at: 0 })
        h.flush()
        h.close()
        await dir.removeEntry(probeName).catch(() => undefined)
        break
      }
      case 'begin':
        await begin(msg.file as string, msg.segments as string[], msg.name as string)
        break
      case 'chunk':
        chunk(msg.file as string, msg.data as ArrayBuffer, msg.at)
        break
      case 'publish':
        await publish(msg.file as string)
        break
      case 'discard':
        await discard(msg.file as string)
        break
      case 'remove':
        await remove(msg.segments as string[], msg.name as string)
        break
    }
    ;(self as unknown as Worker).postMessage({ id: msg.id, ok: true })
  } catch (err) {
    ;(self as unknown as Worker).postMessage({
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

export {}
