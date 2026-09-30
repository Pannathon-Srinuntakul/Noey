/**
 * The room's atmosphere, drawn once for the whole site: film grain and a
 * vignette (both token-coloured, so they follow the theme), the splice seam
 * used by page and theme transitions, and the playhead cursor that
 * MotionRuntime switches on for fine pointers. All decorative.
 */
export function Atmosphere() {
  return (
    <>
      <div className="vignette" aria-hidden="true" />
      <div className="grain" aria-hidden="true" />
      <div className="splice-seam" aria-hidden="true" />
      <div className="cursor" aria-hidden="true" data-hidden="" />
    </>
  );
}
