/**
 * Whether the page on screen is the 404 page, for the header's menu (no link
 * is "current" on a 404).
 *
 * The header can tell most 404s from Next's route tree, but not one that a
 * page raises itself with notFound() (the blog's backstop while its API is
 * slow or down): there the tree is the page's own route. So the 404 page
 * marks itself here while it is on screen (NotFoundMark) and the header
 * listens. A tiny store, read with useSyncExternalStore: the server and the
 * hydrating browser both read "no", so there is never a mismatch; the mark
 * lands right after, before the browser paints.
 */
let marks = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeNotFound(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isNotFoundMarked(): boolean {
  return marks > 0;
}

/** The server and a hydrating browser never see a mark. */
export function notFoundServerSnapshot(): boolean {
  return false;
}

/** Mark the 404 page as on screen; returns the unmark. */
export function markNotFound(): () => void {
  marks += 1;
  emit();
  return () => {
    marks -= 1;
    emit();
  };
}
