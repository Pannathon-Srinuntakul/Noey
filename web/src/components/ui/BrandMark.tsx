/**
 * The Noey brand mark — an N cut through the middle. The gap in the diagonal IS
 * the logo (a "splice"); never close it, never fill it solid, never tilt it.
 *
 * Inline SVG rather than an `<img>`: the app's CSP is `img-src 'self'`, and
 * inline lets the mark take its colour from `currentColor`, so the nav rail,
 * the title bar and the login screen all use this one component.
 *
 * The stroke thickens below 28px because at small sizes a 13-unit stroke leaves
 * a splice gap too narrow to see — it reads as a solid blob. Do not collapse
 * these to one constant.
 */
export function BrandMark({
  size = 20,
  className
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={size < 28 ? 15 : 13}
      strokeLinecap="round"
      className={className}
      role="img"
      aria-label="Noey"
    >
      <path d="M22 78 V 22" />
      <path d="M22 22 L 44 55" />
      <path d="M56 45 L 78 78" />
      <path d="M78 78 V 22" />
    </svg>
  )
}
