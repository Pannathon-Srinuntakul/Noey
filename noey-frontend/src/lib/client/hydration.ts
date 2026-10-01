/** True once React has hydrated (or rendered) `element`: it keeps its fibre on it. */
function claimed(element: Element): boolean {
  return Object.keys(element).some((key) => key.startsWith("__reactFiber$"));
}

/**
 * Runs `run` once React has hydrated every element matching `selector` — the
 * elements the caller is about to write into.
 *
 * A page under a loading boundary (the account's, verification, checkout)
 * is hydrated by React last, at its lowest priority, when its boundary
 * arrived complete from the server — after the layout's effects have run. The
 * layout's page scripts (MotionRuntime's reveals and count-ups, the header
 * ruler's section stamps) write into the page's DOM; done before React has
 * claimed that DOM, a changed attribute or text is a hydration mismatch, and
 * React throws the server's HTML away. So they wait for it.
 *
 * React keeps its fibre on each element it has hydrated, under a key that
 * starts with `__reactFiber$` (React 17–19). That is internal, so the wait is
 * bounded: after `limitMs` the work runs anyway, as it always did. Content
 * rendered on the client (any navigation) has its fibres from the start, so
 * this usually runs at once. Returns a cancel function.
 */
export function whenHydrated(selector: string, run: () => void, limitMs = 2500): () => void {
  const started = performance.now();
  let frame = 0;
  const check = () => {
    frame = 0;
    const waiting = [...document.querySelectorAll(selector)].some((element) => !claimed(element));
    if (!waiting || performance.now() - started > limitMs) run();
    else frame = window.requestAnimationFrame(check);
  };
  check();
  return () => {
    if (frame) window.cancelAnimationFrame(frame);
  };
}
