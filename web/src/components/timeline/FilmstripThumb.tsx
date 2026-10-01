import { cn } from '../../lib/cn'
import { useFilmstripImage } from '../../lib/useFilmstripImage'

/**
 * One filmstrip tile as an `<img>`: a neutral placeholder while it decodes,
 * then the picture fading in — never a black box. The decode goes through the
 * shared tile cache, so it counts toward the editor's first-view gate. A tile
 * that failed, or no tile at all, leaves the placeholder's quiet surface.
 */
export function FilmstripThumb({ url }: { url: string | null }): React.JSX.Element {
  const state = useFilmstripImage(url)
  return (
    <span className="relative block h-full w-full bg-[rgb(243_242_242_/_0.08)]">
      {state === 'loading' ? (
        <span aria-hidden className="absolute inset-0 animate-pulse bg-[rgb(243_242_242_/_0.06)]" />
      ) : null}
      {url && state === 'ready' ? (
        <img
          src={url}
          alt=""
          draggable={false}
          className={cn(
            'pointer-events-none absolute inset-0 h-full w-full object-cover',
            'transition-opacity duration-200 ease-out starting:opacity-0 motion-reduce:transition-none'
          )}
        />
      ) : null}
    </span>
  )
}
