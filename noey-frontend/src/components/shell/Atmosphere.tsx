/**
 * The room's atmosphere, drawn once for the whole site: film grain and a
 * vignette (both token-coloured, so they follow the theme) and the splice
 * seam used by page and theme transitions. All decorative. The pointer is
 * always the system's own: a drawn cursor trails the real one.
 */
export function Atmosphere() {
  return (
    <>
      <div className="vignette" aria-hidden="true" />
      <div className="grain" aria-hidden="true" />
      <div className="splice-seam" aria-hidden="true" />
    </>
  );
}
