import { useCallback, useEffect, useState } from 'react'
import { Film, Loader2 } from 'lucide-react'
import { cn } from '../../lib/cn'
import { useJobs } from '../../lib/jobs'

/**
 * One frame from ~5% into a clip, drawn into whatever box the caller sizes.
 *
 * A clip always arrives with a `File` here — the wizard is the only caller and
 * every path into it goes through a file picker — so the frame comes from an
 * object URL and one hidden <video> plus one canvas draw per row. (There used
 * to be a second branch for a clip received from a phone, decoded through
 * `media://inbox/<name>`; that flow is not in this build and the URL it built
 * resolved to a directory that has never existed.)
 *
 * `pending` decides what the empty box looks like while the decode runs. The
 * clip list shows a spinner because the row is the thing the user is working
 * with; the wizard's name card shows nothing, because a preview appearing late
 * is not a wait anyone is being asked to sit through (R11.5).
 */
export function ClipThumbnail({
  file,
  path,
  className,
  pending = 'spinner',
  iconSize = 13
}: {
  file?: File
  path: string
  /** Box size + shape. The image fills it with `object-fit: cover`. */
  className?: string
  pending?: 'spinner' | 'blank'
  iconSize?: number
}): React.JSX.Element {
  const [thumb, setThumb] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const { session } = useJobs()

  /**
   * Last resort for a clip this browser cannot decode.
   *
   * HEVC — every recent iPhone's default — demuxes fine here and decodes
   * nowhere on most of Windows, so `<video>` produces neither a frame nor an
   * error. What the client CAN do is cut the first key packet into a 48 KB
   * MP4; the server decodes that one frame and sends back a JPEG. Roughly
   * 1/180th of the clip travels, and only for files that need it.
   */
  const askServerForPoster = useCallback(
    async (source: Blob): Promise<string | null> => {
      const { posterFrameFromServer } = await import('../../lib/serverTranscode')
      const jpeg = await posterFrameFromServer(session, source)
      return jpeg ? URL.createObjectURL(jpeg) : null
    },
    [session]
  )

  useEffect(() => {
    let cancelled = false
    if (!file) {
      // Queued rather than set inline: a synchronous setState inside an effect
      // cascades a second render before the first has painted.
      queueMicrotask(() => setFailed(true))
      return
    }
    const url = URL.createObjectURL(file)
    const objectUrl = url
    const video = document.createElement('video')
    video.preload = 'auto'
    video.muted = true
    video.playsInline = true
    // Required for a cross-origin source: without it the canvas is tainted and
    // toDataURL throws SecurityError, which (thrown inside an event handler)
    // is swallowed and leaves the row spinning forever. Harmless for the
    // blob: URL of a picked File. Same reason the filmstrip sets it.
    video.crossOrigin = 'anonymous'

    /** The element gave up (or never answered) — try the server. */
    const fallback = (): void => {
      if (cancelled || !file) return setFailed(true)
      void askServerForPoster(file).then((posterUrl) => {
        if (cancelled) return
        if (posterUrl) setThumb(posterUrl)
        else setFailed(true)
      })
    }

    const capture = (): void => {
      if (cancelled) return
      const w = video.videoWidth
      const h = video.videoHeight
      if (!w || !h) return fallback()
      try {
        const canvas = document.createElement('canvas')
        canvas.height = 128
        canvas.width = Math.max(1, Math.round(w * (128 / h)))
        const ctx = canvas.getContext('2d')
        if (!ctx) return setFailed(true)
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        setThumb(canvas.toDataURL('image/jpeg', 0.72))
      } catch {
        // A tainted canvas or a codec the element pretended to open: the
        // server can still produce the frame.
        fallback()
      }
    }

    const seek = (): void => {
      if (cancelled) return
      const t =
        Number.isFinite(video.duration) && video.duration > 0
          ? Math.min(0.25, video.duration * 0.05)
          : 0
      if (t === 0) return capture()
      video.currentTime = t
    }

    // Listeners BEFORE src: a local file can reach `loadeddata` almost
    // immediately, and a listener attached after the assignment can miss it —
    // then nothing ever seeks and the row sits on its spinner forever.
    video.addEventListener('loadeddata', seek, { once: true })
    video.addEventListener('seeked', capture, { once: true })
    video.addEventListener('error', () => !cancelled && fallback(), { once: true })
    // HEVC makes the element fire NEITHER `loadeddata` NOR `error` — it simply
    // never settles (measured 2026-09-08). Without a deadline the row would
    // spin for as long as the wizard is open.
    const deadline = setTimeout(fallback, 4000)
    video.src = url
    if (video.readyState >= 2) seek()

    return () => {
      cancelled = true
      clearTimeout(deadline)
      video.src = ''
      video.load()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [file, path, askServerForPoster])

  return (
    <div className={cn('shrink-0 overflow-hidden', className)}>
      {thumb ? (
        <img src={thumb} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full items-center justify-center">
          {failed ? (
            <Film size={iconSize} className="text-muted" />
          ) : pending === 'spinner' ? (
            <Loader2 size={iconSize} className="animate-spin text-accent" />
          ) : null}
        </div>
      )}
    </div>
  )
}
