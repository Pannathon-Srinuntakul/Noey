/** Opens a native file picker for a single file (used for voiceover audio). */
export function pickFile(accept: string): Promise<{ path: string; name: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.onchange = () => {
      const f = input.files?.[0]
      if (!f) return resolve(null)
      // No `webUtils` in a browser: register the File and carry an opaque id
      // where the desktop carries an OS path.
      const path =
        window.electron?.webUtils?.getPathForFile?.(f) ??
        (f as unknown as { path?: string }).path ??
        window.noey.pick.register(f)
      resolve(path ? { path, name: f.name } : null)
    }
    input.oncancel = () => resolve(null)
    input.click()
  })
}
