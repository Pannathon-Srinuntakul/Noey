import { cn } from '../../lib/cn'

export interface SkeletonProps {
  /** `media` = the darker block for video/image placeholders; `text` blocks
   * alternate two opacities so a stack of lines reads as text, not stripes.
   * Never render a centred spinner instead of this — HANDOFF §3 Skeleton. */
  variant?: 'media' | 'text'
  /** Only used by `variant="text"` — alternates opacity per line automatically. */
  index?: number
  className?: string
  style?: React.CSSProperties
}

export function Skeleton({
  variant = 'text',
  index = 0,
  className,
  style
}: SkeletonProps): React.JSX.Element {
  const bg =
    variant === 'media'
      ? 'bg-[rgb(243_242_242_/_0.08)]'
      : index % 2 === 0
        ? 'bg-[rgb(243_242_242_/_0.10)]'
        : 'bg-[rgb(243_242_242_/_0.07)]'

  return <div className={cn('animate-pulse rounded-[3px]', bg, className)} style={style} />
}
