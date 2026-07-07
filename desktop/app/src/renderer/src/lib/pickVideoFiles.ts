export interface PickedVideoFile {
  path: string
  name: string
  file: File
}

/** Resolve real filesystem paths for a browser FileList (from an <input> or a drop event). */
export function toPickedVideoFiles(files: File[]): PickedVideoFile[] {
  return files
    .filter((f) => f.type.startsWith('video/'))
    .map((f) => ({
      path:
        window.electron.webUtils?.getPathForFile?.(f) ??
        (f as unknown as { path?: string }).path ??
        '',
      name: f.name,
      file: f
    }))
    .filter((f) => f.path)
}

/** Opens a native file picker for one or more video files. */
export function pickVideoFiles(): Promise<PickedVideoFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'video/*'
    input.multiple = true
    input.onchange = () => {
      resolve(toPickedVideoFiles(Array.from(input.files ?? [])))
    }
    input.oncancel = () => resolve([])
    input.click()
  })
}
