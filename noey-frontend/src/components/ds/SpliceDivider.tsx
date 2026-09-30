/**
 * A section divider cut like the logo: a hairline with a diagonal splice in
 * it, the two halves offset the way the mark's two strokes are. Draws itself
 * shut when it scrolls into view. Decorative.
 */
export function SpliceDivider({ label, className }: { label?: string; className?: string }) {
  return (
    <div className={["splice", className].filter(Boolean).join(" ")} aria-hidden="true" data-reveal="splice">
      <span className="splice__half splice__half--a" />
      <span className="splice__cut">
        <svg viewBox="0 0 40 24" width="40" height="24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <path d="M8 20 L 17 9" />
          <path d="M23 15 L 32 4" />
        </svg>
      </span>
      <span className="splice__half splice__half--b" />
      {label ? <span className="splice__label tc">{label}</span> : null}
    </div>
  );
}
