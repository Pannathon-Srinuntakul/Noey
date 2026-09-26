export interface PickedVideoFile {
  path: string
  name: string
  // Files received over LAN have only a path, no File object.
  file?: File
}

/**
 * Extensions accepted when the browser reports no MIME type.
 *
 * Windows hands over `type === ''` for anything its registry has no entry
 * for — `.mov` and `.mkv` routinely, `.mp4` on a machine with no media
 * player registered — and a drop of those was silently ignored: the list
 * stayed empty and nothing said why.
 */
export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.mts', '.m2ts', '.avi']

export function isVideoFile(f: { name: string; type: string }): boolean {
  if (f.type.startsWith('video/')) return true
  const dot = f.name.lastIndexOf('.')
  if (dot < 0) return false
  return VIDEO_EXTENSIONS.includes(f.name.slice(dot).toLowerCase())
}

/** Which of a drop's files are video, and the names of those that are not. */
export function splitVideoFiles(files: File[]): { accepted: File[]; rejected: string[] } {
  const accepted: File[] = []
  const rejected: string[] = []
  for (const f of files) {
    if (isVideoFile(f)) accepted.push(f)
    else rejected.push(f.name)
  }
  return { accepted, rejected }
}

/** Resolve real filesystem paths for a browser FileList (from an <input> or a drop event). */
export function toPickedVideoFiles(files: File[]): PickedVideoFile[] {
  return toPickedVideoFilesDetailed(files).picked
}

/**
 * The same, plus the names that were dropped so the caller can say so —
 * "ข้ามไฟล์ที่ไม่ใช่วิดีโอ: notes.txt" beats a list that did not grow.
 */
export function toPickedVideoFilesDetailed(files: File[]): {
  picked: PickedVideoFile[]
  rejected: string[]
} {
  const { accepted, rejected } = splitVideoFiles(files)
  const picked = accepted
    .map((f) => ({
      // No `webUtils` in a browser: register the File and carry an opaque id
      // where the desktop carries an OS path.
      path:
        window.electron?.webUtils?.getPathForFile?.(f) ??
        (f as unknown as { path?: string }).path ??
        window.noey.pick.register(f),
      name: f.name,
      file: f
    }))
    .filter((f) => f.path)
  return { picked, rejected }
}

/** Opens a native file picker for one or more video files. */
export function pickVideoFiles(): Promise<PickedVideoFile[]> {
  return pickVideoFilesDetailed().then((r) => r.picked)
}

export function pickVideoFilesDetailed(): Promise<{
  picked: PickedVideoFile[]
  rejected: string[]
}> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    // The extensions as well as the MIME family: a Windows picker filters on
    // what it can name, and `video/*` alone greys out the files above.
    input.accept = ['video/*', ...VIDEO_EXTENSIONS].join(',')
    input.multiple = true
    input.onchange = () => {
      resolve(toPickedVideoFilesDetailed(Array.from(input.files ?? [])))
    }
    input.oncancel = () => resolve({ picked: [], rejected: [] })
    input.click()
  })
}
