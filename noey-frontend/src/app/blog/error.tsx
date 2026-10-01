"use client";

import { usePathname } from "next/navigation";
import { BlogUnavailable } from "@/components/blog/BlogUnavailable";
import { BLOG_COPY } from "@/lib/blog";
import "../../styles/pages/blog.css";

/**
 * The blog's boundary for an error nobody planned for (an API outage is not
 * one: the pages render their own "could not load" state, lib/server/blog.ts).
 * The same calm status card, with a retry — a plain link, so it also works
 * without JavaScript; with JavaScript it re-renders the segment in place.
 */
export default function BlogError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const pathname = usePathname();
  return (
    // The site's utility-page layout (status-page): the card centred on a timeline track.
    <main id="main" className="status-page page-top blog-page--down">
      <div className="wrap">
        <BlogUnavailable
          titleAs="h1"
          retry={
            <a
              href={pathname || "/blog"}
              className="btn btn-primary"
              onClick={(event) => {
                event.preventDefault();
                retry();
              }}
            >
              {BLOG_COPY.retry}
            </a>
          }
        />
      </div>
    </main>
  );
}
