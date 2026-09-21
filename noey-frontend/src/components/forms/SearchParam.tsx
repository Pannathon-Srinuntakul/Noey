"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, type ReactNode } from "react";

function Read({ name, render }: { name: string; render: (value: string | null) => ReactNode }) {
  return <>{render(useSearchParams().get(name))}</>;
}

/**
 * One query parameter on a STATIC page. Only this small subtree is rendered
 * on the client (the static HTML gets `render(null)`, same size, so no layout
 * shift). Next's `useSearchParams` is used rather than `window.location`
 * because after a client-side navigation (e.g. a Server Action redirecting to
 * /signup?plan=pro) the router renders the new page before it updates the
 * address bar — reading `location` there returns the previous URL.
 */
export function SearchParam({ name, render }: { name: string; render: (value: string | null) => ReactNode }) {
  return (
    <Suspense fallback={render(null)}>
      <Read name={name} render={render} />
    </Suspense>
  );
}
