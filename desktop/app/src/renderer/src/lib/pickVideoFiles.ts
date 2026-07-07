export interface PickedVideoFile {
  path: string
  name: string
  file: File
}

/** Opens a native file picker for one or more video files. */
export function pickVideoFiles(): Promise<PickedVideoFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'video/*'
    input.multiple = true
    input.onchange = () => {
      const files = Array.from(input.files ?? [])
      resolve(
        files
          .map((f) => ({
            path:
              window.electron.webUtils?.getPathForFile?.(f) ??
              (f as unknown as { path?: string }).path ??
              '',
            name: f.name,
            file: f
          }))
          .filter((f) => f.path)
      )
    }
    input.oncancel = () => resolve([])
    input.click()
  })
}
