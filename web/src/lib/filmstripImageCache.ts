/**
 * LRU cache of decoded filmstrip tiles, shared by every lane on screen.
 *
 * Ported from FreeCut (MIT, walterlow/freecut,
 * `src/features/timeline/components/clip-filmstrip/filmstrip-image-cache.ts`),
 * adapted only in its comments and its cap.
 *
 * Why a cache and not React state: a five-minute source is ~580 tiles. Held as
 * `<img>` nodes with `data:` URLs — which is what this editor did before — that
 * is tens of megabytes of base64 strings inside the component's state and one
 * DOM node per tile, and every newly captured tile re-rendered the whole
 * timeline. Here a tile is decoded once, drawn into a canvas, and the component
 * only ever hears "a tile you asked for is ready, redraw".
 *
 * Entries with live listeners are never evicted, so a lane that is on screen
 * cannot have its own tiles pulled out from under it.
 */

/**
 * Decoded tiles kept alive. Each is ~54×96 RGBA ≈ 20 KB, so 512 is ~10 MB —
 * comfortably more than one screenful of lanes at any zoom, and bounded no
 * matter how long the source is.
 */
const MAX_DECODED_FILMSTRIP_IMAGES = 512

interface CachedFilmstripImage {
  image: HTMLImageElement
  status: 'loading' | 'ready' | 'error'
  listeners: Set<{ onChange: () => void; onError: () => void }>
}

const decodedImages = new Map<string, CachedFilmstripImage>()

/** Move to the end of the Map — insertion order is the LRU order. */
function touch(url: string, entry: CachedFilmstripImage): void {
  decodedImages.delete(url)
  decodedImages.set(url, entry)
}

function prune(): void {
  if (decodedImages.size <= MAX_DECODED_FILMSTRIP_IMAGES) return
  for (const [url, entry] of decodedImages) {
    if (decodedImages.size <= MAX_DECODED_FILMSTRIP_IMAGES) break
    if (entry.listeners.size > 0) continue
    entry.image.onload = null
    entry.image.onerror = null
    entry.image.src = ''
    decodedImages.delete(url)
  }
}

function createEntry(url: string): CachedFilmstripImage {
  const image = new Image()
  image.decoding = 'async'
  const entry: CachedFilmstripImage = { image, status: 'loading', listeners: new Set() }
  image.onload = () => {
    entry.status = 'ready'
    for (const listener of entry.listeners) listener.onChange()
  }
  image.onerror = () => {
    entry.status = 'error'
    for (const listener of entry.listeners) listener.onError()
  }
  image.src = url
  decodedImages.set(url, entry)
  return entry
}

/** Start (or join) a decode for `url`; returns the unsubscribe. */
export function subscribeFilmstripImage(
  url: string,
  onChange: () => void,
  onError: () => void
): () => void {
  const entry = decodedImages.get(url) ?? createEntry(url)
  const listener = { onChange, onError }
  entry.listeners.add(listener)
  touch(url, entry)
  prune()
  if (entry.status === 'ready') onChange()
  else if (entry.status === 'error') onError()
  return () => {
    entry.listeners.delete(listener)
    prune()
  }
}

/** The decoded bitmap, or null while it is still loading or if it failed. */
export function getDecodedFilmstripImage(url: string): HTMLImageElement | null {
  const entry = decodedImages.get(url)
  if (!entry || entry.status !== 'ready') return null
  touch(url, entry)
  return entry.image
}

/**
 * Drop everything. Called when a project's strips are re-extracted under the
 * same URLs, and by tests — `media://` is served no-store, so a stale decode is
 * the only way old bytes could survive a re-extract.
 */
export function resetDecodedFilmstripImages(): void {
  forgetDecodedFilmstripImages(() => true)
}

/**
 * Drop the decodes whose URL contains `fragment` — one clip's strip after a
 * re-extract. Dropping EVERYTHING per clip, as the strips hook used to, threw
 * away the tiles the lanes were painting N times while N clips landed.
 */
export function forgetDecodedFilmstripImagesFor(fragment: string): void {
  forgetDecodedFilmstripImages((url) => url.includes(fragment))
}

/**
 * Tiles something on screen is waiting for that have not decoded yet.
 *
 * The editor's first-view gate (`lib/editorFirstView.ts`) polls this while the
 * editor body is mounted under the loading screen: the lanes subscribe to
 * exactly the tiles their visible window needs, so "zero still loading" means
 * the strip will paint whole the moment it is revealed. An entry nobody
 * listens to any more (a lane that scrolled or re-zoomed past it) is not
 * waited for.
 */
export function loadingTileCount(): number {
  let n = 0
  for (const entry of decodedImages.values()) {
    if (entry.status === 'loading' && entry.listeners.size > 0) n++
  }
  return n
}

function forgetDecodedFilmstripImages(match: (url: string) => boolean): void {
  for (const [url, entry] of decodedImages) {
    if (!match(url)) continue
    entry.image.onload = null
    entry.image.onerror = null
    entry.image.src = ''
    decodedImages.delete(url)
  }
}
