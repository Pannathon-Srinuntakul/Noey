import Link from "next/link";
import type { ReactNode } from "react";
import { StatusCard } from "@/components/ds/StatusCard";
import { BLOG_COPY } from "@/lib/blog";
import { PAGES } from "@/lib/site";
import "../../styles/pages/blog.css";

/**
 * The blog API did not answer and this server has no earlier answer to show:
 * say so calmly and offer a retry (a plain link to the same page — the page
 * is tried again 30 s after it was drawn, lib/server/blog.ts). Server-safe
 * and client-safe: app/blog/error.tsx renders it too.
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

/** A whole page of it: a post the server could not load. */
export function BlogUnavailablePage({ path }: { path: string }) {
  return (
    <main id="main" className="blog-page blog-page--down">
      <div className="wrap page-top blog-down-page">
        <BlogUnavailable
          titleAs="h1"
          retry={
            <a href={path} className="btn btn-primary">
              {BLOG_COPY.retry}
            </a>
          }
        />
      </div>
    </main>
  );
}
