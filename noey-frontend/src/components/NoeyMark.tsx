/**
 * The Noey "splice" mark (design logo/README.md). Inline SVG in currentColor.
 * Below 24px the README's small version (stroke 15) keeps the strokes legible;
 * from 24px up the regular stroke keeps the splice gap visible (with stroke 15
 * the two diagonals would all but touch at header size).
 * Never close the gap in the middle — it is the splice, not a mistake.
 *
 * `draw` gives every stroke a unit path length so CSS can draw the mark in
 * (`.mark-draw` in components.css); the geometry is untouched.
 *
 * `split` groups the two halves (the left stem with its diagonal, the right
 * diagonal with its stem) so CSS can move them apart and back to rest — the
 * loading mark (loading.css). Rest is the closest they ever come: the gap
 * stays open.
 */
export function NoeyMark({
  size = 24,
  className,
  title,
  draw = false,
  split = false,
  strokeWidth,
}: {
  size?: number | string;
  className?: string;
  /** Accessible name; omit for a decorative mark next to the wordmark. */
  title?: string;
  draw?: boolean;
  /** Group the two halves (`.mark-half--l`, `.mark-half--r`) for the loading motion. */
  split?: boolean;
  /** Override for very large decorative uses (the footer watermark). */
  strokeWidth?: number;
}) {
  const stroke = strokeWidth ?? (typeof size === "number" && size < 24 ? 15 : 13);
  const pathLength = draw ? 1 : undefined;
  const classes = [draw ? "mark-draw" : null, className].filter(Boolean).join(" ") || undefined;
  return (
    <svg
      className={classes}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {split ? (
        <>
          <g className="mark-half mark-half--l">
            <path d="M22 78 V 22" pathLength={pathLength} />
            <path d="M22 22 L 44 55" pathLength={pathLength} />
          </g>
          <g className="mark-half mark-half--r">
            <path d="M56 45 L 78 78" pathLength={pathLength} />
            <path d="M78 78 V 22" pathLength={pathLength} />
          </g>
        </>
      ) : (
        <>
          <path d="M22 78 V 22" pathLength={pathLength} />
          <path d="M22 22 L 44 55" pathLength={pathLength} />
          <path d="M56 45 L 78 78" pathLength={pathLength} />
          <path d="M78 78 V 22" pathLength={pathLength} />
        </>
      )}
    </svg>
  );
}
