import { beforeEach, describe, expect, it, vi } from 'vitest'

const exposed: Record<string, unknown> = {}
const sendSync = vi.fn()

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: unknown) => {
      exposed[name] = api
    }
  },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn(), sendSync },
  webUtils: {
    getPathForFile: (f: { fake?: boolean; name: string }) => (f.fake ? '' : `/picked/${f.name}`)
  }
}))

describe('preload bridge', () => {
  beforeEach(async () => {
    sendSync.mockReset()
    await import('./index')
  })

  it('exposes no raw ipcRenderer and no process.env on window.electron', () => {
    const bridge = exposed.electron as Record<string, unknown>
    expect(Object.keys(bridge)).toEqual(['webUtils'])
    expect(bridge).not.toHaveProperty('ipcRenderer')
    expect(bridge).not.toHaveProperty('process')
    expect(Object.keys(bridge.webUtils as object)).toEqual(['getPathForFile'])
    expect(exposed.noey).toBeTruthy()
  })

  it('grants a picked file to main, and nothing for a script-made File', () => {
    const { webUtils } = exposed.electron as {
      webUtils: { getPathForFile: (f: unknown) => string }
    }
    expect(webUtils.getPathForFile({ name: 'song.mp3' })).toBe('/picked/song.mp3')
    expect(sendSync).toHaveBeenCalledWith('files:grant', '/picked/song.mp3')
    sendSync.mockReset()
    expect(webUtils.getPathForFile({ name: 'x', fake: true })).toBe('')
    expect(sendSync).not.toHaveBeenCalled()
  })
})
