/**
 * The Noey "splice" mark (design logo/README.md). Inline SVG in currentColor.
 * Below ~28px the README's small version (stroke 15) keeps the strokes legible.
 * Never close the gap in the middle — it is the splice, not a mistake.
 *
 * `draw` gives every stroke a unit path length so CSS can draw the mark in
 * (`.mark-draw` in components.css); the geometry is untouched.
 */
export function NoeyMark({
  size = 24,
  className,
  title,
  draw = false,
  strokeWidth,
}: {
  size?: number | string;
  className?: string;
  /** Accessible name; omit for a decorative mark next to the wordmark. */
  title?: string;
  draw?: boolean;
  /** Override for very large decorative uses (the footer watermark). */
  strokeWidth?: number;
}) {
  const stroke = strokeWidth ?? (typeof size === "number" && size <= 28 ? 15 : 13);
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
      <path d="M22 78 V 22" pathLength={pathLength} />
      <path d="M22 22 L 44 55" pathLength={pathLength} />
      <path d="M56 45 L 78 78" pathLength={pathLength} />
      <path d="M78 78 V 22" pathLength={pathLength} />
    </svg>
  );
}
