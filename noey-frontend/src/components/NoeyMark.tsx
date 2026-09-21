/**
 * The Noey "splice" mark (design logo/README.md). Inline SVG in currentColor.
 * Below ~24px the README's small version (stroke 15) keeps the strokes legible.
 * Never close the gap in the middle — it is the splice, not a mistake.
 */
export function NoeyMark({
  size = 24,
  className,
  title,
}: {
  size?: number;
  className?: string;
  /** Accessible name; omit for a decorative mark next to the wordmark. */
  title?: string;
}) {
  const strokeWidth = size <= 28 ? 15 : 13;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <path d="M22 78 V 22" />
      <path d="M22 22 L 44 55" />
      <path d="M56 45 L 78 78" />
      <path d="M78 78 V 22" />
    </svg>
  );
}
