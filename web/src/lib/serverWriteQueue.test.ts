import { describe, expect, it } from 'vitest'
import { createServerWriteQueue } from './serverWriteQueue'

const tick = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** A PUT the test finishes by hand, recording the order bodies landed in. */
function slowServer(): {
  landed: string[]
  put: (body: string) => () => Promise<string>
  finishNext: () => Promise<void>
} {
  const landed: string[] = []
  const pending: (() => void)[] = []
  return {
    landed,
    put: (body) => () =>
      new Promise<string>((resolve) => {
        pending.push(() => {
          landed.push(body)
          resolve(body)
        })
      }),
    finishNext: async () => {
      // Let queued `.then`s reach their PUT first.
      for (let i = 0; i < 5; i++) await Promise.resolve()
      pending.shift()?.()
      for (let i = 0; i < 5; i++) await Promise.resolve()
    }
  }
}

describe('createServerWriteQueue', () => {
  it('lands a save after every draft queued before it, never the other way round', async () => {
    const server = slowServer()
    const q = createServerWriteQueue()
    // Draft 1 is in flight on a slow server, draft 2 queues behind it, then
    // the Save arrives. The Save used to PUT directly and draft 2 landed last.
    void q.write('edit_script', server.put('draft-1'), { draft: true })
    await tick()
    void q.write('edit_script', server.put('draft-2'), { draft: true })
    const save = q.write('edit_script', server.put('save'))
    await server.finishNext()
    await server.finishNext()
    await expect(save).resolves.toBe('save')
    expect(server.landed).toEqual(['draft-1', 'save'])
  })

  it('skips a queued draft superseded by a newer draft of the same document', async () => {
    const server = slowServer()
    const q = createServerWriteQueue()
    void q.write('timeline', server.put('t1'), { draft: true })
    await tick()
    const stale = q.write('timeline', server.put('t2'), { draft: true })
    void q.write('timeline', server.put('t3'), { draft: true })
    await server.finishNext()
    await server.finishNext()
    await expect(stale).resolves.toBeUndefined()
    expect(server.landed).toEqual(['t1', 't3'])
  })

  it('keeps a draft of the other document', async () => {
    const server = slowServer()
    const q = createServerWriteQueue()
    void q.write('timeline', server.put('timeline'), { draft: true })
    void q.write('edit_script', server.put('script'))
    await server.finishNext()
    await server.finishNext()
    expect(server.landed).toEqual(['timeline', 'script'])
  })

  it('keeps going after a failed write, and idle() waits for the queue', async () => {
    const q = createServerWriteQueue()
    const failed = q.write('edit_script', () => Promise.reject(new Error('HTTP 0')))
    let done = false
    void q.write('edit_script', async () => {
      done = true
    })
    await expect(failed).rejects.toThrow('HTTP 0')
    await q.idle()
    expect(done).toBe(true)
  })
})
