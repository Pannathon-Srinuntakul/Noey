/**
 * Whether one filmstrip tile has decoded — for the `<img>` thumbnails (phone
 * storyboard, the inspector's angle picker) that sit beside the canvas lanes.
 *
 * Going through the shared decode cache does two things: the thumbnail can
 * hold a neutral placeholder and fade in rather than flash a black box, and
 * the tile counts toward the editor's first-view gate (`loadingTileCount`),
 * so a thumbnail on screen when the editor opens is decoded before it shows.
 * The `<img>` that follows reuses the decoded image from the document's
 * image cache instead of fetching it again.
 */
import { useEffect, useState } from 'react'
import { getDecodedFilmstripImage, subscribeFilmstripImage } from './filmstripImageCache'

export type FilmstripImageState = 'loading' | 'ready' | 'error'

export function useFilmstripImage(url: string | null): FilmstripImageState {
  // Keyed by URL so a thumbnail that changes tile starts over as 'loading'
  // without a reset inside the effect.
  const [settled, setSettled] = useState<{ url: string; ok: boolean } | null>(null)

  useEffect(() => {
    if (!url) return
    return subscribeFilmstripImage(
      url,
      () => setSettled({ url, ok: true }),
      () => setSettled({ url, ok: false })
    )
  }, [url])

  if (!url) return 'error'
  if (settled?.url === url) return settled.ok ? 'ready' : 'error'
  // Already decoded by a lane or an earlier mount: no placeholder frame.
  return getDecodedFilmstripImage(url) ? 'ready' : 'loading'
}
