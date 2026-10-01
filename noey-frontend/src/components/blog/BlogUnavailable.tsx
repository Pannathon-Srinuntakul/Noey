import Link from "next/link";
import type { ReactNode } from "react";
import { StatusCard } from "@/components/ds/StatusCard";
import { BLOG_COPY } from "@/lib/blog";
import { PAGES } from "@/lib/site";

/**
 * The blog API did not answer and there is no earlier copy of this page to
 * show: say so calmly and offer a retry. Used by app/blog/error.tsx (run
 * time) and by a listing rendered during a build the API missed. Nothing
 * here needs the server, so the error boundary (a client component) can
 * render it too.
 */
export function BlogUnavailable({ retry, titleAs = "h2" }: { retry: ReactNode; titleAs?: "h1" | "h2" }) {
  return (
    <div className="blog-down">
      <StatusCard
        tone="danger"
        eyebrow={BLOG_COPY.label}
        title={BLOG_COPY.unavailableTitle}
        titleAs={titleAs}
        titleId="blog-down-title"
        role="status"
        actions={
          <>
            {retry}
            <Link href={PAGES.guide.path} className="btn btn-secondary">
              {BLOG_COPY.toGuide}
            </Link>
          </>
        }
      >
        <p>{BLOG_COPY.unavailableText}</p>
      </StatusCard>
    </div>
  );
}
